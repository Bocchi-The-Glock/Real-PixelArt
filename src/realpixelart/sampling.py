"""Recover grid-cell colors and alpha, then optionally limit or match colors.

Sampling and color postprocessing have separate entry points: recoloring an
already restored image never reruns grid detection or cell sampling.

sRGB/D65 Lab and CIEDE2000 (kL=kC=kH=1), using only NumPy.
Equations/reference pairs: Sharma, Wu & Dalal (2005),
https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
Inputs to rgb_to_lab are encoded RGB in [0,255]. No display/ICC calibration.
"""
from dataclasses import dataclass, field, replace
from functools import lru_cache
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image

from .config import DENSE_PIXEL_LIMIT, validate_color_options
from .tools import to_pil


@dataclass
class CellResult:
    rgba: np.ndarray
    confidence: np.ndarray
    structure: dict = field(default_factory=dict)


@dataclass
class ColorResult:
    image: Image.Image
    diagnostics: dict
    seconds: float


# Grid-cell color and alpha recovery

def _resolve_alpha_mode(alpha, requested):
    if requested not in ("auto", "binary", "coverage"):
        raise ValueError("alpha_mode must be auto, binary, or coverage")
    visible = np.count_nonzero(alpha > 0)
    near_opaque = np.count_nonzero(alpha >= .94) / max(visible, 1)
    return ("sample" if requested == "auto" else requested), float(near_opaque)


def _cell_sums(values, xs, ys):
    """Sum half-open source cells, reducing rows before columns for stable rounding."""
    return np.add.reduceat(np.add.reduceat(values, ys[:-1], axis=0), xs[:-1], axis=1)


def _sample_positions(cuts, fractions):
    """Locate fractional samples inside each cell without crossing its right edge."""
    widths = np.diff(cuts)
    return np.minimum(cuts[:-1, None] + (widths[:, None] * fractions).astype(int),
                      cuts[1:, None] - 1)


