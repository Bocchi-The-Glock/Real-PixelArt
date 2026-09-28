"""Image I/O, alpha-aware preprocessing, PNG export and optional diagnostics.

These utilities consume grid/sampling results; they never select a grid or
palette. Diagnostic thumbnails are for display, not algorithm input.
"""
from dataclasses import dataclass, field
import json
from pathlib import Path
from time import perf_counter
import warnings

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import validate_scale


# Image loading, normalization and export

@dataclass
class ImageData:
    rgba: np.ndarray
    has_alpha: bool
    metadata: dict = field(default_factory=dict)


def _oriented_photo(image):
    """Read one photo, including the primary JPEG in an MPF/MPO container.

    MPO is a multi-picture photograph container, not an animation format. Use
    its unique declared primary image, otherwise the first image, explicitly.
    Do not change the caller's current frame. Other multi-frame formats remain
    unsupported; never silently select a GIF/APNG/TIFF frame.
    """
    frames = getattr(image, 'n_frames', 1)
    if frames != 1 and image.format != 'MPO':
        raise ValueError(f"only single-frame static images are supported; "
                         f"detected format={image.format or 'unknown'}, frames={frames}. "
                         "Export the intended photo/frame as a static PNG or JPEG.")
    selected = 0
    policy = 'single image'
    if frames > 1:
        entries = getattr(image, 'mpinfo', {}).get(0xB002, [])
        primary = [i for i, entry in enumerate(entries[:frames])
                   if entry.get('Attribute', {}).get('MPType') == 'Baseline MP Primary Image']
        selected = primary[0] if len(primary) == 1 else 0
        policy = 'declared MP primary image' if len(primary) == 1 else 'first MPO image'
    metadata = dict(format=image.format or 'PIL', frames=frames,
                    selected_frame=selected, selection=policy)
    previous = image.tell()
    try:
        if previous != selected:
            image.seek(selected)
        oriented = ImageOps.exif_transpose(image)
    finally:
        if image.tell() != previous:
            image.seek(previous)
    return oriented, metadata


def load_image(image) -> ImageData:
    """Accept a path, PIL image, or HxWx3/4 uint8 / float [0,1] array.

    Computation uses encoded sRGB, not linear radiometry. Hidden RGB is cleared
    only where alpha is zero; the visible input is otherwise left untouched.
    """
    if isinstance(image, np.ndarray):
        metadata = dict(format='array', frames=1, selected_frame=0, selection='single image')
        a = np.asarray(image)
        if a.ndim != 3 or a.shape[-1] not in (3, 4) or min(a.shape[:2]) < 1:
            raise ValueError("image array must have positive shape HxWx3 or HxWx4")
        if a.dtype == np.uint8:
            a = a.astype(np.float32)
            a /= 255.0
        elif a.dtype.kind == "f":
            if not np.isfinite(a).all() or a.min() < 0 or a.max() > 1:
                raise ValueError("floating image values must be finite and in [0,1]")
            a = a.astype(np.float32, copy=True)
        else:
            raise ValueError("image array must be uint8 or floating point in [0,1]")
        has_alpha = a.shape[2] == 4
        if not has_alpha:
            a = np.concatenate((a, np.ones((*a.shape[:2], 1), np.float32)), axis=2)
    else:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                if isinstance(image, Image.Image):
                    # Copying a PIL image can discard a modified in-memory Exif
                    # object. Transpose first; exif_transpose returns a copy.
                    im, metadata = _oriented_photo(image)
                else:
                    with Image.open(image) as opened:
                        im, metadata = _oriented_photo(opened)
                if min(im.size) < 1:
                    raise ValueError("image dimensions must be positive")
                has_alpha = "A" in im.getbands() or "transparency" in im.info
                # One full float buffer; avoid full RGBA conversion, tobytes and
                # a second float buffer being alive together on large photos.
                try:
                    a = np.empty((im.height, im.width, 4), np.float32)
                    for start in range(0, im.height, 64):
                        with im.crop((0, start, im.width, min(start + 64, im.height))) as stripe:
                            with stripe.convert('RGBA') as rgba:
                                a[start:start + 64] = np.asarray(rgba)
                        a[start:start + 64] /= 255.0
                finally:
                    im.close()
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise ValueError(f"cannot read valid static image: {exc}") from exc
    for start in range(0, len(a), 64):
        stripe = a[start:start + 64]
        stripe[stripe[..., 3] == 0, :3] = 0
    return ImageData(np.ascontiguousarray(a), has_alpha, metadata)


