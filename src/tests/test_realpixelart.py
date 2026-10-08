"""Regression tests for pixel recovery, CLI, and comparison input handling."""
from __future__ import annotations

import io
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image, ImageFilter

from realpixelart import Config, pixelize, save_result, export_png
from realpixelart.grid import extract_features, axis_segment_evidence, detect_grid, make_lines
from realpixelart.tools import load_image, to_pil
from realpixelart.sampling import recover_cells, quantize_cells
from realpixelart import process_colors, palette_catalog
from realpixelart.config import PALETTE_IDS
from realpixelart.sampling import palette_rgb, rgb_to_lab, delta_e_2000, nearest


def test_no_semitransparent_is_reversible_postprocessing():
    rows = np.array([[[20, 40, 60, a] for a in (0, 1, 127, 128, 191, 192, 254, 255)]], dtype=np.uint8)
    image = Image.fromarray(rows)
    result = process_colors(image, no_semitransparent=True)
    expected = rows.copy()
    expected[..., 3] = np.where(expected[..., 3] >= 192, 255, 0)
    expected[expected[..., 3] == 0] = 0
    np.testing.assert_array_equal(result.image, expected)
    np.testing.assert_array_equal(image, rows)
    np.testing.assert_array_equal(process_colors(image, no_semitransparent=False).image, rows)
    np.testing.assert_array_equal(process_colors(result.image, no_semitransparent=True).image, expected)
    assert result.diagnostics['output_colors'] == 1
    for invalid in (1, 'false', None):
        with pytest.raises(ValueError, match='boolean'):
            Config(no_semitransparent=invalid)
        with pytest.raises(ValueError, match='boolean'):
            process_colors(image, no_semitransparent=invalid)


def test_no_semitransparent_excludes_discarded_palette_votes():
    image = Image.fromarray(np.array([[[255, 0, 0, 191]] * 20 + [[0, 0, 255, 192]]], dtype=np.uint8))
    for mode in ('rgb', 'natural'):
        colored = process_colors(image, colors=1, color_mode=mode, no_semitransparent=True)
        np.testing.assert_array_equal(np.asarray(colored.image)[0, -1], [0, 0, 255, 255])
        assert colored.diagnostics['input_colors'] == 1
        colored = process_colors(image, colors=2, palette='MARD24', color_mode=mode, no_semitransparent=True)
        assert set(np.asarray(colored.image)[..., 3].flat) <= {0, 255}
    blank = process_colors(Image.new('RGBA', (2, 2), (255, 0, 0, 127)), no_semitransparent=True)
    assert blank.diagnostics['output_colors'] == 0
    rgb = Image.new('RGB', (2, 2), (20, 40, 60))
    assert process_colors(rgb, no_semitransparent=True).image.tobytes() == rgb.tobytes()


def test_no_semitransparent_preserves_grid_and_sampling():
    image = Image.fromarray(np.array([[[i * 15, 90, 160, i * 17] for i in range(16)]], dtype=np.uint8))
    normal = pixelize(image, Config(photo_mode='off'))
    binary = pixelize(image, Config(photo_mode='off', no_semitransparent=True))
    assert binary.grid == normal.grid
    np.testing.assert_array_equal(binary.native_image, normal.native_image)
    np.testing.assert_array_equal(binary.image, process_colors(normal.native_image, no_semitransparent=True).image)


def test_core_modules_have_one_way_dependencies():
    """Merged modules must not regain reverse imports, including delayed ones."""
    import ast

    package = Path(__file__).resolve().parents[1] / "realpixelart"
    modules = {path.stem: path for path in package.glob("*.py")}
    assert set(modules) == {
        "__init__", "__main__", "config", "pipeline", "grid", "sampling", "tools",
    }
    allowed = {
        "config": set(),
        "grid": {"config"},
        "tools": {"config"},
        "sampling": {"config", "tools"},
        "pipeline": {"config", "grid", "sampling", "tools"},
        "__init__": {"config", "pipeline", "sampling", "tools"},
        "__main__": {"config", "pipeline", "tools"},
    }
    dependencies = {}
    for name, path in modules.items():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    assert node.level == 1 and node.module is not None
                    imports.add(node.module.split(".")[0])
                elif node.module and node.module.startswith("realpixelart."):
                    imports.add(node.module.split(".")[1])
            elif isinstance(node, ast.Import):
                imports.update(alias.name.split(".")[1] for alias in node.names
                               if alias.name.startswith("realpixelart."))
        assert imports <= allowed[name], (name, imports - allowed[name])
        dependencies[name] = imports

    def visit(name, ancestors):
        assert name not in ancestors, " -> ".join((*ancestors, name))
        for dependency in dependencies[name]:
            visit(dependency, (*ancestors, name))

    for name in dependencies:
        visit(name, ())