def recover_cells(rgba, x_lines, y_lines, method="robust", alpha_mode="auto"):
    """Sample cells in bounded batches, retaining supported center colors exactly.

    Cut lines cover the full source and are rounded to integer half-open boxes.
    Robust mode replaces only unsupported center impulses; alpha follows the
    selected sample unless coverage averaging or binary alpha was requested.
    """
    if method not in ("robust", "center", "median"):
        raise ValueError("unknown sampling method")
    resolved_alpha, near_opaque = _resolve_alpha_mode(rgba[..., 3], alpha_mode)
    h, w = rgba.shape[:2]
    for lines, length in ((x_lines, w), (y_lines, h)):
        lines = np.asarray(lines)
        if (lines.ndim != 1 or len(lines) < 2 or not np.isfinite(lines).all()
                or lines[0] != 0 or lines[-1] != length or np.any(np.diff(lines) <= 0)):
            raise ValueError("cut lines must be finite, increasing and cover the complete input")
    xs, ys = np.rint(x_lines).astype(int), np.rint(y_lines).astype(int)
    widths, heights = np.diff(xs), np.diff(ys)
    if np.any(widths < 1) or np.any(heights < 1):
        raise ValueError("cut lines must cover at least one source pixel")
    ny, nx = len(heights), len(widths)
    area = heights[:, None] * widths[None]
    alpha = _cell_sums(rgba[..., 3], xs, ys) / area
    result = np.zeros((ny * nx, 4), np.float32)
    confidence = np.zeros(ny * nx, np.float32)
    fractions = np.array([.18, .34, .50, .66, .82]) if method != "center" else np.array([.5])
    xp = _sample_positions(xs, fractions)
    yp = _sample_positions(ys, fractions)
    detail_count = rejected_count = 0
    for start in range(0, ny * nx, 1024):
        ids = np.arange(start, min(start + 1024, ny * nx))
        ids = ids[alpha.ravel()[ids] > 0]
        if not len(ids):
            continue
        yy, xx = ids // nx, ids % nx
        samples = rgba[yp[yy, :, None], xp[xx, None, :]].reshape(len(ids), -1, 4)
        rgb, a = samples[..., :3], samples[..., 3]
        valid = a > 1e-6
        centre = samples[:, len(fractions)**2 // 2].copy()
        centre[centre[:, 3] == 0, :3] = 0
        color, selected_alpha = centre[:, :3].copy(), centre[:, 3].copy()
        support = np.ones(len(ids), np.float32)
        if method != "center":
            median_alpha = np.median(a, axis=1)
            count = valid.sum(axis=1)
            sorted_rgb = np.sort(np.where(valid[..., None], rgb, np.inf), axis=1)
            median = sorted_rgb[np.arange(len(ids)), np.maximum(0, (count - 1) // 2)]
            median[count == 0] = 0
            near_median = valid & (np.max(abs(rgb - median[:, None]), axis=2) < .12)
            if method == "median":
                color = median
                selected_alpha = median_alpha
                support = near_median.sum(axis=1) / np.maximum(count, 1)
            else:
                # Compare premultiplied colour AND alpha. Hidden transparent RGB
                # cannot turn a transparent centre into a spurious colour outlier.
                cx, cy = xs[xx] + widths[xx] // 2, ys[yy] + heights[yy] // 2
                px = np.clip(cx[:, None] + [-1, 0, 1], xs[xx, None], xs[xx + 1, None] - 1)
                py = np.clip(cy[:, None] + [-1, 0, 1], ys[yy, None], ys[yy + 1, None] - 1)
                patch = rgba[py[:, :, None], px[:, None, :]].reshape(-1, 9, 4)
                central_pm = centre[:, :3] * centre[:, 3, None]
                distance = np.maximum(np.max(abs(patch[..., :3] * patch[..., 3, None]
                                                - central_pm[:, None]), axis=2),
                                      abs(patch[..., 3] - centre[:, 3, None]))
                near = distance < .10
                # Two adjacent supporters retain a one-source-pixel-wide line;
                # a 2x2 highlight also passes. A single impulse does not.
                coherent = near.sum(axis=1) >= 3
                tiny = (widths[xx] <= 2) | (heights[yy] <= 2)
                deviation = np.max(abs(centre[:, :3] - median), axis=1) > .10
                reject = ~coherent & ~tiny & (deviation | (abs(centre[:, 3] - median_alpha) > .10))
                color[reject] = median[reject]
                selected_alpha[reject] = median_alpha[reject]
                rejected_count += int(reject.sum())
                detail_count += int(np.count_nonzero(coherent & deviation & (centre[:, 3] > 0)))
                support = np.where(reject, near_median.sum(axis=1) / np.maximum(count, 1),
                                   near.sum(axis=1) / 9)
                # Deliberately keep the supported centre exactly: averaging the
                # whole colour cluster reintroduces edge blends and blurs lines.
        result[ids, :3], result[ids, 3] = color, selected_alpha
        confidence[ids] = support
    if resolved_alpha == "coverage":
        missing = (alpha.ravel() > 0) & (result[:, 3] == 0)
        result[:, 3] = alpha.ravel()
        # Exact premultiplied fallback only for explicitly requested coverage:
        # a tiny corner fragment must not become a whole opaque output cell.
        if missing.any():
            for c in range(3):
                sums = _cell_sums(rgba[..., c] * rgba[..., 3], xs, ys)
                means = sums / np.maximum(alpha * area, 1e-8)
                result[missing, c] = means.ravel()[missing]
    elif resolved_alpha == "binary":
        result[:, 3] = result[:, 3] >= .5
    result[result[:, 3] <= 0, :3] = 0
    return CellResult(result.reshape(ny, nx, 4), confidence.reshape(ny, nx),
                      dict(supported_central_strokes=detail_count, rejected_central_impulses=rejected_count,
                           samples_per_cell=len(fractions)**2, alpha_mode_requested=alpha_mode,
                           alpha_mode=resolved_alpha, source_near_opaque_fraction=near_opaque,
                           contour_expansion=False))


def render_cells(rgba, grid, config):
    """Average smooth regions; retain centre-supported colours at strong boundaries.

    Statistics use premultiplied colour. Default alpha remains sampled, so an
    intersecting opaque shape never fills an otherwise transparent whole cell.
    The original recovery sampler is not modified.
    """
    cells = recover_cells(rgba, grid.x_lines, grid.y_lines, config.sampling,
                          alpha_mode=config.alpha_mode)
    cells.structure['rendering'] = 'ordinary image'
    if config.sampling != 'robust':
        return cells
    xs, ys = np.rint(grid.x_lines).astype(int), np.rint(grid.y_lines).astype(int)

    if rgba.shape[0] * rgba.shape[1] > DENSE_PIXEL_LIMIT:
        # Only generated rendering grids use bounded color statistics. Recovered
        # grids continue to use the original sampler. Keep center alpha/strokes.
        ny, nx = cells.rgba.shape[:2]
        fractions = (np.arange(8) + .5) / 8
        xx = _sample_positions(xs, fractions)
        yy = _sample_positions(ys, fractions)
        smooth_count = 0
        flat = cells.rgba.reshape(-1, 4)
        for start in range(0, ny * nx, 512):
            ids = np.arange(start, min(start + 512, ny * nx))
            samples = rgba[yy[ids // nx, :, None], xx[ids % nx, None, :]].reshape(-1, 64, 4)
            a = samples[..., 3:]
            mass = np.maximum(a.sum(axis=1), 1e-8)
            rgb = samples[..., :3]
            mean = (rgb * a).sum(axis=1) / mass
            variance = np.maximum(0, (rgb * rgb * a).sum(axis=1) / mass - mean * mean).max(axis=1)
            # A thin center stroke/highlight can lie between the area samples.
            # Its supported center must veto averaging even with low sample variance.
            agrees = np.max(abs(flat[ids, :3] - mean), axis=1) < .12
            smooth = (variance < .06 ** 2) & agrees & (flat[ids, 3] > 0)
            flat[ids[smooth], :3] = mean[smooth]
            smooth_count += int(smooth.sum())
        cells.structure.update(rendering_sampler='64 area samples in smooth regions; supported centre at boundaries',
                               rendering_samples_per_cell=64, averaged_smooth_cells=smooth_count)
        return cells

    alpha = rgba[..., 3]
    mass = _cell_sums(alpha, xs, ys)
    means = np.zeros_like(cells.rgba[..., :3])
    variance = np.zeros_like(mass)
    for channel in range(3):
        values = rgba[..., channel]
        mean = _cell_sums(values * alpha, xs, ys) / np.maximum(mass, 1e-8)
        variance = np.maximum(variance, _cell_sums(values * values * alpha, xs, ys) / np.maximum(mass, 1e-8) - mean * mean)
        means[..., channel] = mean
    smooth = (variance < .06 ** 2) & (cells.rgba[..., 3] > 0)
    cells.rgba[smooth, :3] = means[smooth]
    cells.rgba[cells.rgba[..., 3] == 0, :3] = 0
    cells.structure.update(rendering_sampler='area in smooth regions; supported centre at boundaries',
                           averaged_smooth_cells=int(smooth.sum()))
    return cells


# Color spaces and perceptual distances

def rgb_to_lab(rgb):
    rgb = np.asarray(rgb, dtype=np.float64) / 255.
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[.4124564, .2126729, .0193339],
                             [.3575761, .7151522, .1191920],
                             [.1804375, .0721750, .9503041]])
    xyz /= [.95047, 1., 1.08883]
    d = 6 / 29
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4 / 29)
    x, y, z = np.moveaxis(f, -1, 0)
    return np.stack((116 * y - 16, 500 * (x - y), 200 * (y - z)), axis=-1)


def delta_e_2000(first, second):
    """Broadcast arrays ending in three Lab components; return perceptual distance."""
    l1, a1, b1 = np.moveaxis(np.asarray(first, dtype=np.float64), -1, 0)
    l2, a2, b2 = np.moveaxis(np.asarray(second, dtype=np.float64), -1, 0)
    cbar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = .5 * (1 - np.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7)))
    ap1, ap2 = (1 + g) * a1, (1 + g) * a2
    c1, c2 = np.hypot(ap1, b1), np.hypot(ap2, b2)
    h1 = np.mod(np.degrees(np.arctan2(b1, ap1)), 360)
    h2 = np.mod(np.degrees(np.arctan2(b2, ap2)), 360)
    zero = c1 * c2 == 0
    dh = h2 - h1
    # Tolerance makes exactly opposite hues stable under floating-point rounding.
    dh = np.where(dh > 180 + 1e-12, dh - 360, np.where(dh < -180 - 1e-12, dh + 360, dh))
    dh = np.where(zero, 0, dh)
    dl, dc = l2 - l1, c2 - c1
    dh_term = 2 * np.sqrt(c1 * c2) * np.sin(np.radians(dh / 2))
    lm, cm = (l1 + l2) / 2, (c1 + c2) / 2
    hm = np.where(np.abs(h1 - h2) <= 180 + 1e-12, (h1 + h2) / 2,
                  np.where(h1 + h2 < 360, (h1 + h2 + 360) / 2, (h1 + h2 - 360) / 2))
    hm = np.where(zero, h1 + h2, hm)
    t = (1 - .17 * np.cos(np.radians(hm - 30)) + .24 * np.cos(np.radians(2 * hm))
         + .32 * np.cos(np.radians(3 * hm + 6)) - .20 * np.cos(np.radians(4 * hm - 63)))
    sl = 1 + .015 * (lm - 50) ** 2 / np.sqrt(20 + (lm - 50) ** 2)
    sc, sh = 1 + .045 * cm, 1 + .015 * cm * t
    rt = -2 * np.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)) * np.sin(
        np.radians(60 * np.exp(-((hm - 275) / 25) ** 2)))
    vl, vc, vh = dl / sl, dc / sc, dh_term / sh
    return np.sqrt(np.maximum(0, vl * vl + vc * vc + vh * vh + rt * vc * vh))