def to_pil(rgba: np.ndarray, has_alpha: bool = True) -> Image.Image:
    a = np.empty(rgba.shape, np.uint8)
    for start in range(0, len(rgba), 64):
        values = np.clip(rgba[start:start + 64], 0, 1)
        values *= 255
        np.rint(values, out=values)
        stripe = a[start:start + 64]
        stripe[:] = values
        stripe[stripe[..., 3] == 0, :3] = 0
    return Image.fromarray(a if has_alpha else a[..., :3])


def export_png(image, path, scale: int = 1) -> None:
    """Export an already recovered native image; never run grid detection again."""
    validate_scale(scale)
    path = Path(path)
    if path.suffix.lower() != ".png":
        raise ValueError("output must have a .png extension")
    if scale != 1:
        image = image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


def save_result(result, path, scale: int = 1, debug_dir=None, *, debug=False) -> None:
    """Save PNG; write diagnostics only when debug=True."""
    if debug_dir is not None and not debug:
        raise ValueError("debug_dir requires debug=True")
    started = perf_counter()
    path = Path(path)
    export_png(result.image, path, scale)
    result.timings["save_png"] = perf_counter() - started
    result.timings.pop("debug_images", None)
    result.timings["total_with_export"] = result.timings["total"] + result.timings["save_png"]
    if debug:
        directory = Path(debug_dir) if debug_dir is not None else path.parent / "debug" / path.stem
        write_debug(result, directory=directory, export_path=path, export_scale=scale)


# Diagnostic rendering and reports (opt-in)

def _json_safe(value):
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    return value


def _preview_axes(width, height, limit=1024):
    factor = min(1., limit / max(width, height))
    pw, ph = max(1, round(width * factor)), max(1, round(height * factor))
    return ((np.arange(pw) + .5) * width / pw).astype(int), ((np.arange(ph) + .5) * height / ph).astype(int)


def _fft_preview(half, width, limit=1024):
    """Sample the shifted, Hermitian full spectrum without materializing it."""
    height = len(half)
    x, y = _preview_axes(width, height, limit)
    fx, fy = (x - width // 2) % width, (y - height // 2) % height
    reflected = fx > width // 2
    return half[np.where(reflected[None, :], -fy[:, None] % height, fy[:, None]),
                np.where(reflected, width - fx, fx)[None, :]]


def _display(image, title, limit=1024, lines=None, source_size=None):
    from PIL import ImageDraw

    source_width, source_height = source_size or image.size
    x, y = _preview_axes(*image.size, limit)
    image = image.resize((len(x), len(y)), Image.Resampling.NEAREST)
    frame = Image.new("RGB", (max(520, image.width), image.height + 42), "#20232b")
    left = (frame.width - image.width) // 2
    frame.paste(image, (left, 42))
    draw = ImageDraw.Draw(frame)
    # Draw after thumbnailing: a one-source-pixel line otherwise disappears
    # unpredictably under nearest-neighbour display reduction.
    if lines is not None:
        for x in lines[0]:
            px = left + min(image.width - 1, max(0, x * image.width / source_width))
            draw.line((px, 42, px, 41 + image.height), fill="#ff657c")
        for y in lines[1]:
            py = 42 + min(image.height - 1, max(0, y * image.height / source_height))
            draw.line((left, py, left + image.width - 1, py), fill="#ff657c")
    draw.text((12, 12), title, fill="white")
    return frame


def _plot(draw, rect, values, color, label, markers=()):
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, outline="#aaa")
    values = np.asarray(values)
    maximum = max(float(values.max(initial=0)), 1e-8)
    points = [(x0 + i * (x1 - x0) / max(len(values) - 1, 1),
               y1 - float(v) / maximum * (y1 - y0 - 22)) for i, v in enumerate(values)]
    if len(points) > 1:
        draw.line(points, fill=color, width=1)
    for m in markers:
        x = x0 + float(m) / max(len(values) - 1, 1) * (x1 - x0)
        if x0 <= x <= x1:
            draw.line((x, y0, x, y1), fill="#f16b7f", width=1)
    draw.text((x0 + 6, y0 + 4), label, fill="white")