@pytest.mark.parametrize('shape', [(1, 1), (65, 127), (130, 134)])
def test_striped_features_match_full_resolution_reference(shape):
    # Include both sides of 64-row boundaries and odd/even FFT dimensions.
    rgba = np.random.default_rng(73).random((*shape, 4), dtype=np.float32)
    expected_x = np.zeros(shape, np.float32)
    expected_y = np.zeros(shape, np.float32)
    gray = np.zeros(shape, np.float32)
    for c, weight in enumerate((.299, .587, .114, 0.)):
        values = rgba[..., c] * rgba[..., 3] if c < 3 else rgba[..., 3]
        expected_x[:, 1:] = np.maximum(expected_x[:, 1:], np.abs(np.diff(values, axis=1)))
        expected_y[1:] = np.maximum(expected_y[1:], np.abs(np.diff(values, axis=0)))
        gray += weight * values
    gray += .5 * (1 - rgba[..., 3])
    actual = extract_features(rgba)
    np.testing.assert_array_equal(actual.gradient_x, expected_x)
    np.testing.assert_array_equal(actual.gradient_y, expected_y)
    spectrum = np.log1p(abs(np.fft.rfft2(gray))).astype(np.float32)
    np.testing.assert_array_equal(actual.spectrum, spectrum)
    np.testing.assert_array_equal(actual.spectral_x, spectrum[1:].mean(axis=0) if shape[0] > 1 else spectrum[0])
    sy = spectrum[:, 1:].mean(axis=1) if shape[1] > 1 else spectrum[:, 0]
    np.testing.assert_array_equal(actual.spectral_y, sy[:shape[0] // 2 + 1])


@pytest.mark.parametrize('shape', [(1, 1), (65, 127), (130, 134)])
def test_fft_thumbnail_coordinates_match_full_fft(shape):
    from realpixelart.tools import _fft_preview, _preview_axes
    gray = np.random.default_rng(18).random(shape)
    half = np.log1p(abs(np.fft.rfft2(gray))).astype(np.float32)
    expected = np.fft.fftshift(np.log1p(abs(np.fft.fft2(gray)))).astype(np.float32)
    x, y = _preview_axes(shape[1], shape[0], limit=37)
    np.testing.assert_allclose(_fft_preview(half, shape[1], limit=37), expected[np.ix_(y, x)], atol=1e-6)


def test_jpg_with_mpo_primary_photo_and_caller_frame(tmp_path):
    path = tmp_path / 'camera.jpg'  # A JPEG extension does not imply one picture.
    primary = Image.new('RGB', (73, 65), '#327cbe')
    primary.save(path, format='MPO', save_all=True, append_images=[Image.new('RGB', (32, 20), 'red')])
    with Image.open(path) as opened:
        assert opened.format == 'MPO' and opened.n_frames == 2
        expected = np.asarray(opened.convert('RGBA'), dtype=np.float32) / 255
        opened.seek(1)
        data = load_image(opened)
        assert opened.tell() == 1
        assert data.metadata == dict(format='MPO', frames=2, selected_frame=0, selection='declared MP primary image')
    np.testing.assert_array_equal(data.rgba, expected)
    np.testing.assert_array_equal(load_image(path).rgba, expected)
    result = pixelize(path)
    assert result.grid['input_size'] == [73, 65]
    assert any('MPO photo:' in warning for warning in result.diagnostics['warnings'])
    # Honor a unique declared primary, including when it isn't the first frame.
    with Image.open(path) as opened:
        opened.mpinfo[0xB002][0]['Attribute']['MPType'] = 'Undefined'
        opened.mpinfo[0xB002][1]['Attribute']['MPType'] = 'Baseline MP Primary Image'
        assert load_image(opened).rgba.shape == (20, 32, 4)
        assert opened.tell() == 0
        opened.mpinfo[0xB002][1]['Attribute']['MPType'] = 'Undefined'
        assert load_image(opened).metadata['selection'] == 'first MPO image'


@pytest.mark.parametrize('format', ['GIF', 'PNG', 'TIFF'])
def test_other_multiframe_formats_still_rejected(tmp_path, format):
    path = tmp_path / 'frames.bin'
    Image.new('RGB', (12, 10), 'red').save(path, format=format, save_all=True,
                                          append_images=[Image.new('RGB', (12, 10), 'blue')])
    with pytest.raises(ValueError, match=f'format={format}, frames=2'):
        load_image(path)


@pytest.mark.parametrize('mode', ['RGB', 'RGBA', 'P', 'L', 'CMYK'])
def test_striped_image_conversion_matches_pillow(mode):
    pixels = np.random.default_rng(44).integers(0, 256, (137, 79, 4), dtype=np.uint8)
    image = Image.fromarray(pixels).convert(mode)
    if mode == 'P':
        image.info['transparency'] = 0
    expected = np.array(image.convert('RGBA'), dtype=np.float32) / 255
    expected[expected[..., 3] == 0, :3] = 0
    data = load_image(image)
    np.testing.assert_array_equal(data.rgba, expected)
    np.testing.assert_array_equal(to_pil(data.rgba), np.rint(expected * 255).astype(np.uint8))
    # Reading must leave the externally owned image usable.
    assert image.getpixel((0, 0)) is not None


@pytest.mark.parametrize('alpha_mode', ['auto', 'binary', 'coverage'])
def test_full_size_fallback_keeps_original_and_does_not_mutate_input(alpha_mode):
    image = np.full((67, 71, 4), [28, 70, 138, 75], np.uint8)
    original = image.copy()
    result = pixelize(image, Config(alpha_mode=alpha_mode, photo_mode='off'))
    assert result.grid['fallback']
    np.testing.assert_array_equal(image, original)
    np.testing.assert_array_equal(result.debug_data['source'], original)
    np.testing.assert_array_equal(result.image, np.zeros_like(original) if alpha_mode == 'binary' else original)


# Pixel hashes independently reproduced with pre-color revision d225caa.
# Protect the original detector and sampler when changing optional color features.
@pytest.mark.parametrize('name,size,digest', [
    ('bocchi.png', (131, 198), '5569099de36d9fe3d6a2b5b45490e56b2fd5034538f1e2e0cf89d2060a2bb709'),
    ('bocchi2.png', (125, 93), '2297be6439f66b988ec8f477e8a8ea67fc9041d205e7401e31e1e240e61a4357'),
    ('chito.png', (111, 166), 'efe30fa335a23edb46d06c1f6b456f6f8cacfa1111c8a58d5b58bafbfa0f4481'),
    ('hollow-knight-sprite.png', (70, 73), '27ddbc261a1e0d3ebcead22de08ce52093ca5583f3b19caf7ebaeb2e96f75384'),
    ('lastTour.png', (331, 219), '79e8a80e54ab2bafe654340d9e8f677b360447d621359826034c085ba2fcaed9'),
    ('ritsu.png', (156, 232), '9c319fbad9cf76587f85bd7b91c96ec2b8a74d8c391f636b51338e55e3d62767'),
])
def test_default_recovery_preserves_pre_color_pixels(name, size, digest):
    import hashlib
    source = Path(__file__).resolve().parents[2] / 'input' / name
    result = pixelize(source)
    assert result.image.size == size
    assert hashlib.sha256(result.image.convert('RGBA').tobytes()).hexdigest() == digest
    np.testing.assert_array_equal(result.native_image, result.image)


# OPTIONAL COLOR POSTPROCESSING
# All 34 reference pairs published by Sharma, Wu & Dalal, including hue wrap cases.
# https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
CIEDE_REFERENCE = np.loadtxt(io.StringIO('''
50 2.6772 -79.7751 50 0 -82.7485 2.0425
50 3.1571 -77.2803 50 0 -82.7485 2.8615
50 2.8361 -74.0200 50 0 -82.7485 3.4412
50 -1.3802 -84.2814 50 0 -82.7485 1.0000
50 -1.1848 -84.8006 50 0 -82.7485 1.0000
50 -0.9009 -85.5211 50 0 -82.7485 1.0000
50 0 0 50 -1 2 2.3669
50 -1 2 50 0 0 2.3669
50 2.4900 -0.0010 50 -2.4900 0.0009 7.1792
50 2.4900 -0.0010 50 -2.4900 0.0010 7.1792
50 2.4900 -0.0010 50 -2.4900 0.0011 7.2195
50 2.4900 -0.0010 50 -2.4900 0.0012 7.2195
50 -0.0010 2.4900 50 0.0009 -2.4900 4.8045
50 -0.0010 2.4900 50 0.0010 -2.4900 4.8045
50 -0.0010 2.4900 50 0.0011 -2.4900 4.7461
50 2.5000 0 50 0 -2.5000 4.3065
50 2.5000 0 73 25 -18 27.1492
50 2.5000 0 61 -5 29 22.8977
50 2.5000 0 56 -27 -3 31.9030
50 2.5000 0 58 24 15 19.4535
50 2.5000 0 50 3.1736 0.5854 1.0000
50 2.5000 0 50 3.2972 0 1.0000
50 2.5000 0 50 1.8634 0.5757 1.0000
50 2.5000 0 50 3.2592 0.3350 1.0000
60.2574 -34.0099 36.2677 60.4626 -34.1751 39.4387 1.2644
63.0109 -31.0961 -5.8663 62.8187 -29.7946 -4.0864 1.2630
61.2901 3.7196 -5.3901 61.4292 2.2480 -4.9620 1.8731
35.0831 -44.1164 3.7933 35.0232 -40.0716 1.5901 1.8645
22.7233 20.0904 -46.6940 23.0331 14.9730 -42.5619 2.0373
36.4612 47.8580 18.3852 36.2715 50.5065 21.2231 1.4146
90.8027 -2.0831 1.4410 91.1528 -1.6435 0.0447 1.4441
90.9257 -0.5406 -0.9208 88.6381 -0.8985 -0.7239 1.5381
6.7747 -0.2908 -2.4247 5.8714 -0.0985 -2.2286 0.6377
2.0776 0.0795 -1.1350 0.9033 -0.0636 -0.5514 0.9082
'''))


@pytest.mark.parametrize('pair', CIEDE_REFERENCE)
def test_ciede2000_reference(pair):
    assert delta_e_2000(pair[:3], pair[3:6]) == pytest.approx(pair[6], abs=5e-5)
    assert delta_e_2000(pair[3:6], pair[:3]) == pytest.approx(pair[6], abs=5e-5)


def test_lab_primaries_and_global_rgb_match():
    np.testing.assert_allclose(rgb_to_lab([[0, 0, 0], [255, 255, 255], [255, 0, 0]]),
                               [[0, 0, 0], [100, 0, 0], [53.2408, 80.0925, 67.2032]], atol=1e-3)
    palette = np.array([[0, 0, 0], [0, 1, 0], [0, 0, 1], [32, 15, 15]], float)
    assert nearest(np.array([[15, 15, 15]], float), palette, 'rgb')[0] == 3
    target = np.array([[64, 64, 32]], float)
    palette = np.array([[176, 64, 64], [128, 96, 96], [128, 128, 64], [64, 128, 128]], float)
    assert nearest(target, palette, 'rgb')[0] == 1
    assert nearest(rgb_to_lab(target), rgb_to_lab(palette), 'natural')[0] == 2


def test_library_catalog_actual_counts():
    catalog = palette_catalog()
    assert [p['id'] for p in catalog] == list(PALETTE_IDS)
    assert [p['entries'] for p in catalog] == [436, 24, 48, 72, 96, 120, 144, 221, 275]
    assert catalog[-1]['name'] == 'MARD-280色'
    assert catalog[-1]['nominal_size'] == 280
    assert Config().colors is None and Config().palette is None


@pytest.mark.parametrize('palette', PALETTE_IDS)
@pytest.mark.parametrize('mode', ['rgb', 'natural'])
def test_bead_matching_and_limiting_stay_in_library(palette, mode):
    rgb = palette_rgb(palette)
    # Exact bead swatches must survive unrestricted matching, including >256 colors.
    source = Image.fromarray(rgb[None])
    unlimited = process_colors(source, palette=palette, color_mode=mode)
    np.testing.assert_array_equal(unlimited.image, source)
    rgba = np.concatenate([rgb, np.full((len(rgb), 1), 255, np.uint8)], axis=1)[None]
    rgba[:, :4, 3] = [0, 1, 127, 254]
    first = process_colors(Image.fromarray(rgba), colors=8, palette=palette, color_mode=mode)
    second = process_colors(Image.fromarray(rgba), colors=8, palette=palette, color_mode=mode)
    actual = np.array(first.image)
    np.testing.assert_array_equal(actual, second.image)
    np.testing.assert_array_equal(actual[..., 3], rgba[..., 3])
    visible = actual[actual[..., 3] > 0, :3]
    assert len(np.unique(visible, axis=0)) <= 8
    assert set(map(tuple, visible)).issubset(set(map(tuple, rgb)))


@pytest.mark.parametrize('mode', ['rgb', 'natural'])
def test_unlimited_is_reversible_and_hidden_rgb_cannot_vote(mode):
    rng = np.random.default_rng(313)
    rgba = rng.integers(0, 256, (20, 20, 4), dtype=np.uint8)
    rgba[:5, :, 3] = 0
    source = Image.fromarray(rgba)
    np.testing.assert_array_equal(process_colors(source).image, source)
    alternate = rgba.copy(); alternate[:5, :, :3] = [255, 0, 0]
    for palette in [None, 'DMC436']:
        a = process_colors(source, colors=8, palette=palette, color_mode=mode)
        b = process_colors(Image.fromarray(alternate), colors=8, palette=palette, color_mode=mode)
        np.testing.assert_array_equal(a.image, b.image)
        np.testing.assert_array_equal(np.array(a.image)[..., 3], rgba[..., 3])
    np.testing.assert_array_equal(process_colors(source).image, source)


def test_color_postprocessing_never_detects_grid(monkeypatch):
    import realpixelart.pipeline as pipeline
    def fail(*args, **kwargs):
        raise AssertionError('Grid detection must not run during color postprocessing')
    result = pixelize(enlarged(truth_image(rgba=True)))
    monkeypatch.setattr(pipeline, 'detect_grid', fail)
    expected = process_colors(result.native_image, colors=5, palette='MARD24')
    assert expected.image.size == result.image.size
    np.testing.assert_array_equal(process_colors(result.native_image).image, result.image)


def test_pipeline_color_layer_matches_standalone_and_grid():
    source = enlarged(truth_image(rgba=True))
    base = pixelize(source)
    colored = pixelize(source, Config(colors=5, palette='MARD24', color_mode='rgb'))
    assert colored.grid == base.grid
    np.testing.assert_array_equal(colored.native_image, base.image)
    expected = process_colors(base.image, colors=5, palette='MARD24', color_mode='rgb')
    np.testing.assert_array_equal(colored.image, expected.image)


@pytest.mark.parametrize('kwargs', [{'palette': 'UNKNOWN'}, {'color_mode': 'lab'}, {'colors': 513}, {'colors': True}])
def test_invalid_color_options(kwargs):
    with pytest.raises(ValueError):
        Config(**kwargs)
    with pytest.raises(ValueError):
        process_colors(Image.new('RGB', (1, 1)), **kwargs)


def test_transparent_and_large_color_budgets():
    for colors in [1, 257, 436, 437, 512]:
        Config(colors=colors)
        result = process_colors(Image.new('RGBA', (4, 3), (255, 40, 20, 0)), colors=colors, palette='DMC436')
        assert result.diagnostics['output_colors'] == 0
        assert not np.any(result.image)


def test_512_color_limit_preserves_alpha_and_dimensions():
    indices = np.arange(600)
    rgba = np.column_stack((indices % 256, (indices // 256) * 80,
                            (indices * 31) % 256, 128 + indices % 128)).astype(np.uint8).reshape(24, 25, 4)
    source = Image.fromarray(rgba)
    assert len(np.unique(rgba[..., :3].reshape(-1, 3), axis=0)) > 512
    result = process_colors(source, colors=512, color_mode='rgb')
    assert result.image.size == source.size
    assert 1 < result.diagnostics['output_colors'] <= 512
    np.testing.assert_array_equal(np.array(result.image)[..., 3], rgba[..., 3])
    np.testing.assert_array_equal(process_colors(source).image, source)


def test_cli_default_library_and_color_options(tmp_path):
    source = tmp_path / 'input.png'; make_input(source)
    output = tmp_path / 'result.png'
    completed = invoke('-i', source, '-o', output, '--palette', '--colors', '8', '--color-mode', 'rgb', cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert 'palette=DMC436' in completed.stdout
    visible = np.array(Image.open(output)).reshape(-1, 3)
    assert len(np.unique(visible, axis=0)) <= 8
    assert set(map(tuple, visible)).issubset(set(map(tuple, palette_rgb('DMC436'))))
    assert {p.name for p in tmp_path.iterdir()} == {'input.png', 'result.png'}


# COMPARISON INPUT HANDLING
def test_white_input_ignores_hidden_rgb_and_blends_partial_alpha(tmp_path):
    from compare_programs import white_input

    rgba = np.array([[[240, 20, 180, 0], [20, 40, 60, 128],
                      [10, 30, 50, 255]]], dtype=np.uint8)
    path = tmp_path / "rgba.png"
    Image.fromarray(rgba).save(path)
    prepared = white_input(path)
    expected = np.array([[[255, 255, 255], [137, 147, 157], [10, 30, 50]]], dtype=np.uint8)
    assert prepared.mode == "RGB"
    np.testing.assert_array_equal(np.array(prepared), expected)
    rgba[0, 0, :3] = [0, 255, 0]
    Image.fromarray(rgba).save(path)
    np.testing.assert_array_equal(np.array(white_input(path)), expected)


def test_white_input_preserves_opaque_rgb(tmp_path):
    from compare_programs import white_input

    path = tmp_path / "rgb.png"
    rgb = np.array([[[0, 0, 0], [255, 0, 0]], [[20, 40, 60], [255, 255, 255]]], dtype=np.uint8)
    Image.fromarray(rgb).save(path)
    np.testing.assert_array_equal(np.array(white_input(path)), rgb)


def test_comparison_passes_same_white_pixels_to_main_and_real_plus_cli(tmp_path, monkeypatch):
    import hashlib
    import compare_programs as comparison

    path = tmp_path / "source.png"
    rgba = np.zeros((8, 8, 4), dtype=np.uint8)
    rgba[..., :3] = [220, 50, 180]  # Hidden RGB must not reach either algorithm.
    rgba[2:6, 2:6] = [15, 40, 75, 255]
    Image.fromarray(rgba).save(path)
    original_bytes = path.read_bytes()
    expected = np.array(comparison.white_input(path))
    calls = []

    def main_spy(rgb):
        np.testing.assert_array_equal(rgb, expected)
        calls.append("main")
        return rgb.shape[1], rgb.shape[0], rgb

    real_run = comparison.subprocess.run

    def inspect_then_run(command, **kwargs):
        with Image.open(command[command.index("-i") + 1]) as image:
            assert image.mode == "RGB"
            np.testing.assert_array_equal(np.array(image), expected)
        assert command[2::2] == ["-i", "-o"]  # No grid or sampling overrides.
        calls.append("realpixelart")
        return real_run(command, **kwargs)

    monkeypatch.setattr(comparison.subprocess, "run", inspect_then_run)
    _, _, real_image, record = comparison.run_pair(path, tmp_path / "results", main_spy)
    assert calls == ["main", "realpixelart"]
    assert record["realpixelart"]["returncode"] == 0
    assert real_image is not None
    assert record["shared_input"]["sha256_rgb"] == hashlib.sha256(expected.tobytes()).hexdigest()
    assert path.read_bytes() == original_bytes


# GRID
def random_grid(width=12, height=10, spacing=8, seed=7):
    truth = np.ones((height, width, 4), np.float32)
    truth[..., :3] = np.random.default_rng(seed).uniform(.05, .95, (height, width, 3))
    return truth.repeat(spacing,0).repeat(spacing,1), truth


def detect(image, config=None):
    return detect_grid(extract_features(image), image.shape, config or Config())


def test_clean_grid_and_harmonics():
    image,_ = random_grid()
    grid, report = detect(image, Config(local_warp="off"))
    assert (grid.sx,grid.sy,grid.phase_x,grid.phase_y) == (8.,8.,0.,0.)
    assert (len(grid.x_lines)-1,len(grid.y_lines)-1) == (12,10)
    spacings=[c["spacing"] for c in report["candidates"]]
    assert [4.,4.] in spacings and [16.,16.] in spacings
    assert len(report["refined"]) <= 3


def test_shifted_crop_recovers_phase_and_covers_input():
    image,_ = random_grid(16,14)
    image=image[5:-2,3:-1]
    grid,_=detect(image)
    assert abs(grid.sx-8)<.05 and abs(grid.sy-8)<.05
    assert abs(grid.phase_x-5)<.15 and abs(grid.phase_y-3)<.15
    assert grid.x_lines[0] == grid.y_lines[0] == 0
    assert grid.x_lines[-1] == image.shape[1] and grid.y_lines[-1] == image.shape[0]
    assert np.all(np.diff(grid.x_lines)>0) and np.all(np.diff(grid.y_lines)>0)


def test_partial_fragments_have_consistent_rule():
    np.testing.assert_array_equal(make_lines(18,8,1),[0,9,18])
    np.testing.assert_array_equal(make_lines(18,8,2),[0,2,10,18])
    np.testing.assert_array_equal(make_lines(17,8,0),[0,8,17])


def test_automatic_phase_shift_adds_partial_edge_cells():
    image,_=random_grid()
    image=np.roll(image,2,axis=1)
    grid,_=detect(image)
    assert len(grid.x_lines)==14 and len(grid.y_lines)==11
    assert grid.phase_x == pytest.approx(2.)
    assert grid.x_lines[0]==0 and grid.x_lines[-1]==image.shape[1]
    assert np.all(np.diff(grid.x_lines)>0)


def test_alpha_hidden_rgb_cannot_create_edges_or_fft_evidence():
    image,_=random_grid()
    image[:,:32,3]=0
    other=image.copy()
    other[:,:32,:3]=np.random.default_rng(31).random(other[:,:32,:3].shape)
    a,b=extract_features(image),extract_features(other)
    np.testing.assert_array_equal(a.gradient_x,b.gradient_x)
    np.testing.assert_array_equal(a.gradient_y,b.gradient_y)
    np.testing.assert_array_equal(a.spectrum,b.spectrum)


def test_equal_luminance_colour_edges_remain_visible():
    image=np.ones((32,64,4),np.float32)
    image[...,:3]=[1,0,0]
    image[:,32:,:3]=[0,.299/.587,0]
    assert extract_features(image).gradient_x[:,32].mean()>.3


def test_flat_and_transparent_images_have_no_automatic_grid():
    for image in (np.ones((64,64,4),np.float32),np.zeros((64,64,4),np.float32)):
        assert detect(image)[0] is None


def test_missing_same_colour_boundaries_still_find_base_scale():
    _,truth=random_grid(18,16)
    truth[2:7,2:12,:3]=truth[2,2,:3]
    grid,_=detect(truth.repeat(8,0).repeat(8,1))
    assert grid.sx==8 and grid.sy==8


def test_local_walk_recovers_bounded_drift_without_crossing():
    _,truth=random_grid(16,14)
    widths=np.tile([8,9,8,7],4)
    heights=np.tile([8,9,8,7],4)[:14]
    image=np.repeat(np.repeat(truth,heights,0),widths,1)
    grid,_=detect(image)
    assert grid.warped
    np.testing.assert_allclose(grid.x_lines,np.r_[0,np.cumsum(widths)])
    np.testing.assert_allclose(grid.y_lines,np.r_[0,np.cumsum(heights)])
    assert np.all(np.diff(grid.x_lines)>0)


@pytest.mark.parametrize("removed", [{"pixel_size": 8}, {"target_size": (12, 10)}])
def test_manual_grid_options_are_removed_from_api(removed):
    with pytest.raises(TypeError, match="unexpected keyword"):
        Config(**removed)


def test_noninteger_automatic_spacing_with_raster_rounding():
    _,truth=random_grid(22,18)
    sx,sy=7.3,7.8
    xi=np.minimum((np.arange(round(22*sx))/sx).astype(int),21)
    yi=np.minimum((np.arange(round(18*sy))/sy).astype(int),17)
    image=truth[yi[:,None],xi[None,:]]
    grid,_=detect(image)
    assert abs(grid.sx-sx)<.06 and abs(grid.sy-sy)<.06
    assert len(grid.x_lines)==23 and len(grid.y_lines)==19


def test_unstructured_noise_and_smooth_ramp_do_not_establish_grid():
    rng=np.random.default_rng(919)
    noise=np.ones((96,96,4),np.float32)
    noise[...,:3]=rng.random((96,96,3))
    flat=noise.copy(); flat[...,:3]=np.clip(rng.normal(.5,.025,(96,96,3)),0,1)
    ramp=np.ones_like(noise)
    ramp[...,:3]=((np.arange(96)[:,None]+np.arange(96)[None,:])/190)[...,None]
    for image in (noise,flat,ramp):
        assert detect(image)[0] is None


def test_noise_rejection_searches_all_proposals_without_chance_grid():
    for seed in range(10):
        image=np.ones((96,96,4),np.float32)
        image[...,:3]=np.random.default_rng(seed).random((96,96,3))
        assert detect(image)[0] is None


@pytest.mark.parametrize('variant', ['original', 'flip', 'crop', 'slight_blur'])
def test_irregular_anime_grid_is_recovered_before_photo_fallback(variant):
    # Real reported failure: visible pixel steps have varying width/phase.
    # This file has a .jpg name but PNG contents; no JPEG decoder differences.
    source = Path(__file__).resolve().parents[2] / 'input/1770467992323.jpg'
    with Image.open(source) as opened:
        assert opened.format == 'PNG'
        image = opened.copy()
    if variant == 'flip':
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif variant == 'crop':
        image = image.crop((3, 5, 1021, 1022))
    elif variant == 'slight_blur':
        image = image.filter(ImageFilter.GaussianBlur(.35))
    result = pixelize(image)
    assert not result.grid['stylized'] and not result.grid['fallback']
    assert not result.grid['native_preserved']
    # No exact ground-truth lattice exists for this AI-style picture. Check the
    # observed cell-scale range, source coverage, and actual measured support.
    assert 90 <= result.image.width <= 112 and 90 <= result.image.height <= 112
    assert 9 <= result.grid['sx'] <= 11 and 9 <= result.grid['sy'] <= 11
    for axis, extent in zip(('x', 'y'), image.size):
        cuts = result.grid[axis + '_lines']
        assert cuts[0] == 0 and cuts[-1] == extent
        assert np.all(np.diff(cuts) > 0)
    search = result.diagnostics['grid_search']
    refinement = search['spacing_refinement']
    assert len(refinement['candidates']) <= 15
    assert .30 <= result.confidence < .45
    if variant in ('original', 'flip'):
        # The user's 0.30 threshold now accepts the original 0.302 candidate.
        assert not refinement['attempted']
        assert .30 <= refinement['initial_score'] < .31
        assert result.image.size == (96, 96)
    else:
        assert refinement['attempted'] and refinement['initial_score'] < .30
    assert not search['image_routing']['applied']
    assert 'Low heuristic' in result.diagnostics['warnings'][0]
    if variant == 'original':
        repeated = pixelize(source, Config(photo_mode='off'))
        assert result.grid == repeated.grid
        np.testing.assert_array_equal(result.image, repeated.image)


def test_axis_segments_distinguish_pixel_steps_from_diagonal_lines():
    from PIL import ImageDraw

    def diamond(size):
        image = Image.new('RGBA', (size, size), 'white')
        draw = ImageDraw.Draw(image)
        draw.polygon([(size//2, size//8), (7*size//8, size//2),
                      (size//2, 7*size//8), (size//8, size//2)], fill='#185b99')
        return image

    stepped = diamond(48).resize((384, 384), Image.Resampling.NEAREST)
    diagonal = diamond(1536).resize((384, 384), Image.Resampling.LANCZOS)
    pixel = axis_segment_evidence(load_image(stepped).rgba, (8, 8))
    curve = axis_segment_evidence(load_image(diagonal).rgba, (8, 8))
    assert min(pixel['active_patches'], curve['active_patches']) >= 4
    assert pixel['axis_fraction'] > .80 and pixel['segment_fraction'] > .45
    assert curve['axis_fraction'] < .20 and curve['segment_fraction'] < .10


def test_axis_segments_ignore_hidden_rgb_and_see_alpha_contours():
    from PIL import ImageDraw
    image = Image.new('RGBA', (390, 390))
    draw = ImageDraw.Draw(image)
    for y in range(18, 390, 32):
        for x in range(18, 390, 32):
            draw.rectangle((x, y, x+17, y+17), fill=(0, 0, 0, 255))
    rgba = load_image(image).rgba
    before = rgba.copy()
    expected = axis_segment_evidence(rgba, (18, 18))
    changed = rgba.copy()
    changed[changed[..., 3] == 0, :3] = np.random.default_rng(84).random(
        (np.count_nonzero(changed[..., 3] == 0), 3))
    assert axis_segment_evidence(changed, (18, 18)) == expected
    np.testing.assert_array_equal(rgba, before)
    assert expected['segment_fraction'] > .5 and expected['active_patches'] == 9


def test_axis_segment_memory_and_sample_budget_are_independent_of_image_size():
    # An enormous logical canvas without allocating it: the implementation must
    # read only the bounded patches, not form whole-image gradient temporaries.
    rgba = np.broadcast_to(np.array([.3, .5, .8, 1.], np.float32), (100000, 100000, 4))
    evidence = axis_segment_evidence(rgba, (64, 64))
    assert evidence['sampled_pixels'] <= 9*130*130
    assert len(evidence['patches']) == 9 and evidence['active_patches'] == 0


def test_native_and_strong_grids_skip_segment_scan(monkeypatch):
    import realpixelart.grid as grid

    def unexpected(*args):
        raise AssertionError('Native/strong grid should not pay for the auxiliary scan')

    monkeypatch.setattr(grid, 'axis_segment_evidence', unexpected)
    truth = native_scene(18)
    for image in (truth, enlarged(truth, 12)):
        result = pixelize(image)
        assert not result.diagnostics['grid_search']['axis_segments']['checked']
        np.testing.assert_array_equal(result.image.convert('RGBA'), truth.convert('RGBA'))


def test_sparse_axis_segment_evidence_abstains():
    from types import SimpleNamespace
    from realpixelart.grid import GridCandidate, validate_grid_segments
    image = np.ones((390, 390, 4), np.float32)
    image[180:210, 195:, :3] = 0
    cuts = np.arange(0., 391, 30)
    candidate = GridCandidate(30., 30., 0., 0., cuts, cuts, .32,
                              metadata={'source': 'weak test candidate'})
    report = {}
    chosen = validate_grid_segments(image, SimpleNamespace(ramp_ratio=(1.4, 1.4)), candidate, report)
    assert chosen is candidate
    assert report['axis_segments']['active_patches'] < 4
    assert report['axis_segments']['decision'] == 'inconclusive'


@pytest.mark.parametrize('variant', ['original', 'flip', 'slight_blur', 'crop'])
def test_illustration_does_not_keep_spurious_coarse_grid(variant):
    source = Path(__file__).resolve().parents[2] / 'input/ritsu_2.jpg'
    with Image.open(source) as opened:
        image = opened.copy()
    if variant == 'flip':
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif variant == 'slight_blur':
        image = image.filter(ImageFilter.GaussianBlur(.6))
    elif variant == 'crop':
        image = image.crop((3, 5, image.width-7, image.height-9))
    result = pixelize(image)
    assert result.grid['stylized'] and not result.grid['fallback']
    assert result.image.width >= 180 and result.image.height >= 190
    if variant in ('original', 'flip'):
        assert result.image.size == (190, 200)
        search = result.diagnostics['grid_search']
        assert search['axis_segments']['decision'] == 'rejected'
        assert search['segment_rejected_grid']['size'] == [28, 28]
        assert search['axis_segments']['sampled_pixels'] <= 9*130*130
    if variant == 'original':
        disabled = pixelize(image, Config(photo_mode='off'))
        assert disabled.grid['fallback'] and disabled.image.size == image.size
        np.testing.assert_array_equal(disabled.image, image)


@pytest.mark.parametrize('name,spacing', [
    ('exec-c6a62802-b08a-44b3-b383-0c3ecfaa2c3a.png', 6.),
    ('exec-7ad1ad37-02cd-418a-98c5-ca860384c43a.png', 7.),
])
def test_weak_grid_rectilinear_art_uses_explicit_edge_estimate(name, spacing, tmp_path):
    import json
    source = Path(__file__).resolve().parents[2] / 'input' / name
    result = pixelize(source)
    search = result.diagnostics['grid_search']
    estimate = search['image_routing']['edge_estimate']
    assert result.grid['estimated'] and not result.grid['stylized']
    assert result.grid['sx'] == result.grid['sy'] == spacing
    assert 128 <= max(result.image.size) < 256
    assert search['selected_score'] < .30  # Do not pretend the original lattice passed.
    assert result.confidence == result.diagnostics['selected_score'] == 0
    assert 'original lattice unconfirmed' in result.diagnostics['warnings'][0]
    assert estimate['applied'] and estimate['segments']['active_patches'] >= 4
    assert estimate['segments']['sampled_pixels'] <= 9*130*130
    for axis, size in zip(('x', 'y'), result.grid['input_size']):
        cuts = result.grid[axis + '_lines']
        assert cuts[0] == 0 and cuts[-1] == size and min(np.diff(cuts)) >= 1
    np.testing.assert_array_equal(result.image, pixelize(source).image)
    save_result(result, tmp_path/'result.png', debug=True)
    info = json.loads((tmp_path/'debug/result/info.json').read_text())
    assert info['grid']['estimated'] and info['heuristic_confidence'] == 0


@pytest.mark.parametrize('sampling', ['center', 'median', 'robust'])
def test_edge_estimate_uses_original_sampler_and_independent_palette(sampling):
    source = Path(__file__).resolve().parents[2] / 'input/exec-c6a62802-b08a-44b3-b383-0c3ecfaa2c3a.png'
    result = pixelize(source, Config(sampling=sampling, local_warp='off'))
    assert result.grid['estimated'] and not result.grid['warped']
    rgba = load_image(source).rgba
    cells = recover_cells(rgba, result.grid['x_lines'], result.grid['y_lines'], sampling)
    np.testing.assert_array_equal(result.image, to_pil(cells.rgba, False))
    colored = pixelize(source, Config(sampling=sampling, local_warp='off', colors=8))
    assert colored.grid == result.grid
    np.testing.assert_array_equal(colored.native_image, result.image)


@pytest.mark.parametrize('config', [Config(photo_mode='off'), Config(min_pixel_size=10), Config(max_pixel_size=4)])
def test_edge_estimate_respects_disabled_mode_and_spacing_range(config):
    source = Path(__file__).resolve().parents[2] / 'input/exec-c6a62802-b08a-44b3-b383-0c3ecfaa2c3a.png'
    result = pixelize(source, config)
    assert not result.grid['estimated']
    if config.photo_mode == 'off':
        assert result.grid['fallback'] and result.image.size == (1254, 1254)


def test_rejected_curves_do_not_run_a_second_segment_scan(monkeypatch):
    from realpixelart import grid
    original_scan = grid.axis_segment_evidence
    scans = []

    def scan_once(*args, **kwargs):
        # Validation and fallback now share one module-level function. Allow
        # the original validation scan and still reject any second scan.
        assert not scans, 'curved contours must not be rescued at another scale'
        scans.append(True)
        return original_scan(*args, **kwargs)

    monkeypatch.setattr(grid, 'axis_segment_evidence', scan_once)
    source = Path(__file__).resolve().parents[2] / 'input/ritsu_2.jpg'
    result = pixelize(source)
    assert len(scans) == 1
    assert result.grid['stylized'] and not result.grid['estimated']
    assert result.image.size == (190, 200)


# SAMPLING
def test_robust_beats_center_with_center_outlier():
    image=np.ones((8,8,4),np.float32); image[...,:3]=[.7,.15,.3]
    image[4,4,:3]=[0,1,0]
    robust=recover_cells(image,[0,8],[0,8])
    center=recover_cells(image,[0,8],[0,8],"center")
    assert np.linalg.norm(robust.rgba[0,0,:3]-image[0,0,:3])<.01
    assert np.linalg.norm(center.rgba[0,0,:3]-image[0,0,:3])>.5


@pytest.mark.parametrize("method",["robust","center","median"])
def test_hidden_rgb_does_not_change_result(method):
    image=np.zeros((16,16,4),np.float32); image[3:13,3:13]=[.3,.7,.2,1]
    other=image.copy(); other[other[...,3]==0,:3]=np.random.default_rng(4).random((156,3))
    cuts=[0,4,8,12,16]
    a=recover_cells(image,cuts,cuts,method); b=recover_cells(other,cuts,cuts,method)
    np.testing.assert_array_equal(a.rgba,b.rgba)
    np.testing.assert_array_equal(a.confidence,b.confidence)
    assert np.all(a.rgba[a.rgba[...,3]==0,:3]==0)


def test_fractional_nominal_cuts_use_documented_integer_coverage():
    image=np.ones((2,3,4),np.float32); image[:,0,3]=0
    # New fast model snaps 1.5 to source boundary 2 (NumPy ties-to-even).
    cells=recover_cells(image,[0,1.5,3],[0,2],alpha_mode="coverage")
    assert cells.rgba[0,0,3]==pytest.approx(.5)
    assert cells.rgba[0,1,3]==1
    np.testing.assert_allclose(cells.rgba[0,0,:3],1)


def test_line_hole_and_isolated_highlight_are_preserved():
    truth=np.ones((7,7,4),np.float32); truth[...,:3]=[.2,.3,.5]
    truth[:,2,:3]=[.9,.1,.1]; truth[3,4]=[0,0,0,0]; truth[1,5,:3]=[1,1,.7]
    cuts=np.arange(8)*6
    cells=recover_cells(truth.repeat(6,0).repeat(6,1),cuts,cuts)
    np.testing.assert_allclose(cells.rgba,truth,atol=1e-6)


def test_input_supported_minority_line_can_be_promoted():
    image=np.ones((24,24,4),np.float32); image[...,:3]=.8; image[:,11:13,:3]=.1
    cuts=[0,8,16,24]
    cells=recover_cells(image,cuts,cuts)
    assert np.all(cells.rgba[:,1,0]<.2)
    assert cells.structure["supported_central_strokes"]>=1


def test_coherent_minority_highlight_survives_but_single_hot_pixel_does_not():
    cuts=[0,8,16,24]
    image=np.ones((24,24,4),np.float32); image[...,:3]=.15
    image[11:13,11:13,:3]=1
    assert recover_cells(image,cuts,cuts).rgba[1,1,0]>.9
    image[11:13,11:13,:3]=.15; image[12,12,:3]=1
    assert recover_cells(image,cuts,cuts).rgba[1,1,0]<.2


def test_palette_is_deterministic_bounded_and_alpha_preserving():
    image=np.random.default_rng(23).random((8,8,4),dtype=np.float32)
    image[...,3]=1; image[0,:,3]=0
    cells=recover_cells(image,np.arange(9),np.arange(9))
    a=quantize_cells(cells,5); b=quantize_cells(cells,5)
    np.testing.assert_array_equal(a.rgba,b.rgba)
    np.testing.assert_array_equal(a.rgba[...,3],image[...,3])
    assert len(np.unique(a.rgba[a.rgba[...,3]>0,:3],axis=0))<=5
    assert np.all(a.rgba[0,:,:3]==0)


def test_palette_keeps_rare_highlight_line_and_transparent_hole():
    truth=np.ones((9,9,4),np.float32); truth[...,:3]=[.1,.25,.35]
    truth[...,0]+=np.arange(9)[None,:]*.025
    truth[:,2,:3]=[.9,.12,.1]; truth[2,6,:3]=1; truth[6,6,3]=0
    cuts=np.arange(10)*4
    reduced=quantize_cells(recover_cells(truth.repeat(4,0).repeat(4,1),cuts,cuts),4)
    np.testing.assert_array_equal(reduced.rgba[2,6,:3],[1,1,1])
    assert np.all(np.linalg.norm(reduced.rgba[:,2,:3]-reduced.rgba[:,1,:3],axis=1)>.4)
    assert reduced.rgba[6,6,3]==0


def test_hidden_rgb_does_not_consume_palette_budget():
    image=np.zeros((8,8,4),np.float32)
    image[...,:3]=np.random.default_rng(93).random((8,8,3))
    image[3,3]=[.8,.1,.2,1]; image[4,4]=[.2,.7,.1,.5]
    cuts=np.arange(9); cells=recover_cells(image,cuts,cuts)
    np.testing.assert_array_equal(quantize_cells(cells,2).rgba,cells.rgba)


@pytest.mark.parametrize("colors",[0,-1,513,2.5,True])
def test_invalid_palette(colors):
    cells=recover_cells(np.ones((2,2,4),np.float32),[0,2],[0,2])
    with pytest.raises(ValueError):
        quantize_cells(cells,colors)


@pytest.mark.parametrize("lines",[[0,1,1,2],[0,3],[1,2],[0,float("nan"),2],[0,.1,2]])
def test_invalid_lines(lines):
    with pytest.raises(ValueError,match="cut lines"):
        recover_cells(np.ones((2,2,4),np.float32),lines,[0,2])


def test_invalid_sampling():
    with pytest.raises(ValueError,match="sampling"):
        recover_cells(np.ones((2,2,4),np.float32),[0,2],[0,2],"unknown")


def test_stratification_missed_visible_island_uses_visible_rgb():
    image=np.zeros((40,40,4),np.float32); image[...,:3]=[.8,.1,.9]; image[0,0]=[.1,.8,.2,1]
    cells=recover_cells(image,[0,40],[0,40],alpha_mode="coverage")
    np.testing.assert_allclose(cells.rgba[0,0,:3],[.1,.8,.2])
    assert cells.rgba[0,0,3]==pytest.approx(1/1600)


# PIPELINE
def truth_image(width=12, height=10, seed=23, rgba=False):
    rng = np.random.default_rng(seed)
    palette = np.array([[25, 35, 60], [235, 82, 73], [245, 210, 92],
                        [55, 165, 155], [118, 82, 183], [230, 230, 235]], np.uint8)
    data = palette[rng.integers(0, len(palette), size=(height, width))]
    if rgba:
        alpha = np.full((height, width, 1), 255, np.uint8)
        alpha[:2] = 0
        alpha[:, :2] = 0
        data = np.concatenate([data, alpha], axis=2)
    return Image.fromarray(data)


def enlarged(image, factor=8):
    return image.resize((image.width * factor, image.height * factor), Image.Resampling.NEAREST)


def test_clean_automatic_grid_dimensions_and_colors():
    truth = truth_image()
    result = pixelize(enlarged(truth), Config(local_warp="off"))
    assert result.image.size == truth.size, result.diagnostics
    assert np.abs(np.asarray(result.image, dtype=float) - np.asarray(truth, dtype=float)).max() <= 2
    assert 0 <= result.confidence <= 1
    assert result.grid
    assert result.timings and all(value >= 0 for value in result.timings.values())


def test_automatic_grid_and_nearest_neighbor_export(tmp_path):
    truth = truth_image(8, 6)
    result = pixelize(enlarged(truth, 7), Config())
    assert result.image.size == (8, 6)
    destination = tmp_path / "enlarged.png"
    save_result(result, destination, scale=4)
    with Image.open(destination) as saved:
        assert saved.size == (32, 24)
        expected = np.asarray(result.image.resize(saved.size, Image.Resampling.NEAREST))
        np.testing.assert_array_equal(np.asarray(saved), expected)


def test_seed_free_repeatability():
    truth = truth_image(9, 7)
    image = enlarged(truth, 9).filter(ImageFilter.GaussianBlur(0.45))
    config = Config(colors=5)
    first = pixelize(image, config)
    second = pixelize(image, config)
    np.testing.assert_array_equal(np.asarray(first.image), np.asarray(second.image))
    assert first.grid == second.grid
    assert first.confidence == second.confidence


def test_fully_transparent_hidden_rgb_does_not_change_result():
    truth = truth_image(10, 8, rgba=True)
    clean = np.asarray(enlarged(truth), dtype=np.uint8).copy()
    changed = clean.copy()
    mask = changed[..., 3] == 0
    changed[mask, :3] = np.random.default_rng(91).integers(0, 256, (mask.sum(), 3), dtype=np.uint8)
    first = pixelize(clean, Config())
    second = pixelize(changed, Config())
    a, b = np.asarray(first.image), np.asarray(second.image)
    np.testing.assert_array_equal(a, b)
    np.testing.assert_array_equal(a[..., 3] == 0, np.asarray(truth)[..., 3] == 0)
    assert first.confidence == second.confidence


def test_single_pixel_line_highlight_and_hole_are_not_removed():
    # All structures are one *true grid cell* wide, so their support is unambiguous.
    data = np.full((11, 11, 4), [35, 45, 80, 255], np.uint8)
    data[1:10, 2] = [235, 50, 65, 255]
    data[7, 2:8] = [235, 50, 65, 255]
    data[3, 8] = [255, 250, 225, 255]
    data[5, 5] = [0, 0, 0, 0]
    # Isolate sampling with known cell bounds; sparse shapes need not identify a unique grid.
    source = load_image(enlarged(Image.fromarray(data))).rgba
    cells = recover_cells(source, np.arange(12) * 8, np.arange(12) * 8)
    out = np.asarray(to_pil(cells.rgba))
    assert np.max(np.abs(out[1:10, 2, :3].astype(int) - data[1:10, 2, :3])) <= 2
    assert np.max(np.abs(out[3, 8, :3].astype(int) - data[3, 8, :3])) <= 2
    assert out[5, 5, 3] == 0


def test_robust_sampling_resists_center_impulses_better_than_center():
    truth = truth_image(8, 6)
    image = np.asarray(enlarged(truth, 9)).copy()
    for row in range(truth.height):
        for column in range(truth.width):
            image[row * 9 + 4, column * 9 + 4] = [255, 0, 255]
    target = np.asarray(truth).astype(float)
    errors = {}
    for sampling in ("center", "median", "robust"):
        cells = recover_cells(load_image(image).rgba, np.arange(9) * 9, np.arange(7) * 9, sampling)
        errors[sampling] = np.mean(np.abs(np.asarray(to_pil(cells.rgba, False)).astype(float) - target))
    assert errors["robust"] < errors["center"] * 0.25, errors
    assert errors["robust"] < 5, errors


def test_constant_image_falls_back_without_inventing_grid():
    image = Image.new("RGB", (37, 29), (65, 95, 120))
    result = pixelize(image, Config())
    assert result.image.size == image.size
    assert result.confidence < 0.5
    assert result.diagnostics
    np.testing.assert_array_equal(np.asarray(result.image), np.asarray(image))


@pytest.mark.parametrize("size", [(1, 1), (1, 5), (2, 2)])
def test_tiny_inputs_have_defined_nonempty_outputs(size):
    result = pixelize(Image.new("RGBA", size, (15, 45, 80, 0)), Config())
    assert result.image.width >= 1 and result.image.height >= 1
    assert np.asarray(result.image)[..., 3].max() == 0
    assert result.confidence < 0.5


@pytest.mark.parametrize("kind", ["noninteger", "blur", "jpeg", "crop", "same_color_runs", "texture", "drift"])
def test_degraded_or_ambiguous_inputs_report_diagnostics_and_remain_valid(kind):
    """These cases are quality probes, not assertions of unique automatic recovery."""
    truth = truth_image(10, 8)
    source = enlarged(truth)
    if kind == "noninteger":
        source = truth.resize((75, 60), Image.Resampling.BILINEAR)
    elif kind == "blur":
        source = source.filter(ImageFilter.GaussianBlur(0.7))
    elif kind == "jpeg":
        buffer = io.BytesIO()
        source.save(buffer, format="JPEG", quality=70)
        buffer.seek(0)
        source = Image.open(buffer).convert("RGB")
    elif kind == "crop":
        source = source.crop((3, 2, source.width - 2, source.height - 1))
    elif kind == "same_color_runs":
        data = np.asarray(truth).copy()
        data[:, 3:7] = data[:, 3:4]
        source = enlarged(Image.fromarray(data))
    elif kind == "texture":
        data = np.asarray(source).copy()
        data[::3, ::3] = np.clip(data[::3, ::3].astype(int) + 25, 0, 255)
        source = Image.fromarray(data)
    elif kind == "drift":
        data = np.asarray(truth)
        widths = np.array([8, 9, 8, 7, 8, 9, 8, 7, 8, 8])
        heights = np.array([8, 9, 8, 7, 8, 9, 8, 7])
        source = Image.fromarray(np.repeat(np.repeat(data, heights, axis=0), widths, axis=1))
    result = pixelize(source, Config())
    assert 0 <= result.confidence <= 1
    assert result.image.width > 0 and result.image.height > 0
    assert result.image.width <= source.width and result.image.height <= source.height
    assert result.diagnostics and result.timings


def test_numpy_float_and_pillow_inputs_agree():
    image = enlarged(truth_image(6, 5))
    config = Config()
    as_pillow = pixelize(image, config)
    as_float = pixelize(np.asarray(image, dtype=np.float32) / 255, config)
    np.testing.assert_array_equal(np.asarray(as_pillow.image), np.asarray(as_float.image))


def test_corrupt_input_is_rejected(tmp_path):
    path = tmp_path / "corrupt.png"
    path.write_bytes(b"this is not an image")
    with pytest.raises((ValueError, OSError)):
        pixelize(path, Config())


@pytest.mark.parametrize("values", [
    {"pixel_size": 0}, {"target_size": (0, 4)}, {"scale": 0},
    {"colors": 0}, {"sampling": "unknown"}, {"local_warp": "unknown"},
    {"pixel_size": 8, "target_size": (8, 8)},
    {"min_pixel_size": 16, "max_pixel_size": 8},
])
def test_invalid_configuration_is_rejected(values):
    with pytest.raises((ValueError, TypeError)):
        pixelize(Image.new("RGB", (64, 64)), Config(**values))


def test_palette_budget_counts_visible_colors_only():
    truth = truth_image(9, 7, rgba=True)
    result = pixelize(enlarged(truth), Config(colors=3))
    data = np.asarray(result.image)
    assert data.shape[2] == 4
    colors = np.unique(data[data[..., 3] > 0, :3], axis=0)
    assert len(colors) <= 3
    np.testing.assert_array_equal(data[..., 3] == 0, np.asarray(truth)[..., 3] == 0)


def test_semitransparent_alpha_and_straight_color_survive_clean_recovery():
    data = np.asarray(truth_image(6, 4, rgba=True)).copy()
    data[2:, 2:, 3] = np.array([[64, 128, 192, 255], [255, 192, 128, 64]], np.uint8)
    source = load_image(enlarged(Image.fromarray(data))).rgba
    cells = recover_cells(source, np.arange(7) * 8, np.arange(5) * 8)
    out = np.asarray(to_pil(cells.rgba))
    visible = data[..., 3] > 0
    assert np.abs(out[..., 3].astype(int) - data[..., 3]).max() <= 1
    assert np.abs(out[visible, :3].astype(int) - data[visible, :3]).max() <= 2


def test_removed_target_size_is_rejected():
    with pytest.raises(TypeError, match="target_size"):
        pixelize(Image.new("RGB", (80, 60)), Config(target_size=(8, 8)))


# IO SCORING
def test_exif_orientation():
    im=Image.new("RGB",(20,10)); im.getexif()[274]=6
    assert load_image(im).rgba.shape==(20,10,4)


@pytest.mark.parametrize("kwargs",[{"pixel_size":0},{"pixel_size":float("nan")},{"scale":0},
    {"target_size":(0,4)},{"colors":513},{"max_pixel_size":1},{"sampling":"bad"},
    {"local_warp":"bad"},{"pixel_size":4,"target_size":(8,8)}])
def test_bad_config(kwargs):
    with pytest.raises((ValueError, TypeError)): Config(**kwargs)


def test_bad_float_image():
    with pytest.raises(ValueError): load_image(np.ones((2,2,3),np.float32)*np.nan)


def test_constant_fallback_still_honors_palette_request():
    result=pixelize(Image.new("RGBA",(7,5),(50,90,30,0)),Config(colors=2))
    assert result.image.size==(7,5)
    assert np.asarray(result.image).sum()==0


def test_square_automatic_grid_uses_equal_nominal_spacing():
    source, _ = random_grid()
    grid, _ = detect(source, Config(square=True))
    assert grid.sx == grid.sy == 8.


@pytest.mark.parametrize("size",[(17,19),(18,20),(1,1),(1,5)])
def test_debug_bundle_even_odd_tiny_and_fallback(tmp_path,size):
    import json
    result=pixelize(Image.new("RGBA",size,(40,80,120,0)))
    save_result(result,tmp_path/"sprite.png",debug=True)
    debug=tmp_path/"debug"/"sprite"
    assert {p.name for p in debug.iterdir()}=={"fft.png","edges.png","grid.png","profiles.png","curvature.png","info.json","info.txt"}
    report=json.loads((debug/"info.json").read_text(encoding="utf-8"))
    assert report["grid"]["output_size"]==list(size)
    assert report["grid"]["fallback"] is True
    for name in ["fft.png","edges.png","grid.png","profiles.png","curvature.png"]:
        with Image.open(debug/name) as im:
            im.verify()


def test_pipeline_and_export_need_no_scipy_opencv_or_matplotlib(tmp_path,monkeypatch):
    import builtins
    original=builtins.__import__
    def guarded(name,*args,**kwargs):
        if name.split(".")[0] in {"scipy","cv2","matplotlib","sklearn"}:
            raise AssertionError("Unexpected runtime dependency: "+name)
        return original(name,*args,**kwargs)
    monkeypatch.setattr(builtins,"__import__",guarded)
    truth=np.random.default_rng(97).integers(0,256,(8,9,4),dtype=np.uint8)
    truth[...,3]=255
    result=pixelize(truth.repeat(8,0).repeat(8,1))
    assert result.image.size==(9,8)
    save_result(result,tmp_path/"minimal.png",debug=True)
    assert (tmp_path/"debug"/"minimal"/"fft.png").is_file()


# CLI
SOURCE = Path(__file__).resolve().parents[1]
SCRIPT = SOURCE / "realpixelart.py"
if not SCRIPT.exists():
    SCRIPT = SOURCE.parent / "realpixelart.py"


def invoke(*arguments, cwd):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(SOURCE) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, arguments)],
                          cwd=cwd, env=env, capture_output=True, text=True, timeout=120)


def make_input(path):
    rng = np.random.default_rng(18)
    low = Image.fromarray(rng.integers(20, 235, (6, 8, 3), dtype=np.uint8))
    low.resize((64, 48), Image.Resampling.NEAREST).save(path)
    return low


def test_cli_default_creates_only_result(tmp_path):
    source = tmp_path / "input.png"
    truth = make_input(source)
    output = tmp_path / "result.png"
    completed = invoke("-i", source, "-o", output, cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert "grid=" in completed.stdout and "pixel spacing=" in completed.stdout
    assert {p.name for p in tmp_path.iterdir()} == {"input.png", "result.png"}
    with Image.open(output) as result:
        assert result.format == "PNG"
        assert result.size == truth.size


def test_cli_automatic_grid_and_scale(tmp_path):
    source = tmp_path / "input.png"
    make_input(source)
    output = tmp_path / "result.png"
    completed = invoke("-i", source, "-o", output, "--scale", "4", cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    with Image.open(output) as result:
        assert result.size == (32, 24)
        data = np.asarray(result)
        np.testing.assert_array_equal(data, np.repeat(np.repeat(data[::4, ::4], 4, axis=0), 4, axis=1))


def test_cli_explicit_debug_and_verbose(tmp_path):
    source = tmp_path / "input.png"
    make_input(source)
    output = tmp_path / "result.png"
    debug = tmp_path / "debug"
    completed = invoke("-i", source, "-o", output, "--debug-dir", debug,
                       "--debug", "--verbose", cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert list(debug.glob("*.json")), list(debug.iterdir())
    assert len(list(debug.glob("*.png"))) >= 2
    assert completed.stderr.strip()


def test_cli_rejects_removed_grid_constraints(tmp_path):
    source = tmp_path / "input.png"
    make_input(source)
    completed = invoke("-i", source, "-o", tmp_path / "out.png", "--pixel-size", "8",
                       "--target-size", "8x6", cwd=tmp_path)
    assert completed.returncode != 0
    assert not (tmp_path / "out.png").exists()


def test_cli_corrupt_input_has_short_error(tmp_path):
    source = tmp_path / "corrupt.jpg"
    source.write_bytes(b"not jpeg")
    completed = invoke("-i", source, "-o", tmp_path / "out.png", cwd=tmp_path)
    assert completed.returncode != 0
    assert "Traceback" not in completed.stderr
    assert completed.stderr.strip()
    assert not (tmp_path / "out.png").exists()


def test_cli_constant_input_warns_and_still_writes(tmp_path):
    source = tmp_path / "constant.png"
    Image.new("RGB", (31, 29), "navy").save(source)
    output = tmp_path / "result.png"
    completed = invoke("-i", source, "-o", output, cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr.strip()
    with Image.open(output) as result:
        assert result.size == (31, 29)


def test_cli_removed_pixel_size_is_rejected(tmp_path):
    source = tmp_path / "input.png"
    make_input(source)
    completed = invoke("-i", source, "-o", tmp_path / "result.png", "--pixel-size", "8.0x8.0", cwd=tmp_path)
    assert completed.returncode != 0
    assert "unrecognized arguments" in completed.stderr
    assert not (tmp_path / "result.png").exists()


def test_cli_alpha_policy_and_diagnostic_report(tmp_path):
    import json
    source = tmp_path / "translucent.png"
    Image.new("RGBA", (16, 16), (20, 30, 40, 180)).save(source)
    for mode, expected in [("binary", 255), ("coverage", 180)]:
        target = tmp_path / (mode + ".png")
        debug = tmp_path / "debug" / mode
        completed = invoke("-i", source, "-o", target, "--alpha-mode", mode,
                           "--debug", "--debug-dir", debug, cwd=tmp_path)
        assert completed.returncode == 0, completed.stderr
        assert np.all(np.asarray(Image.open(target))[..., 3] == expected)
        info = json.loads((debug / "info.json").read_text(encoding="utf-8"))
        assert info["diagnostics"]["structure"]["alpha_mode"] == mode


def test_input_only_writes_named_png_and_opt_in_debug_to_project_output(tmp_path,monkeypatch):
    import json
    import realpixelart.__main__ as cli
    project=tmp_path/"checkout"
    project.mkdir()
    (project/"realpixelart.py").write_text("# checkout marker")
    monkeypatch.setattr(cli,"__file__",str(project/"src"/"realpixelart"/"__main__.py"))
    source=tmp_path/"my sprite.jpg"
    make_input(source)
    assert cli.main(["-i",str(source)])==0
    target=project/"output"/"my sprite.png"
    assert target.is_file()
    assert list((project/"output").iterdir()) == [target]
    before = target.read_bytes()
    assert cli.main(["-i",str(source),"--debug"])==0
    assert target.read_bytes() == before
    debug=project/"output"/"debug"/"my sprite"
    assert (debug/"fft.png").is_file() and (debug/"edges.png").is_file()
    info=json.loads((debug/"info.json").read_text(encoding="utf-8"))
    assert info["grid"]["output_size"]==list(Image.open(target).size)
    assert info["export"]["path"]==str(target)


def test_save_result_default_skips_debug_writer(tmp_path, monkeypatch):
    import realpixelart.tools as diagnostics
    def unexpected(*args, **kwargs):
        raise AssertionError("Debug export must be opt-in")
    monkeypatch.setattr(diagnostics, "write_debug", unexpected)
    result = pixelize(Image.new("RGB", (8, 8), "red"))
    save_result(result, tmp_path / "result.png")
    assert [p.name for p in tmp_path.iterdir()] == ["result.png"]
    assert "debug_images" not in result.timings
    assert result.timings["total_with_export"] >= result.timings["total"]


def test_debug_directory_requires_explicit_flag(tmp_path):
    result = pixelize(Image.new("RGB", (8, 8), "red"))
    with pytest.raises(ValueError, match="requires debug"):
        save_result(result, tmp_path / "result.png", debug_dir=tmp_path / "debug")
    source = tmp_path / "input.png"
    make_input(source)
    completed = invoke("-i", source, "-o", tmp_path / "result.png",
                       "--debug-dir", tmp_path / "debug", cwd=tmp_path)
    assert completed.returncode != 0
    assert "requires --debug" in completed.stderr
    assert not (tmp_path / "result.png").exists()


def test_cli_never_overwrites_source(tmp_path):
    source=tmp_path/"input.png"
    make_input(source); original=source.read_bytes()
    completed=invoke("-i",source,"-o",source,cwd=tmp_path)
    assert completed.returncode!=0
    assert source.read_bytes()==original


# ALPHA EDGES
def outlined_edge(alpha=1.):
    source = np.zeros((16, 24, 4), np.float32)
    source[:, 10:] = [.85, .80, .70, alpha]
    source[:, 10:12] = [.06, .07, .08, alpha]
    return source


@pytest.mark.parametrize("source_alpha", [1., 253 / 255])
def test_wrong_grid_does_not_paint_whole_cell_with_off_center_dark_rim(source_alpha):
    source = outlined_edge(source_alpha)
    cuts_x, cuts_y = [0, 8, 16, 24], [0, 8, 16]
    old = recover_cells(source, cuts_x, cuts_y, alpha_mode="coverage")
    new = recover_cells(source, cuts_x, cuts_y)
    assert np.all((old.rgba[:, 1, 3] > 0) & (old.rgba[:, 1, 3] < 1))
    assert np.all(old.rgba[:, 1, 0] > .7)
    np.testing.assert_allclose(new.rgba[:, 1, :3], [[.85, .80, .70]] * 2, atol=1e-6)
    np.testing.assert_allclose(new.rgba[:, 1:, 3], source_alpha)
    assert np.all(new.rgba[:, 0] == 0)
    np.testing.assert_allclose(new.rgba[:, 2, :3], [[.85, .80, .70]] * 2, atol=1e-6)
    assert new.structure["alpha_mode"] == "sample"
    assert new.structure["contour_expansion"] is False


def test_thin_opaque_stroke_survives_without_dilating_into_background():
    source = np.zeros((24, 24, 4), np.float32)
    source[:, 11:13] = [.1, .1, .1, 1]
    cells = recover_cells(source, [0, 8, 16, 24], [0, 8, 16, 24])
    np.testing.assert_array_equal(cells.rgba[:, 1, 3], 1)
    np.testing.assert_allclose(cells.rgba[:, 1, :3], .1, atol=1e-6)
    assert np.all(cells.rgba[:, [0, 2]] == 0)
    assert cells.structure["contour_expansion"] is False


def test_faint_source_alpha_is_not_promoted_and_transparent_hole_stays_open():
    source = np.ones((40, 40, 4), np.float32)
    source[..., :3] = .15
    source[16:24, 16:24] = 0
    source[:8, :8] = [.9, .9, .9, .03]
    cuts = np.arange(6) * 8
    cells = recover_cells(source, cuts, cuts)
    assert cells.structure["alpha_mode"] == "sample"
    assert cells.rgba[0, 0, 3] == pytest.approx(.03)
    assert np.all(cells.rgba[2, 2] == 0)
    assert np.all(cells.rgba[1, :, 3] == 1.)
    binary = recover_cells(source, cuts, cuts, alpha_mode="binary")
    assert np.all(binary.rgba[0, 0] == 0)
    assert set(np.unique(binary.rgba[..., 3])) == {0., 1.}


def test_one_dark_boundary_outlier_does_not_replace_light_outline():
    source = outlined_edge()
    source[:, 10:12, :3] = .85
    source[3, 10, :3] = 0
    cells = recover_cells(source, [0, 8, 16, 24], [0, 8, 16])
    assert np.all(cells.rgba[:, 1, :3] > .6)


def test_genuinely_translucent_art_keeps_sampled_transparency_in_auto():
    source = outlined_edge(.5)
    old = recover_cells(source, [0, 8, 16, 24], [0, 8, 16], alpha_mode="coverage")
    new = recover_cells(source, [0, 8, 16, 24], [0, 8, 16])
    np.testing.assert_array_equal(old.rgba[..., :3], new.rgba[..., :3])
    assert new.structure["alpha_mode"] == "sample"
    assert old.rgba[0, 1, 3] == .375
    assert new.rgba[0, 1, 3] == .5
    assert new.rgba[0, 2, 3] == .5


@pytest.mark.parametrize("mode", ["auto", "binary", "coverage"])
def test_hidden_rgb_never_changes_alpha_or_contour_color(mode):
    source = outlined_edge()
    changed = source.copy()
    mask = source[..., 3] == 0
    changed[mask, :3] = np.random.default_rng(13).random((mask.sum(), 3))
    a = recover_cells(source, [0, 8, 16, 24], [0, 8, 16], alpha_mode=mode)
    b = recover_cells(changed, [0, 8, 16, 24], [0, 8, 16], alpha_mode=mode)
    np.testing.assert_array_equal(a.rgba, b.rgba)


def test_sparse_edge_fallback_is_repeatable_without_inventing_alpha():
    source = Image.fromarray(np.rint(outlined_edge() * 255).astype(np.uint8))
    config = Config()
    a, b = pixelize(source, config), pixelize(source, config)
    np.testing.assert_array_equal(np.asarray(a.image), np.asarray(b.image))
    assert set(np.unique(np.asarray(a.image)[..., 3])) == {0, 255}
    soft = pixelize(source, Config(alpha_mode="coverage"))
    assert a.grid["fallback"] and soft.grid["fallback"]
    np.testing.assert_array_equal(np.asarray(soft.image), np.asarray(source))


@pytest.mark.parametrize("scale", range(1, 17))
def test_export_all_integer_scales_without_recovery(tmp_path, monkeypatch, scale):
    import realpixelart.pipeline as pipeline
    result = pixelize(enlarged(truth_image(8, 7, rgba=True)))
    native = np.asarray(result.image).copy()
    original_grid = dict(result.grid)
    def forbidden(*args, **kwargs):
        raise AssertionError("Export must not run grid detection")
    monkeypatch.setattr(pipeline, "detect_grid", forbidden)
    destination = tmp_path / "scaled.png"
    export_png(result.image, destination, scale)
    with Image.open(destination) as saved:
        np.testing.assert_array_equal(np.asarray(saved), native.repeat(scale, 0).repeat(scale, 1))
    np.testing.assert_array_equal(np.asarray(result.image), native)
    assert result.grid == original_grid
    assert Config(scale=scale).scale == scale


@pytest.mark.parametrize("scale", [0, 17, 64, -1, True, 1.5])
def test_export_and_config_reject_invalid_multiplier(tmp_path, scale):
    with pytest.raises(ValueError, match="1 to 16"):
        Config(scale=scale)
    with pytest.raises(ValueError, match="1 to 16"):
        export_png(Image.new("RGBA", (2, 2)), tmp_path / "invalid.png", scale)
    assert not (tmp_path / "invalid.png").exists()


def test_invalid_alpha_mode():
    with pytest.raises(ValueError, match="alpha_mode"):
        Config(alpha_mode="unknown")
    with pytest.raises(ValueError, match="alpha_mode"):
        recover_cells(outlined_edge(), [0, 24], [0, 16], alpha_mode="unknown")


def test_explicit_binary_mode_also_applies_when_no_grid_exists():
    source = Image.new("RGBA", (13, 11), (30, 40, 50, 180))
    result = pixelize(source, Config(alpha_mode="binary"))
    assert result.diagnostics["fallback"]
    assert result.image.size == source.size
    assert np.all(np.asarray(result.image)[..., 3] == 255)
    preserved = pixelize(source, Config(alpha_mode="coverage"))
    np.testing.assert_array_equal(np.asarray(preserved.image), np.asarray(source))


# Meaningful procedural evaluation scenes (no downloads).
def continuous_scene(seed=0, size=(768, 576), transparent=False):
    """Continuous-tone illustrated landscape with curves, windows and thin rails."""
    from PIL import ImageDraw
    w, h = size
    y, x = np.mgrid[:h, :w].astype(np.float32)
    x /= w; y /= h
    sky = np.stack((155 + 50*y + 10*x, 198 + 22*y, 238 - 18*y + 3*x), axis=-1)
    image = Image.fromarray(np.uint8(np.clip(sky, 0, 255))).convert('RGBA')
    if transparent:
        image = Image.new('RGBA', size)
    draw = ImageDraw.Draw(image)
    def box(coords):
        return tuple(int(v * (w if i % 2 == 0 else h)) for i, v in enumerate(coords))
    draw.ellipse(box((.74, .08, .87, .25)), fill=(255, 224, 128))
    draw.polygon([box(p) for p in [(0,.70),(.22,.30),(.46,.72),(.67,.37),(1,.73),(1,1),(0,1)]], fill=(76,121,103))
    draw.rectangle(box((.31,.51,.68,.90)), fill=(224,187,132))
    draw.polygon([box(p) for p in [(.27,.52),(.48,.28),(.72,.52)]], fill=(154,68,55))
    rng = np.random.default_rng(seed)
    for row in [.58,.73]:
        for col in [.35,.45,.55,.63]:
            draw.rectangle(box((col,row,col+.035,row+.09)), fill=(32,49,69))
            draw.line(box((col+.006,row+.012,col+.025,row+.012)), fill=(248,236,190), width=max(1,w//512))
    for col in [.07,.14,.77,.89,.96]:
        height = rng.uniform(.55,.73)
        draw.line(box((col,height,col,.94)), fill=(65,53,45), width=max(2,w//120))
        draw.ellipse(box((col-.045,height-.13,col+.045,height+.06)), fill=(47,102,76))
    image = image.filter(ImageFilter.GaussianBlur(max(.7, w/850)))
    pixels = np.array(image)
    shade = 8*np.sin(x*6 + seed*.31) + 6*np.cos(y*9 + x*3)
    pixels[...,:3] = np.uint8(np.clip(pixels[...,:3].astype(float) + shade[...,None], 0,255))
    return Image.fromarray(pixels) if transparent else Image.fromarray(pixels[...,:3])


def native_scene(seed=0):
    from PIL import ImageDraw
    rng = np.random.default_rng(seed)
    image = Image.new('RGBA', (67, 57), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((3, 3, 63, 53), fill=(31, 45, 65, 255))
    draw.rectangle((5, 5, 61, 51), fill=(172, 198, 185, 255))
    colors = [(236, 100, 95, 255), (244, 211, 108, 255), (69, 147, 191, 255)]
    for y in range(9, 48, 10):
        for x in range(9, 59, 10):
            draw.rectangle((x-2, y-2, x+5, y+5), fill=(31, 45, 65, 255))
            draw.rectangle((x-1, y-1, x+4, y+4), fill=colors[int(rng.integers(3))])
            draw.line((x+1, y-1, x+1, y+4), fill=(31, 45, 65, 255))
            draw.line((x-1, y+1, x+4, y+1), fill=(31, 45, 65, 255))
            draw.point((x+3, y), fill=(255, 255, 241, 255))
    draw.rectangle((28, 45, 37, 53), fill=(31, 45, 65, 255))
    draw.point((30, 48), fill=(255, 230, 170, 255))
    draw.point((55, 40), fill=(0, 0, 0, 0))
    return image


@pytest.mark.parametrize('name', ['bocchi.png','bocchi2.png','chito.png','hollow-knight-sprite.png','lastTour.png','ritsu.png'])
def test_actual_recovered_image_is_not_downsampled_again(name, tmp_path):
    root = Path(__file__).resolve().parents[2]
    first = pixelize(root/'input'/name)
    # Reencode pixels without any provenance metadata and change the filename.
    source = tmp_path/'unrelated-name.png'
    Image.fromarray(np.array(first.image)).save(source)
    with Image.open(source) as image:
        assert not image.info
    second = pixelize(source)
    assert second.grid['sx'] == second.grid['sy'] == 1
    assert second.grid['native_preserved']
    assert second.grid['source'] == 'native pixel detail'
    np.testing.assert_array_equal(first.image, second.image)
    assert second.diagnostics['grid_search']['rejected_coarse_grid'] is not None


@pytest.mark.parametrize('factor', [2, 3, 4, 8])
def test_real_native_image_enlarged_still_restores_exact_pixels(factor):
    root = Path(__file__).resolve().parents[2]
    native = pixelize(root/'input/bocchi2.png').image
    result = pixelize(enlarged(native, factor))
    assert result.image.size == native.size
    assert not result.grid['native_preserved']
    np.testing.assert_array_equal(result.image, native)


@pytest.mark.parametrize('seed', [7, 18, 29])
@pytest.mark.parametrize('sampling', ['robust', 'center', 'median'])
def test_meaningful_native_scene_preserves_lines_windows_and_highlights(seed, sampling):
    image = native_scene(seed)
    result = pixelize(image, Config(sampling=sampling))
    assert result.image.size == image.size
    np.testing.assert_array_equal(result.image, image)


def test_native_decision_is_not_a_small_image_cutoff():
    native = np.array(native_scene(18))
    # Periodic buildings covering a large canvas must retain their one-pixel bars.
    large = np.tile(native, (12, 13, 1))
    result = pixelize(large)
    assert result.image.size == (large.shape[1], large.shape[0])
    np.testing.assert_array_equal(result.image, large)


def test_exact_two_pixel_crop_and_transparent_rgb():
    source = np.array(enlarged(native_scene(7), 2))[1:-1, 1:-1].copy()
    source[source[..., 3] == 0, :3] = [255, 0, 197]
    result = pixelize(source)
    assert result.grid['sx'] == result.grid['sy'] == 2
    assert result.grid['phase_x'] == result.grid['phase_y'] == 1
    # Every source region is constant: reconstructing it must be byte-exact.
    reconstructed = np.repeat(np.repeat(np.asarray(result.image),
        np.diff(result.grid['y_lines']), axis=0), np.diff(result.grid['x_lines']), axis=1)
    source[source[..., 3] == 0, :3] = 0
    np.testing.assert_array_equal(reconstructed, source)


def test_native_preservation_still_allows_color_postprocessing_and_export(tmp_path):
    image = native_scene(29)
    result = pixelize(image, Config(colors=8, palette='MARD24'))
    assert result.image.size == image.size
    np.testing.assert_array_equal(result.native_image, image)
    expected = process_colors(image, colors=8, palette='MARD24').image
    np.testing.assert_array_equal(result.image, expected)
    save_result(result, tmp_path/'native.png', scale=3, debug=True)
    with Image.open(tmp_path/'native.png') as exported:
        np.testing.assert_array_equal(exported, np.array(expected).repeat(3,0).repeat(3,1))
    import json
    info = json.loads((tmp_path/'debug/native/info.json').read_text(encoding='utf-8'))
    assert info['grid']['native_preserved']
    assert info['diagnostics']['grid_search']['native_resolution']['selected']


# ORDINARY-IMAGE RENDERING: keep the original recovery path for pixel evidence.
def uncertain_sharp_scene(size=(1024, 768)):
    """A sharply drawn sloping roof with too few consistent lattice boundaries."""
    from PIL import ImageDraw
    image = Image.new('RGBA', size, (0, 0, 0, 0))
    w, h = size
    d = ImageDraw.Draw(image)
    d.polygon([(w//7, h*6//7), (w//2, h//8), (w*6//7, h*6//7)], fill='#2d354e')
    d.polygon([(w//7+18, h*6//7-12), (w//2, h//8+30), (w*6//7-18, h*6//7-12)], fill='#dbaa48')
    return image


def test_no_grid_sharp_art_is_rendered_instead_of_returned_unchanged():
    image = uncertain_sharp_scene()
    previous = pixelize(image, Config(photo_mode='off'))
    assert previous.grid['fallback']
    result = pixelize(image)
    assert result.grid['stylized'] and not result.grid['fallback']
    assert result.image.size == (256, 192) and result.confidence == 0
    assert 'no reliable grid' in result.diagnostics['grid_search']['image_routing']['reason']
    assert result.image.getpixel((0, 0)) == (0, 0, 0, 0)
    np.testing.assert_array_equal(result.image, pixelize(image).image)
    colored = pixelize(image, Config(colors=4))
    assert colored.grid == result.grid
    np.testing.assert_array_equal(colored.native_image, result.image)


@pytest.mark.parametrize('factor', [35, 40])
def test_large_scanlines_recover_source_spacing_without_resizing(factor):
    truth = native_scene(18)
    result = pixelize(enlarged(truth, factor))
    assert result.grid['sx'] == result.grid['sy'] == factor
    assert result.image.size == truth.size
    np.testing.assert_array_equal(result.image, truth)
    assert result.diagnostics['grid_search']['feature_sampling'].startswith('96 original-resolution')
    assert result.debug_data['profile_x'].size == truth.width * factor
    assert result.debug_data['profile_y'].size == truth.height * factor
    assert result.debug_data['spectrum_size'] == (512, 512)


def test_large_generated_sampler_keeps_center_stroke_between_area_samples():
    from realpixelart.grid import GridCandidate
    from realpixelart.sampling import render_cells
    # 2048^2 enters bounded sampling. The seam at cell center misses all 8x8
    # area positions; the original supported-center sampler still sees it.
    source = np.full((2048, 2048, 4), .55, np.float32)
    source[..., 3] = 1
    source[:, 16:18, :3] = .05
    cuts = np.arange(0, 2049, 32)
    grid = GridCandidate(32., 32., 0., 0., cuts, cuts, metadata={'stylized': True})
    cells = render_cells(source, grid, Config())
    assert cells.structure['rendering_samples_per_cell'] == 64
    np.testing.assert_allclose(cells.rgba[:, 0, :3], .05, atol=1e-6)
    np.testing.assert_allclose(cells.rgba[:, 1:, :3], .55, atol=1e-6)
    np.testing.assert_array_equal(cells.rgba[..., 3], 1.)


def test_large_generated_grid_diagnostics_and_full_coverage(tmp_path):
    import json
    image = uncertain_sharp_scene((2400, 1800))
    result = pixelize(image)
    assert result.grid['stylized'] and max(result.image.size) == 256
    assert result.grid['x_lines'][-1] == 2400 and result.grid['y_lines'][-1] == 1800
    save_result(result, tmp_path/'roof.png', debug=True)
    debug = tmp_path/'debug/roof'
    for name in ('fft', 'edges', 'grid', 'profiles', 'curvature'):
        with Image.open(debug/(name+'.png')) as preview:
            assert max(preview.size) <= 1100
    info = json.loads((debug/'info.json').read_text())
    assert info['diagnostics']['grid_search']['feature_sampling'].startswith('96 original-resolution')


@pytest.mark.parametrize('seed,size', [(0, (768, 576)), (7, (576, 768)), (18, (1024, 1024))])
def test_ordinary_scene_gets_a_conservative_generated_grid(seed, size):
    image = continuous_scene(seed, size)
    result = pixelize(image)
    previous = pixelize(image, Config(photo_mode='off'))
    assert result.grid['stylized'] and not result.grid['fallback']
    assert result.confidence == 0  # Rendering size is not evidence of an original grid.
    assert max(result.image.size) == min(256, max(96, round(max(size) / 4)))
    assert min(result.image.size) >= 96
    if not previous.grid['fallback']:
        assert all(a >= b for a, b in zip(result.image.size, previous.image.size))
    assert result.grid['x_lines'][0] == result.grid['y_lines'][0] == 0
    assert result.grid['x_lines'][-1] == size[0]
    assert result.grid['y_lines'][-1] == size[1]
    assert min(np.diff(result.grid['x_lines'])) >= 1
    assert min(np.diff(result.grid['y_lines'])) >= 1
    assert result.diagnostics['structure']['averaged_smooth_cells'] > 0
    assert result.diagnostics['grid_search']['image_routing']['applied']
    assert 'not a detected' in result.diagnostics['warnings'][0]
    np.testing.assert_array_equal(pixelize(image).image, result.image)


@pytest.mark.parametrize('degradation', ['nearest', 'blur', 'jpeg', 'bilinear', 'noninteger', 'cropped'])
def test_large_degraded_pixel_art_keeps_existing_recovery(degradation):
    native = native_scene(18)
    image = enlarged(native, 12)
    if degradation == 'blur':
        image = image.filter(ImageFilter.GaussianBlur(.8))
    elif degradation == 'jpeg':
        buffer = io.BytesIO()
        image.convert('RGB').save(buffer, format='JPEG', quality=85)
        buffer.seek(0)
        image = Image.open(buffer)
    elif degradation == 'bilinear':
        image = native.resize(image.size, Image.Resampling.BILINEAR)
    elif degradation == 'noninteger':
        image = native.resize((811, 690), Image.Resampling.NEAREST)
    elif degradation == 'cropped':
        image = image.crop((5, 7, image.width - 3, image.height - 4)).filter(ImageFilter.GaussianBlur(.6))
    result = pixelize(image)
    previous = pixelize(image, Config(photo_mode='off'))
    assert not result.grid['stylized']
    assert result.image.size == previous.image.size
    assert 65 <= result.image.width <= 69 and 55 <= result.image.height <= 59
    np.testing.assert_array_equal(result.image, previous.image)


def test_ordinary_budget_cannot_coarsen_an_existing_grid():
    from dataclasses import replace
    from realpixelart.grid import GridCandidate
    from realpixelart.grid import route_image
    rgba = load_image(continuous_scene()).rgba
    features = extract_features(rgba)
    grid = GridCandidate(2., 2., 0., 0., np.arange(0, 769, 2), np.arange(0, 577, 2),
                         .1, False, {'source': 'weak colour evidence'})
    chosen, report = route_image(rgba, features, grid, Config())
    assert chosen is grid and not report['applied']
    assert 'more detail' in report['reason']
    # Grid strength in just one direction must not be mistaken for two-axis support.
    sparse = replace(grid, sx=48., sy=48., x_lines=np.arange(0, 769, 48),
                     y_lines=np.arange(0, 577, 48),
                     metadata={'source': 'weak colour evidence', 'axis_metrics': [
                         {'edge_fit': .99, 'unit_gaps': .8}, {'edge_fit': .2, 'unit_gaps': .05}]})
    chosen, report = route_image(rgba, features, sparse, Config())
    assert report['applied'] and chosen.metadata['stylized']


@pytest.mark.parametrize('name', ['bocchi.png', 'bocchi2.png', 'chito.png', 'hollow-knight-sprite.png', 'lastTour.png', 'ritsu.png'])
@pytest.mark.parametrize('degradation', ['blur', 'jpeg', 'noninteger'])
def test_actual_pseudo_pixel_art_is_not_rerouted_after_degradation(name, degradation):
    source = Image.open(Path(__file__).resolve().parents[2] / 'input' / name).convert('RGBA')
    if degradation == 'blur':
        source = source.filter(ImageFilter.GaussianBlur(.6))
    elif degradation == 'jpeg':
        buffer = io.BytesIO()
        source.convert('RGB').save(buffer, format='JPEG', quality=85)
        buffer.seek(0)
        source = Image.open(buffer)
    else:
        source = source.resize((round(source.width*1.13), round(source.height*1.13)), Image.Resampling.BILINEAR)
    current = pixelize(source)
    previous = pixelize(source, Config(photo_mode='off'))
    assert not current.grid['stylized']
    assert current.image.size == previous.image.size
    np.testing.assert_array_equal(current.image, previous.image)


def test_ordinary_sampler_suppresses_smooth_texture_aliasing_but_keeps_thin_line():
    from realpixelart.grid import GridCandidate
    from realpixelart.sampling import render_cells
    # Low-contrast woven fabric plus a continuous dark seam, not random noise.
    y, x = np.mgrid[:64, :64]
    source = np.ones((64, 64, 4), np.float32)
    source[..., :3] = (.55 + .018 * np.sin(x * 2.1) + .012 * np.cos(y * 1.7))[..., None]
    source[:, 27:29, :3] = .05
    cuts = np.arange(0, 65, 8)
    grid = GridCandidate(8., 8., 0., 0., cuts, cuts, 0., False, {'stylized': True})
    result = render_cells(source, grid, Config())
    center = recover_cells(source, cuts, cuts, 'center')
    truth = source.reshape(8, 8, 8, 8, 4).mean(axis=(1, 3))
    mask = np.ones((8, 8), bool); mask[:, 3] = False
    robust_error = np.mean(np.abs(result.rgba[mask, :3] - truth[mask, :3]))
    center_error = np.mean(np.abs(center.rgba[mask, :3] - truth[mask, :3]))
    assert robust_error < 1e-6 and robust_error < center_error / 10
    np.testing.assert_allclose(result.rgba[:, 3, :3], .05, atol=1e-6)
    np.testing.assert_array_equal(result.rgba[..., 3], 1.)


def test_ordinary_rendering_alpha_and_color_postprocessing_stay_separate():
    image = continuous_scene(7, transparent=True)
    changed = np.array(image)
    changed[changed[..., 3] == 0, :3] = [255, 0, 233]
    result = pixelize(image)
    assert result.grid['stylized']
    np.testing.assert_array_equal(result.image, pixelize(changed).image)
    rgba = np.asarray(result.image)
    assert np.any(rgba[..., 3] == 0) and np.any(rgba[..., 3] == 255)
    assert np.all(rgba[rgba[..., 3] == 0, :3] == 0)
    colored = pixelize(image, Config(colors=16))
    assert colored.grid == result.grid
    np.testing.assert_array_equal(colored.native_image, result.image)
    np.testing.assert_array_equal(colored.image, process_colors(result.image, colors=16).image)


def test_small_transparent_subject_is_not_reduced_by_canvas_size():
    # Large empty canvas with a small softly shaded object: keep its available pixels.
    canvas = Image.new('RGBA', (1024, 1024))
    canvas.paste(continuous_scene(0, (120, 90), True), (451, 467))
    current = pixelize(canvas)
    previous = pixelize(canvas, Config(photo_mode='off'))
    assert not current.grid['stylized']
    np.testing.assert_array_equal(current.image, previous.image)


@pytest.mark.parametrize('square', [False, True])
def test_ordinary_nondivisible_size_covers_complete_input(square):
    result = pixelize(continuous_scene(0, (771, 579)), Config(square=square))
    assert result.grid['stylized']
    assert result.grid['x_lines'][-1] == 771 and result.grid['y_lines'][-1] == 579
    assert min(np.diff(result.grid['x_lines'])) >= 1 and min(np.diff(result.grid['y_lines'])) >= 1
    if square:
        assert result.grid['sx'] == result.grid['sy']


def test_cli_ordinary_mode_and_generated_grid_diagnostics(tmp_path):
    import json
    source = tmp_path / 'landscape.png'
    continuous_scene().save(source)
    result = tmp_path / 'result.png'
    completed = invoke('-i', source, '-o', result, '--debug', '--debug-dir', tmp_path / 'debug/result', cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert 'ordinary-image' in completed.stderr
    info = json.loads((tmp_path / 'debug/result/info.json').read_text(encoding='utf-8'))
    assert info['grid']['stylized'] and info['grid']['output_size'] == [192, 144]
    assert info['diagnostics']['grid_search']['image_routing']['applied']
    disabled = invoke('-i', source, '-o', result, '--photo-mode', 'off', cwd=tmp_path)
    assert disabled.returncode == 0, disabled.stderr
    with Image.open(result) as output:
        assert output.size == pixelize(source, Config(photo_mode='off')).image.size
    with pytest.raises(ValueError, match='photo_mode'):
        Config(photo_mode='force')
