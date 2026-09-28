"""Generate Python reference pixels for the independent JavaScript engine.

Run from the repository root after installing its Python dependencies:
    python scripts/export_web_reference.py
    node --test web/tests/reference.test.js

Artifacts go under ignored build/web-reference; no Python runtime is shipped to
the website. The optional input directory adds real examples to the synthetic
landscape/sprite cases. Pixel parity verifies migration, not image-art quality.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from realpixelart import Config, pixelize
from realpixelart.tools import load_image, to_pil


def landscape(seed=17):
    """Buildings, windows, one-pixel rails, stars and a transparent hole."""
    rng = np.random.default_rng(seed)
    image = Image.new("RGBA", (128, 128), (35, 49, 83, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((84, 7, 107, 30), fill=(255, 235, 182, 255))
    draw.polygon([(0, 82), (19, 45), (51, 78), (82, 34), (115, 66),
                  (127, 53), (127, 127), (0, 127)], fill=(72, 91, 101, 255))
    draw.rectangle((0, 95, 127, 127), fill=(47, 102, 129, 255))
    for x in range(4, 121, 19):
        top = int(rng.integers(55, 78))
        draw.rectangle((x, top, x + 13, 110), fill=(28, 33, 51, 255))
        draw.polygon([(x - 2, top), (x + 6, top - 8), (x + 15, top)],
                     fill=(180, 77, 64, 255))
        for y in range(top + 4, 105, 7):
            for window in (x + 3, x + 9):
                draw.rectangle((window, y, window + 1, y + 2),
                               fill=(247, 218, 135, 255))
    draw.line((0, 113, 127, 113), fill=(11, 23, 45, 255), width=1)
    for x in range(0, 128, 5):
        draw.line((x, 110, x, 120), fill=(11, 23, 45, 255), width=1)
    for _ in range(18):
        draw.point((int(rng.integers(0, 128)), int(rng.integers(1, 35))),
                   fill=(252, 245, 211, 255))
    draw.rectangle((35, 117, 74, 125), fill=(84, 164, 188, 255))
    draw.point((54, 121), fill=(0, 0, 0, 0))
    return image


def transparent_sprite():
    image = Image.new("RGBA", (72, 80), (227, 12, 199, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((17, 3, 52, 42), fill=(21, 32, 50, 255))
    draw.rectangle((23, 15, 47, 37), fill=(240, 219, 173, 255))
    draw.rectangle((17, 42, 54, 67), fill=(21, 32, 50, 255))
    draw.rectangle((21, 43, 51, 63), fill=(87, 153, 173, 255))
    draw.line((14, 23, 8, 52), fill=(21, 32, 50, 255), width=1)
    draw.rectangle((24, 66, 30, 76), fill=(21, 32, 50, 255))
    draw.rectangle((44, 66, 50, 76), fill=(21, 32, 50, 255))
    draw.point((28, 23), fill=(0, 0, 0, 255))
    draw.point((43, 23), fill=(0, 0, 0, 255))
    draw.point((40, 46), fill=(255, 255, 255, 255))
    draw.rectangle((31, 54, 35, 58), fill=(227, 12, 199, 0))
    return image


def cases(input_dir):
    if input_dir.is_dir():
        for path in sorted(input_dir.iterdir()):
            if path.is_file() and path.suffix.lower() in (".png", ".jpg", ".jpeg"):
                yield f"input/{path.name}", path, {}
    native = landscape()
    transparent = transparent_sprite()
    for seed in (7, 18, 29):
        yield f"native-scene-{seed}", landscape(seed), {}
    for factor in (2, 3, 4, 8):
        yield f"integer-{factor}x", native.resize(
            (128 * factor, 128 * factor), Image.Resampling.NEAREST), {}
    yield "integer-crop-phase", native.resize(
        (512, 512), Image.Resampling.NEAREST).crop((1, 2, 510, 509)), {}
    yield "noninteger-nearest", native.resize((713, 679), Image.Resampling.NEAREST), {}
    yield "bilinear-scale", native.resize((683, 683), Image.Resampling.BILINEAR), {}
    large = native.resize((1024, 1024), Image.Resampling.NEAREST)
    yield "blurred-grid", large.filter(ImageFilter.GaussianBlur(.65)), {}
    yield "blurred-photo-off", large.filter(ImageFilter.GaussianBlur(1.5)), {"photo_mode": "off"}
    yield "transparent-native", transparent, {}
    sprite = transparent.resize((576, 640), Image.Resampling.NEAREST)
    yield "transparent-grid", sprite, {}
    yield "transparent-soft", sprite.filter(ImageFilter.GaussianBlur(.75)), {}
    yield "sparse-over-4m", native.resize((2049, 2049), Image.Resampling.NEAREST), {}
    yield "solid-rgb", Image.new("RGB", (300, 200), (44, 125, 171)), {}
    yield "solid-alpha", Image.new("RGBA", (71, 67), (28, 70, 138, 75)), {"photo_mode": "off"}
    yield "transparent-hidden-rgb", Image.new("RGBA", (43, 29), (223, 34, 97, 0)), {}
    yield "tiny-1x1", Image.new("RGBA", (1, 1), (28, 70, 138, 75)), {}
    yield "tiny-strip", Image.new("RGB", (1, 27), (52, 92, 129)), {}
    yield "tiny-scene", native.resize((13, 11), Image.Resampling.NEAREST), {}
    for sampling in ("center", "median", "robust"):
        yield f"sampling-{sampling}", sprite, {"sampling": sampling}
    for alpha in ("auto", "binary", "coverage"):
        yield f"alpha-{alpha}", sprite.filter(ImageFilter.GaussianBlur(.7)), {"alpha_mode": alpha}
    yield "warp-off", large, {"local_warp": "off"}
    yield "square", native.resize((779, 847), Image.Resampling.NEAREST), {"square": True}
    photo = input_dir / "ritsu_2.jpg"
    if photo.is_file():
        yield "photo-off", photo, {"photo_mode": "off"}
    yield "range-limited", large, {"min_pixel_size": 3., "max_pixel_size": 17.}
    yield "export-scale", sprite, {"scale": 16}
    for mode in ("natural", "rgb"):
        yield f"colors32-{mode}", large.filter(ImageFilter.GaussianBlur(.6)), {
            "colors": 32, "color_mode": mode}
        yield f"mard24-{mode}", sprite, {"palette": "MARD24", "color_mode": mode}
        yield f"dmc436-colors32-{mode}", sprite, {
            "palette": "DMC436", "colors": 32, "color_mode": mode}


def export_case(output_dir, index, name, source, options):
    config = Config(**options)
    data = load_image(source)
    result = pixelize(source, config)
    stem = f"{index:02}"
    filenames = {kind: f"{stem}-{kind}.rgba" for kind in ("source", "native", "output")}
    (output_dir / filenames["source"]).write_bytes(to_pil(data.rgba, True).tobytes())
    (output_dir / filenames["native"]).write_bytes(result.native_image.convert("RGBA").tobytes())
    (output_dir / filenames["output"]).write_bytes(result.image.convert("RGBA").tobytes())
    record = {
        "name": name, "config": asdict(config),
        "image": {"width": data.rgba.shape[1], "height": data.rgba.shape[0],
                  "source": filenames["source"], "has_alpha": data.has_alpha,
                  "metadata": data.metadata},
        "expected": {"width": result.image.width, "height": result.image.height,
                     "native": filenames["native"], "output": filenames["output"],
                     "mode": result.image.mode, "grid": result.grid,
                     "confidence": result.confidence, "diagnostics": result.diagnostics},
    }
    filename = stem + ".json"
    (output_dir / filename).write_text(json.dumps(record, separators=(",", ":")), encoding="utf-8")
    return filename


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "build/web-reference")
    parser.add_argument("--input-dir", type=Path, default=ROOT / "input")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for index, (name, source, options) in enumerate(cases(args.input_dir)):
        manifest.append(export_case(args.output_dir, index, name, source, options))
        print(name, flush=True)
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"Exported {len(manifest)} cases to {args.output_dir}")


if __name__ == "__main__":
    main()