def write_debug(result, original=None, directory=None, export_path=None, export_scale=1):
    from PIL import ImageDraw

    started = perf_counter()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    debug = result.debug_data
    draw_grid = not result.grid["fallback"] and not result.grid.get("native_preserved", False)
    w, h = result.grid["input_size"]
    # Full-image mode shares its spectrum with detection; large-image mode
    # displays a bounded source patch and detects using full-length scanlines.
    fw, fh = debug.get('spectrum_size', (w, h))
    spectrum = _fft_preview(debug["spectrum"], fw)
    low, high = float(spectrum.min()), float(np.percentile(spectrum, 99.5))
    pixels = np.clip((spectrum - low) / max(high - low, 1e-8), 0, 1)
    fft = Image.fromarray(np.rint(pixels * 255).astype(np.uint8)).convert("RGB")
    fft_lines = None
    if draw_grid and not result.grid.get('stylized', False):
        fft_lines = ([fw // 2 + offset * fw / result.grid["sx"] for offset in (-1, 1)],
                     [fh // 2 + offset * fh / result.grid["sy"] for offset in (-1, 1)])
    fft_title = ("Image FFT: generated rendering grid; no detected reciprocal spacing" if result.grid.get('stylized', False)
                 else "Image FFT: log(1+|F|); red = selected reciprocal spacing")
    if result.grid.get('estimated', False):
        fft_title = "Image FFT: red = edge-estimated spacing, NOT a confirmed FFT period"
    if (fw, fh) != (w, h):
        fft_title = f"FFT: {fw}x{fh} source patch (display); detector uses full-length scanlines"
    _display(fft, fft_title, lines=fft_lines, source_size=(fw, fh)).save(directory / "fft.png")
    x, y = _preview_axes(w, h)
    if debug['edge_x'].shape == (h, w):
        ex = debug["edge_x"][np.ix_(y, x)]
        ey = debug["edge_y"][np.ix_(y, x)]
    else:
        ex, ey = debug['edge_x'], debug['edge_y']
    # Independent x/y derivatives remain visible: x is red, y is green.
    strength = np.maximum(ex, ey)
    cap = max(float(np.percentile(strength[strength > 0], 95)), .05) if np.any(strength > 0) else 1.
    edge = np.stack((ex, ey, np.minimum(ex, ey)), axis=-1)
    edge = np.rint(np.clip(edge / cap, 0, 1) * 255).astype(np.uint8)
    _display(Image.fromarray(edge), "Colour + alpha edges: X=red, Y=green; preview of source derivatives").save(directory / "edges.png")
    source = debug["source"].resize((len(x), len(y)), Image.Resampling.NEAREST)
    # Neutral background is for display only; the result PNG keeps its alpha.
    bg = Image.new("RGBA", source.size, (190, 190, 190, 255))
    bg.alpha_composite(source)
    overlay = bg.convert("RGB")
    lines = (result.grid["x_lines"], result.grid["y_lines"]) if draw_grid else None
    title = (f"Grid {result.image.width}x{result.image.height}; "
             f"spacing {result.grid['sx']:.3f}x{result.grid['sy']:.3f}; confidence {result.confidence:.3f}")
    _display(overlay, title, lines=lines, source_size=(w, h)).save(directory / "grid.png")
    plots = Image.new("RGB", (1040, 620), "#20232b")
    d = ImageDraw.Draw(plots)
    for i, (profile, lines, name) in enumerate([
            (debug["profile_x"], result.grid["x_lines"], "X"),
            (debug["profile_y"], result.grid["y_lines"], "Y")]):
        y = i * 300
        _plot(d, (20, y + 10, 1015, y + 140), profile, "#8ddbc1", name + " colour edge projection; red=cuts",
              lines if draw_grid else ())
        power = abs(np.fft.rfft(profile - profile.mean()))
        spacing = result.grid["sx" if i == 0 else "sy"]
        _plot(d, (20, y + 160, 1015, y + 290), power, "#e2c87a", name + " edge-projection FFT",
              [len(profile) / spacing] if draw_grid and not result.grid.get('stylized', False) else ())
    plots.save(directory / "profiles.png")
    knots = Image.new("RGB", (1040, 330), "#20232b")
    kd = ImageDraw.Draw(knots)
    for i, axis in enumerate(("x", "y")):
        cuts = np.asarray(result.grid[axis + "_lines"])
        centres = (cuts[:-1] + cuts[1:]) / 2 - .5
        _plot(kd, (20, 10+i*160, 1015, 150+i*160), debug["curvature_" + axis], "#8dbaf0",
              axis.upper()+" curvature; red=cell centres; model="+
              result.diagnostics["grid_search"].get("evidence_model", "boundaries"),
              centres if draw_grid else ())
    knots.save(directory / "curvature.png")
    result.timings["debug_images"] = perf_counter() - started
    result.timings["total_with_export"] = (result.timings["total"] + result.timings.get("save_png", 0)
                                           + result.timings["debug_images"])
    report = dict(grid=result.grid, heuristic_confidence=result.confidence,
                  timings_seconds=result.timings, diagnostics=result.diagnostics,
                  export=dict(path=str(export_path) if export_path else None, scale=export_scale,
                              size=[result.image.width * export_scale, result.image.height * export_scale]))
    (directory / "info.json").write_text(json.dumps(_json_safe(report), indent=2, ensure_ascii=False,
                                                   allow_nan=False), encoding="utf-8")
    summary = [
        f"Native output grid: {result.image.width} x {result.image.height}",
        f"Source pixel spacing: {result.grid['sx']:.6f} x {result.grid['sy']:.6f}",
        f"Initial phase: {result.grid['phase_x']:.6f}, {result.grid['phase_y']:.6f}",
        f"Median actual cell size: {result.grid['median_cell_width']} x {result.grid['median_cell_height']}",
        f"Selected by: {result.grid['source']}; local adjustment: {result.grid['warped']}",
        f"Heuristic confidence (NOT probability): {result.confidence:.4f}",
        f"Fallback: {result.grid['fallback']}; export scale: {export_scale}",
        f"Alpha policy: {result.diagnostics.get('structure', {}).get('alpha_mode', 'unchanged fallback')}",
        f"Centre impulses rejected: {result.diagnostics.get('structure', {}).get('rejected_central_impulses', 0)}; "
        "contour expansion: disabled",
        f"Processing: {result.timings['total']:.4f}s; with PNG/debug: {result.timings['total_with_export']:.4f}s",
        "All source pixels are covered. Display thumbnails do not affect detection.",
        "FFT/edge preview contrast is normalized on display samples, not the full image.",
        *result.diagnostics["warnings"],
    ]
    segments = result.diagnostics['grid_search'].get('axis_segments', {})
    if segments:
        summary.append(f"Axis-segment validation: {segments.get('decision')}; {segments.get('reason')}")
        if segments.get('checked'):
            summary.append(f"Straight-run edge-weight fraction: {segments['segment_fraction']:.3f}; "
                           f"active patches: {segments['active_patches']}; sampled pixels: {segments['sampled_pixels']}")
    estimate = result.diagnostics['grid_search'].get('image_routing', {}).get('edge_estimate')
    if estimate:
        summary.append(f"Edge-guided estimate: {estimate['applied']}; {estimate['reason']}")
        summary.append(f"Axis median edge gaps: {estimate.get('axis_median_gaps')}; "
                       f"estimated spacing: {estimate.get('spacing')}")
    (directory / "info.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