def distances(first, second, mode):
    """Squared distances; inputs already transformed to the selected space."""
    if mode == "natural":
        return delta_e_2000(first, second) ** 2
    return np.sum((first - second) ** 2, axis=-1)


def nearest(points, palette, mode):
    """Exact full-palette search, bounded temporary memory; stable first-index ties."""
    result = np.empty(len(points), dtype=np.int32)
    chunk = max(32, 32768 // max(1, len(palette)))
    for start in range(0, len(points), chunk):
        result[start:start + chunk] = np.argmin(
            distances(points[start:start + chunk, None], palette[None], mode), axis=1)
    return result


# Optional palette and color-count postprocessing

@lru_cache(maxsize=1)
def _libraries():
    return json.loads(Path(__file__).with_name("palettes.json").read_text(encoding="utf-8"))["palettes"]


def palette_catalog():
    return [dict(id=p["id"], name=f"{p['brand']}-{p['nominal_size']}色",
                 brand=p["brand"], nominal_size=p["nominal_size"], entries=len(p["colors"]),
                 unique_colors=len({c["hex"].upper() for c in p["colors"]})) for p in _libraries()]


def palette_rgb(name):
    validate_color_options(None, name, "natural")
    if name is None:
        raise ValueError("a palette name is required")
    p = next(p for p in _libraries() if p["id"] == name)
    # Multiple bead IDs may have the same RGB; these are one image color.
    hexes = dict.fromkeys(c["hex"].upper().lstrip("#") for c in p["colors"])
    return np.array([[int(h[i:i + 2], 16) for i in (0, 2, 4)] for h in hexes], dtype=np.uint8)


def _space(rgb, mode):
    return rgb_to_lab(rgb) if mode == "natural" else np.asarray(rgb, dtype=np.float64)


def _representatives(rgb, weights, budget=2048):
    """Bound adaptive clustering using RGB bins, each represented by a real input color."""
    if len(rgb) <= budget:
        return rgb, weights
    for shift in (3, 4, 5):
        bins, inv = np.unique(rgb >> shift, axis=0, return_inverse=True)
        if len(bins) <= budget:
            break
    # Highest-support real color per bin, with original RGB order breaking ties.
    order = np.lexsort((np.arange(len(rgb)), -weights, inv))
    first = np.r_[True, inv[order][1:] != inv[order][:-1]]
    return rgb[order[first]], np.bincount(inv, weights=weights)


def _select_palette(rgb, weights, count, mode):
    """Deterministic weighted, constrained clustering; at most eight refinement rounds.

    Frequency/diversity seeds keep small contrasting colors eligible. Centers are
    snapped to real members; accept a move only if it lowers the selected metric.
    This is a bounded engineering heuristic, not an optimal K-color solution.
    """
    if len(rgb) <= count:
        return rgb
    points = _space(rgb, mode)
    selected = [int(np.argmax(weights))]
    best = distances(points, points[selected[0]], mode)
    log_weights = np.log1p(weights)
    for _ in range(1, count):
        priority = best * log_weights
        priority[selected] = -1
        index = int(np.argmax(priority))
        selected.append(index)
        best = np.minimum(best, distances(points, points[index], mode))
    selected = np.array(selected)
    for _ in range(8):
        assignment = nearest(points, points[selected], mode)
        previous = selected.copy()
        for cluster in range(count):
            members = np.flatnonzero(assignment == cluster)
            if not len(members):
                continue
            mean = np.average(points[members], axis=0, weights=weights[members])
            candidate = members[np.argmin(distances(points[members], mean, mode))]
            old_cost = np.dot(weights[members], distances(points[members], points[selected[cluster]], mode))
            new_cost = np.dot(weights[members], distances(points[members], points[candidate], mode))
            if new_cost < old_cost - 1e-9:
                selected[cluster] = candidate
        if np.array_equal(previous, selected):
            break
    return rgb[np.unique(selected)]


def process_colors(image, *, colors=None, palette=None, color_mode="natural", no_semitransparent=False):
    """Postprocess a restored image; optionally binarize alpha before matching colors.

    No options is an exact no-op. Palette matching and final remapping
    both use the requested distance. Fully transparent RGB has no statistical vote.
    """
    validate_color_options(colors, palette, color_mode, no_semitransparent)
    start = perf_counter()
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")
    if colors is None and palette is None and not no_semitransparent:
        return ColorResult(image.copy(), dict(applied=False, palette=None, limit=None,
                           mode=color_mode), perf_counter() - start)
    rgba = np.array(image.convert("RGBA"))
    # The source used for grid detection and sampling is never modified.
    if no_semitransparent:
        rgba[..., 3] = np.where(rgba[..., 3] >= 192, 255, 0)
    visible = rgba[..., 3] > 0
    rgb, inv = np.unique(rgba[visible, :3], axis=0, return_inverse=True)
    count_before = len(rgb)
    # Transparent pixels have no palette vote; retained coverage weights colors.
    weights = np.bincount(inv, weights=rgba[visible, 3].astype(float) / 255., minlength=len(rgb))
    if len(rgb):
        if palette:
            available = palette_rgb(palette)
            matched = nearest(_space(rgb, color_mode), _space(available, color_mode), color_mode)
            used, inverse = np.unique(matched, return_inverse=True)
            candidates = available[used]
            support = np.bincount(inverse, weights=weights, minlength=len(used))
            if colors is not None and len(candidates) > colors:
                reduced = _select_palette(candidates, support, colors, color_mode)
                remap = nearest(_space(candidates, color_mode), _space(reduced, color_mode), color_mode)
                mapped = reduced[remap[inverse]]
            else:
                mapped = available[matched]
        elif colors is not None and len(rgb) > colors:
            candidates, support = _representatives(rgb, weights)
            reduced = _select_palette(candidates, support, colors, color_mode)
            mapped = reduced[nearest(_space(rgb, color_mode), _space(reduced, color_mode), color_mode)]
        else:
            mapped = rgb
        rgba[visible, :3] = mapped[inv]
        count_after = len(np.unique(mapped, axis=0))
    else:
        count_after = 0
    rgba[~visible, :3] = 0
    result = Image.fromarray(rgba if image.mode == "RGBA" else rgba[..., :3])
    info = dict(applied=True, palette=palette, limit=colors, mode=color_mode,
                input_colors=count_before, output_colors=count_after)
    if no_semitransparent:
        info.update(no_semitransparent=True, alpha_threshold=192)
    if palette:
        info["library"] = next(p for p in palette_catalog() if p["id"] == palette)
    return ColorResult(result, info, perf_counter() - start)


def quantize_cells(cells, colors, *, palette=None, color_mode="natural"):
    """Compatibility helper for callers processing float CellResult arrays."""
    result = process_colors(to_pil(cells.rgba), colors=colors, palette=palette, color_mode=color_mode)
    rgba = cells.rgba.copy()
    unchanged = palette is None and (colors is None or result.diagnostics["input_colors"] <= colors)
    if not unchanged:
        rgba[..., :3] = np.asarray(result.image)[..., :3] / 255.
    rgba[rgba[..., 3] == 0, :3] = 0
    return replace(cells, rgba=rgba)
