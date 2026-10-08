"""Extract source-image evidence, recover grid cuts, and choose a fallback grid.

Sections follow the processing order: original-resolution evidence, candidate
fitting, validation and native-pixel protection, then ordinary-image routing.
"""
from dataclasses import dataclass, field, replace
import math

import numpy as np

from .config import DENSE_PIXEL_LIMIT

_MIN_GRID_SCORE = .30


# Original-resolution edge and Fourier evidence.

def smooth(values, radius=1):
    kernel = np.array([1., 2., 1.]) if radius == 1 else np.ones(2 * radius + 1)
    return np.convolve(np.pad(values, (radius, radius), mode="edge"), kernel / kernel.sum(), "valid")


def _scan_positions(length, limit):
    """Evenly spaced source indices; count <= length already guarantees uniqueness."""
    return np.linspace(0, length - 1, min(limit, length)).astype(int)


def peaks(values, threshold=0.):
    """Represent flat local maxima by their midpoint."""
    if len(values) < 3:
        return np.empty(0, int)
    changes = np.flatnonzero(np.diff(values) != 0) + 1
    starts, ends = np.r_[0, changes], np.r_[changes, len(values)]
    inside = (starts > 0) & (ends < len(values))
    starts, ends = starts[inside], ends[inside]
    valid = ((values[starts] > values[starts - 1]) & (values[starts] > values[ends])
             & (values[starts] >= threshold))
    return ((starts[valid] + ends[valid] - 1) // 2).astype(int)


def axis_segment_evidence(rgba, spacing):
    """Measure straight, axis-aligned edge runs on at most nine source patches.

    Original pixels are never resized. Centred, tangentially smoothed derivatives
    distinguish a diagonal staircase from an actual horizontal/vertical segment.
    This is supporting evidence, not a pixel-art classifier.
    """
    h, w = rgba.shape[:2]
    ph, pw = min(h, 130), min(w, 130)
    if min(ph, pw) < 5:
        return dict(active_patches=0, sampled_pixels=0, patches=[])
    yy = np.linspace(0, h - ph, min(3, max(1, h // ph))).astype(int)
    xx = np.linspace(0, w - pw, min(3, max(1, w // pw))).astype(int)
    origins = [(int(x), int(y)) for y in yy for x in xx]
    values = np.stack([rgba[y:y+ph, x:x+pw] for x, y in origins])
    values[..., :3] *= values[..., 3:]
    gx = np.zeros((len(origins), ph-2, pw-2), np.float32)
    gy = np.zeros_like(gx)
    for channel in range(4):
        v = values[..., channel]
        dx = (v[:, :, 2:] - v[:, :, :-2]) * .5
        dy = (v[:, 2:, :] - v[:, :-2, :]) * .5
        np.maximum(gx, abs((dx[:, :-2] + 2*dx[:, 1:-1] + dx[:, 2:]) * .25), out=gx)
        np.maximum(gy, abs((dy[:, :, :-2] + 2*dy[:, :, 1:-1] + dy[:, :, 2:]) * .25), out=gy)
    strength = np.maximum(gx, gy)
    threshold = np.maximum(.012, np.minimum(.04, .15*strength.max(axis=(1, 2))))[:, None, None]
    strong = strength >= threshold
    vertical = strong & (gx >= 3*gy)
    horizontal = strong & (gy >= 3*gx)

    def sustained(mask, length, axis):
        padding = [(0, 0)] * 3
        padding[axis] = (length // 2 + 1, (length - 1) // 2)
        total = np.cumsum(np.pad(mask, padding), axis=axis, dtype=np.int32)
        first, last = [slice(None)]*3, [slice(None)]*3
        first[axis], last[axis] = slice(None, -length), slice(length, None)
        count = total[tuple(last)] - total[tuple(first)]
        return mask & (count >= length - (1 if length >= 6 else 0))

    lengths = [max(3, min(16, round(.5*s))) for s in spacing]
    vr = sustained(vertical, lengths[1], 1)
    hr = sustained(horizontal, lengths[0], 2)
    mass = np.minimum(strength, .2) * strong
    patches = []
    for index, origin in enumerate(origins):
        count = int(strong[index].sum())
        weight = float(mass[index].sum())
        denom = max(weight, 1e-9)
        patches.append(dict(origin=list(origin), edges=count, mass=weight,
                            vertical=float(mass[index][vr[index]].sum() / denom),
                            horizontal=float(mass[index][hr[index]].sum() / denom),
                            axis_aligned=float(mass[index][vertical[index] | horizontal[index]].sum() / denom)))
    active = [p for p in patches if p['edges'] >= 32 and p['mass'] >= 1.]
    return dict(sampled_pixels=int(values.shape[0]*ph*pw), patch_size=[pw, ph],
                run_length=lengths, active_patches=len(active), patches=patches,
                segment_fraction=float(np.mean([p['vertical']+p['horizontal'] for p in active])) if active else 0.,
                axis_fraction=float(np.mean([p['axis_aligned'] for p in active])) if active else 0.)


@dataclass
class FeatureData:
    gradient_x: np.ndarray
    gradient_y: np.ndarray
    profile_x: np.ndarray
    profile_y: np.ndarray
    spectrum: np.ndarray
    spectral_x: np.ndarray
    spectral_y: np.ndarray
    curvature_x: np.ndarray
    curvature_y: np.ndarray
    ramp_ratio: tuple
    native_axes: tuple
    mode: str = 'full image'
    spectrum_size: tuple | None = None
    preview_edges: tuple | None = None


def _native_axis(scanlines):
    """Count one-pixel contrast reversals on original-resolution alpha-aware strips.

    A-B-C votes only where B leaves the interval between A and C in at least one
    premultiplied channel. Smooth monotone edge ramps do not vote.
    """
    values = scanlines.copy()
    values[..., :3] *= values[..., 3:]
    delta = np.diff(values, axis=1)
    edges = np.max(np.abs(delta), axis=-1) > .06
    reversal = np.max((np.abs(delta[:, :-1]) + np.abs(delta[:, 1:])
                       - np.abs(delta[:, :-1] + delta[:, 1:])) * .5, axis=-1) > .06
    counts = reversal.sum(axis=1)
    return dict(edge_count=int(edges.sum()), turn_count=int(counts.sum()),
                turn_fraction=float(counts.sum() / max(1, edges.sum())),
                supporting_lines=int(np.count_nonzero(counts >= 2)),
                active_lines=int(np.count_nonzero(edges.sum(axis=1) >= 4)))


def _log_spectrum(gray, block=64):
    """Exact separable 2-D FFT, with bounded transform temporaries.

    Keep complex128 precision and every source pixel. NumPy's rfft2 otherwise
    holds multiple image-sized complex arrays during its second transform.
    """
    h, w = gray.shape
    horizontal = np.empty((h, w // 2 + 1), np.complex128)
    for start in range(0, h, block):
        horizontal[start:start + block] = np.fft.rfft(gray[start:start + block], axis=1)
    # Match rfft2's column-major result, including the reduction order used by
    # spectral_x/y. Changing layout can otherwise perturb float32 mean scores.
    spectrum = np.empty(horizontal.shape, np.float32, order='F')
    for start in range(0, horizontal.shape[1], block):
        transformed = np.fft.fft(horizontal[:, start:start + block], axis=0)
        magnitude = np.abs(transformed)
        del transformed
        np.log1p(magnitude, out=magnitude)
        spectrum[:, start:start + block] = magnitude
    return spectrum


def _scanline_features(scanlines):
    """Full-length source lines: their spacing remains in original pixels."""
    values = scanlines.copy()
    values[..., :3] *= values[..., 3:]
    gradient = np.zeros(values.shape[:2], np.float32)
    curvature = np.zeros_like(gradient)
    gray = np.zeros_like(gradient)
    for c, weight in enumerate((.299, .587, .114, 0.)):
        v = values[..., c]
        np.maximum(gradient[:, 1:], abs(np.diff(v, axis=1)), out=gradient[:, 1:])
        np.maximum(curvature[:, 1:-1], abs(np.diff(v, n=2, axis=1)), out=curvature[:, 1:-1])
        gray += weight * v
    gray += .5 * (1 - values[..., 3])
    spectral = np.log1p(abs(np.fft.rfft(gray, axis=1))).mean(axis=0).astype(np.float32)
    return gradient, smooth(np.minimum(gradient, .35).mean(axis=0)), spectral, \
        smooth(curvature.mean(axis=0)), float(curvature.sum() / max(float(gradient.sum()), 1e-9))


def _sparse_features(rgba):
    h, w = rgba.shape[:2]
    rows = _scan_positions(h, 96)
    cols = _scan_positions(w, 96)
    horizontal, vertical = rgba[rows], rgba[:, cols].transpose(1, 0, 2)
    gx, px, sx, cx, rx = _scanline_features(horizontal)
    gy, py, sy, cy, ry = _scanline_features(vertical)
    axes = (_native_axis(horizontal), _native_axis(vertical))
    del horizontal, vertical
    # A genuine 2-D FFT of a bounded source patch is for visualization only.
    # Candidate periods come from the full-length source lines above.
    ph, pw = min(h, 512), min(w, 512)
    patch = rgba[(h-ph)//2:(h+ph)//2, (w-pw)//2:(w+pw)//2]
    gray = np.zeros((ph, pw), np.float32)
    for c, weight in enumerate((.299, .587, .114)):
        gray += weight * (patch[..., c] * patch[..., 3])
    gray += .5 * (1 - patch[..., 3])
    spectrum = _log_spectrum(gray)
    # Display original derivatives at bounded preview positions, not derivatives
    # of a resized image. This does not feed the detector.
    ratio = min(1., 1024 / max(h, w))
    nx, ny = max(1, round(w * ratio)), max(1, round(h * ratio))
    xx = ((np.arange(nx) + .5) * w / nx).astype(int)
    yy = ((np.arange(ny) + .5) * h / ny).astype(int)
    centre = rgba[np.ix_(yy, xx)].copy()
    left = rgba[np.ix_(yy, np.maximum(xx-1, 0))].copy()
    top = rgba[np.ix_(np.maximum(yy-1, 0), xx)].copy()
    for samples in (centre, left, top):
        samples[..., :3] *= samples[..., 3:]
    ex, ey = np.max(abs(centre-left), axis=2), np.max(abs(centre-top), axis=2)
    return FeatureData(gx, gy.T, px, py, spectrum, sx, sy, cx, cy, (rx, ry), axes,
                       mode='96 original-resolution scanlines per axis', spectrum_size=(pw, ph), preview_edges=(ex, ey))


def extract_features(rgba):
    if rgba.shape[0] * rgba.shape[1] > DENSE_PIXEL_LIMIT:
        return _sparse_features(rgba)
    alpha = rgba[..., 3]
    gx = np.zeros(alpha.shape, np.float32)
    gy = np.zeros_like(gx)
    gray = np.zeros_like(gx)
    # Original-resolution scanlines: second derivatives locate interpolation
    # knots when wide bilinear ramps have no sharp first-derivative maximum.
    rows = _scan_positions(len(alpha), 64)
    cols = _scan_positions(alpha.shape[1], 64)
    cx = np.zeros((len(rows), alpha.shape[1]), np.float32)
    cy = np.zeros((alpha.shape[0], len(cols)), np.float32)
    # Compute the same full-resolution gradients in stripes. The one-row halo
    # retains derivatives at stripe boundaries; no resize or sampled grid signal.
    for start in range(0, len(alpha), 64):
        end = min(start + 64, len(alpha))
        top = max(0, start - 1)
        a = alpha[top:end]
        for channel, weight in enumerate((.299, .587, .114, 0.)):
            v = rgba[top:end, :, channel] * a if channel < 3 else a
            local = v[start - top:]
            target = gx[start:end, 1:]
            np.maximum(target, np.abs(np.diff(local, axis=1)), out=target)
            target = gy[max(1, start):end]
            np.maximum(target, np.abs(np.diff(v, axis=0)), out=target)
            gray[start:end] += weight * local
        gray[start:end] += .5 * (1 - alpha[start:end])
    # Premultiplied original-resolution strips retain the curvature evidence.
    for channel, weight in enumerate((.299, .587, .114, 0.)):
        vx = rgba[rows, :, channel] * alpha[rows] if channel < 3 else alpha[rows]
        vy = rgba[:, cols, channel] * alpha[:, cols] if channel < 3 else alpha[:, cols]
        cx[:, 1:-1] = np.maximum(cx[:, 1:-1], np.abs(np.diff(vx, n=2, axis=1)))
        cy[1:-1] = np.maximum(cy[1:-1], np.abs(np.diff(vy, n=2, axis=0)))
    # Reuse this real-input 2-D FFT for detection and the diagnostic image.
    spectrum = _log_spectrum(gray)
    del gray
    sx = spectrum[1:].mean(axis=0) if len(spectrum) > 1 else spectrum[0]
    sy = spectrum[:, 1:].mean(axis=1) if spectrum.shape[1] > 1 else spectrum[:, 0]
    px = smooth(np.minimum(gx, .35).mean(axis=0))
    py = smooth(np.minimum(gy, .35).mean(axis=1))
    ratio = (float(cx.sum() / max(float(gx[rows].sum()), 1e-9)),
             float(cy.sum() / max(float(gy[:, cols].sum()), 1e-9)))
    return FeatureData(gx, gy, px, py, spectrum, sx, sy[:len(sy) // 2 + 1],
                       smooth(cx.mean(axis=0)), smooth(cy.mean(axis=1)), ratio,
                       (_native_axis(rgba[rows]), _native_axis(rgba[:, cols].transpose(1, 0, 2))))


# Candidate grids: proposals, phase fitting and cut placement.

@dataclass
class GridCandidate:
    """A source-coordinate lattice and the evidence used to select it."""

    sx: float
    sy: float
    phase_x: float
    phase_y: float
    x_lines: np.ndarray
    y_lines: np.ndarray
    support: float = 0.
    warped: bool = False
    metadata: dict = field(default_factory=dict)

    @property
    def has_protected_evidence(self):
        """Native detail and validated resampling override weak-grid checks."""
        return bool(self.metadata.get("native_preserved") or self.metadata["source"] in (
            "validated interpolation knots", "exact two-pixel repetition",
            "validated integer repetition"))

    @property
    def has_repeated_boundaries(self):
        """Both axes repeat cell intervals or align with the proposed lattice."""
        metrics = self.metadata.get("axis_metrics", [])
        if len(metrics) != 2:
            return False
        unit_support = min(metric["unit_gaps"] for metric in metrics)
        alignment = min(metric["edge_fit"] for metric in metrics)
        return unit_support > .45 or (alignment > .65 and unit_support > .30)


def make_lines(length, spacing, phase=0.):
    inside = np.arange(phase - spacing, length + spacing, spacing)
    inside = inside[(inside >= max(.5, .2 * spacing)) & (inside <= length - max(.5, .2 * spacing))]
    return np.r_[0., inside, float(length)]


def _target_axis(profile, count, allow_warp):
    """Fit an exact number of cells with bounded, edge-aware source cuts.

    A global phase initializes the cuts. A small dynamic program can then move
    each cut by at most 45% of nominal spacing while penalizing uneven gaps.
    All cuts are integer source coordinates; endpoints keep the full image.
    """
    length = len(profile)
    spacing = length / count
    regular = [round(k * spacing) for k in range(count + 1)]
    baseline = float(np.min(profile))
    amplitude = float(np.max(profile)) - baseline
    positions = [int(p) for p in peaks(profile, baseline + max(.0008, amplitude * .16))]
    empty = dict(lines=regular, phase=0., support=0., warped=False,
                 metrics=dict(peaks=len(positions), edge_fit=0., mean_shift=0., optimized=False))
    if count == 1 or count == length or amplitude <= .0008 or not positions:
        return empty
    evidence = [(float(value) - baseline) / amplitude for value in profile]
    position_values = np.array(positions, dtype=float)
    axis = dict(pos=position_values, weights=np.array([evidence[p] for p in positions]))
    radius = .45 * spacing

    def gap_cost(left, right):
        return .35 * ((right - left - spacing) / spacing) ** 2

    def node_cost(position, anchor):
        return -evidence[position] + .12 * ((position - anchor) / spacing) ** 2

    def bounds(k):
        # Rounding must leave a valid position even when spacing is near one.
        return (max(k, min(regular[k], math.ceil(k * spacing - radius))),
                min(length - count + k, max(regular[k], math.floor(k * spacing + radius))))

    phase = _phase(axis, spacing)
    fitted = min(radius, max(-radius, round((phase - spacing if phase > spacing / 2 else phase) * 8) / 8))
    shifts = sorted(set([0., fitted] + [float(v) for v in np.linspace(-radius, radius, 17)]))
    best_cost, global_cuts, global_phase = math.inf, regular, 0.
    for shift in shifts:
        cuts, cost = [0], 0.
        for k in range(1, count):
            lo, hi = bounds(k)
            position = min(hi, max(lo, round(k * spacing + shift)))
            cuts.append(position)
            cost += node_cost(position, k * spacing) + gap_cost(cuts[k - 1], position)
        cost += gap_cost(cuts[-1], length)
        if cost < best_cost - 1e-12:
            best_cost, global_cuts, global_phase = cost, cuts + [length], shift
    lines = global_cuts
    if allow_warp and spacing >= 2:
        candidates, parents, previous_cost = [[0]], [[-1]], [0.]
        for k in range(1, count):
            lo, hi = bounds(k)
            if hi - lo < 17:
                choices = list(range(lo, hi + 1))
            else:
                left, right = np.searchsorted(position_values, [lo, hi + 1])
                local = sorted(positions[left:right], key=lambda p: (-evidence[p], p))[:7]
                choices = sorted(set([round(float(p)) for p in np.linspace(lo, hi, 9)]
                                     + local + [global_cuts[k]]))
            scores, back = [math.inf] * len(choices), [-1] * len(choices)
            for j, position in enumerate(choices):
                unary = node_cost(position, global_cuts[k])
                for i, previous in enumerate(candidates[k - 1]):
                    if previous >= position:
                        continue
                    score = previous_cost[i] + unary + gap_cost(previous, position)
                    if score < scores[j] - 1e-12:
                        scores[j], back[j] = score, i
            candidates.append(choices)
            parents.append(back)
            previous_cost = scores
        last, best_cost = 0, math.inf
        for i, cost in enumerate(previous_cost):
            score = cost + gap_cost(candidates[-1][i], length)
            if score < best_cost - 1e-12:
                best_cost, last = score, i
        lines = [0] * count + [length]
        for k in range(count - 1, -1, -1):
            lines[k], last = candidates[k][last], parents[k][last]
    tolerance = max(.65, .14 * spacing)
    total, weight = 0., 0.
    line_values = np.array(lines, dtype=float)
    for position in positions:
        upper = min(count, max(1, int(np.searchsorted(line_values, position))))
        distance = min(abs(position - lines[upper]), abs(position - lines[upper - 1]))
        total += evidence[position] * math.exp(-.5 * (distance / tolerance) ** 2)
        weight += evidence[position]
    chance = min(.85, 2.5066 * tolerance / spacing)
    support = min(1., max(0., (total / weight - chance) / (1 - chance)))
    return dict(lines=lines, phase=global_phase, support=support, warped=lines != global_cuts,
                metrics=dict(peaks=len(positions), edge_fit=support,
                             mean_shift=sum(abs(v - regular[k + 1]) for k, v in enumerate(lines[1:-1])) / (count - 1),
                             optimized=True))


def fit_target_grid(features, shape, config):
    """Use target dimensions as a cell-count constraint, then fit source edges."""
    h, w = shape[:2]
    nx, ny = config.target_size
    axes = [_target_axis(features.profile_x, nx, config.local_warp == "auto"),
            _target_axis(features.profile_y, ny, config.local_warp == "auto")]
    support = sum(axis['support'] for axis in axes) / 2
    metadata = dict(source='fixed target grid', fixed_size=True, target_size=[nx, ny],
                    axis_metrics=[axis['metrics'] for axis in axes])
    grid = GridCandidate(w / nx, h / ny, axes[0]['phase'], axes[1]['phase'],
                         np.array(axes[0]['lines'], dtype=float), np.array(axes[1]['lines'], dtype=float),
                         support, any(axis['warped'] for axis in axes), metadata)
    report = dict(mode='fixed target grid', fixed_size=True, target_size=[nx, ny], selected_score=support,
                  evidence_model='colour boundaries with fixed cell count', axis_evidence=metadata['axis_metrics'],
                  axis_segments=dict(checked=False, decision='fixed target constraint'),
                  fixed_grid=dict(max_displacement=.45, max_candidates_per_cut=17, displacement_weight=.12,
                                  gap_weight=.35, local_warp=config.local_warp, full_coverage=True))
    return grid, report


def _axis(profile, spectrum, minimum, maximum):
    pos = peaks(profile, max(float(profile.max()) * .16, .0008))
    # Quantized bilinear ramps contain several almost equal maxima. Treat a
    # plateau with no meaningful valley as ONE edge, located at its midpoint.
    # Otherwise the tiny ripple gaps wrongly vote for half-sized cells.
    groups = []
    for p in pos:
        if groups and np.min(profile[groups[-1][-1]:p + 1]) >= .90 * min(profile[groups[-1][-1]], profile[p]):
            groups[-1].append(p)
        else:
            groups.append([p])
    pos = np.array([(g[0] + g[-1]) / 2 for g in groups], dtype=float)
    weights = np.interp(pos, np.arange(len(profile)), profile)
    gaps = np.diff(pos).astype(float)
    gap_weights = np.minimum(weights[:-1], weights[1:])
    proposals = []
    if len(gaps) and maximum >= minimum:
        steps = np.arange(minimum, maximum + .125, .25)
        density = np.array([np.sum(gap_weights * np.exp(-.5 * ((gaps - s) / max(.65, .09 * s)) ** 2))
                            for s in steps])
        ix = peaks(np.r_[-1., density, -1.]) - 1
        for k in ix[np.argsort(density[ix], kind="stable")[-3:][::-1]]:
            proposals.append((float(steps[k]), "edge gaps"))
    power = np.abs(np.fft.rfft(profile - profile.mean()))
    freq = peaks(power)
    freq = freq[(freq > 0) & (len(profile) / freq >= minimum) & (len(profile) / freq <= maximum)]
    for k in freq[np.argsort(power[freq], kind="stable")[-3:][::-1]]:
        proposals.append((len(profile) / float(k), "edge FFT"))
    # Repeated block shapes have spectral troughs near reciprocal block widths.
    log_profile = smooth(smooth(spectrum))
    trough = smooth(log_profile, 12) - log_profile
    freq = peaks(trough)
    freq = freq[(freq > 0) & (len(profile) / freq >= minimum) & (len(profile) / freq <= maximum)]
    for k in freq[np.argsort(trough[freq], kind="stable")[-4:][::-1]]:
        proposals.append((len(profile) / float(k), "image FFT trough"))
    return dict(profile=profile, pos=pos, weights=weights, gaps=gaps, gap_weights=gap_weights,
                power=power, trough=trough, proposals=proposals, contrast=float((np.percentile(profile, 95) - np.percentile(profile, 20)) / max(np.percentile(profile, 95), 1e-9)))


def _phase(axis, spacing):
    pos, weights = axis["pos"], axis["weights"]
    if not len(pos):
        return 0.
    phases = np.linspace(0, spacing, min(64, max(12, int(spacing * 4))), endpoint=False)
    distance = np.abs((pos[None] - phases[:, None] + spacing / 2) % spacing - spacing / 2)
    fit = np.sum(weights * np.exp(-.5 * (distance / max(.6, .12 * spacing)) ** 2), axis=1)
    best = phases[int(np.argmax(fit))]
    for _ in range(2):
        residual = (pos - best + spacing / 2) % spacing - spacing / 2
        keep = np.abs(residual) < max(.8, .2 * spacing)
        if keep.any():
            best = (best + np.average(residual[keep], weights=weights[keep])) % spacing
    return 0. if min(best, spacing - best) < 1e-7 else float(best)


def _walk(axis, spacing, phase, allow_warp):
    length = len(axis["profile"])
    regular = make_lines(length, spacing, phase)
    if not allow_warp or spacing < 3 or len(axis["pos"]) < 4:
        return regular
    pos, weights = axis["pos"], axis["weights"]
    near = np.flatnonzero(np.abs(pos - length / 2) <= spacing)
    if not len(near):
        return regular
    anchor = float(pos[near[np.argmax(weights[near])]])
    cuts = [anchor]
    for direction in (-1, 1):
        current = anchor
        while True:
            predicted = current + direction * spacing
            if predicted <= .2 * spacing or predicted >= length - .2 * spacing:
                break
            lo, hi = np.searchsorted(pos, [predicted - .24 * spacing, predicted + .24 * spacing])
            if hi > lo:
                local = np.arange(lo, hi)
                score = weights[local] * np.exp(-.5 * ((pos[local] - predicted) / (.2 * spacing)) ** 2)
                current = float(pos[local[int(np.argmax(score))]])
            else:
                current = predicted
            cuts.append(current)
    return np.r_[0., sorted(cuts), float(length)]


def _measure(axis, spacing, lines):
    pos, weights = axis["pos"], axis["weights"]
    if len(pos) < 4:
        return dict(score=0., edge_fit=0., unit_gaps=0., fft=0.)
    upper = np.clip(np.searchsorted(lines, pos), 1, len(lines) - 1)
    distance = np.minimum(abs(pos - lines[upper]), abs(pos - lines[upper - 1]))
    tolerance = max(.65, .14 * spacing)
    explained = float(np.average(np.exp(-.5 * (distance / tolerance) ** 2), weights=weights))
    chance = min(.85, 2.5066 * tolerance / spacing)
    explained = max(0., (explained - chance) / (1 - chance))
    gaps, gw = axis["gaps"], axis["gap_weights"]
    units = float(np.average(np.exp(-.5 * ((gaps - spacing) / max(.7, .12 * spacing)) ** 2), weights=gw))
    frequency = len(axis["profile"]) / spacing
    power = axis["power"]
    periodic = float(np.interp(frequency, np.arange(len(power)), power) / max(power[1:].max(initial=0), 1e-9))
    return dict(score=.48 * units + .42 * explained + .10 * periodic,
                edge_fit=explained, unit_gaps=units, fft=periodic)


@dataclass
class _GridFit:
    """Intermediate fit: named fields keep search and diagnostic code aligned."""

    score: float
    sizes: tuple
    source: str
    phases: list
    lines: list
    metrics: list

    def report(self, include_source=False):
        detail = {"spacing": list(self.sizes)}
        if include_source:
            detail["source"] = self.source
        detail.update(score=self.score, axes=self.metrics)
        return detail

    @property
    def rank(self):
        return -self.score, -self.sizes[0]


def _fit_candidate(axes, sizes, source, *, allow_warp=None):
    """Fit phases, cuts and evidence using the same rules for every proposal."""
    phases, lines, metrics = [], [], []
    for axis, spacing in zip(axes, sizes):
        phase = _phase(axis, spacing)
        cuts = (make_lines(len(axis["profile"]), spacing, phase) if allow_warp is None
                else _walk(axis, spacing, phase, allow_warp))
        metrics.append(_measure(axis, spacing, cuts))
        phases.append(phase)
        lines.append(cuts)
    score = float(np.mean([metric["score"] for metric in metrics]))
    return _GridFit(score, sizes, source, phases, lines, metrics)


def _refine_spacing(axes, finalists, shape, config):
    """Try at most five nearby spacings per finalist, keeping its aspect ratio."""
    h, w = shape[:2]
    extra = []
    seen = [fit.sizes for fit in finalists]
    for fit in finalists:
        sizes = fit.sizes
        step = max(.25, round(min(sizes) * .02 * 4) / 4)
        centre = round(sizes[0] / step) * step
        for offset in (-2, -1, 0, 1, 2):
            sx = centre + offset * step
            trial = (sx, sizes[1] * sx / sizes[0])
            if not (config.min_pixel_size <= min(trial) and
                    max(trial) <= min(config.max_pixel_size, w / 2, h / 2)):
                continue
            if any(np.allclose(trial, old, rtol=0., atol=1e-7) for old in seen):
                continue
            seen.append(trial)
            extra.append(_fit_candidate(axes, trial, fit.source + " local spacing refinement",
                                        allow_warp=config.local_warp == "auto"))
    return extra


def _detect_grid(features, shape, config):
    h, w = shape[:2]
    axes = [_axis(p, spec, config.min_pixel_size, min(config.max_pixel_size, n / 2))
            for p, spec, n in [(features.profile_x, features.spectral_x, w),
                               (features.profile_y, features.spectral_y, h)]]
    report = {"axis_proposals": [a["proposals"] for a in axes], "candidates": [],
              "axis_evidence": [{"peaks": len(a["pos"]), "contrast": a["contrast"]} for a in axes]}
    if any(len(a["pos"]) < 4 or a["contrast"] < .25 for a in axes):
        report["rejection"] = "insufficient edge peaks or projection contrast"
        return None, report
    pool = []
    for a in axes:
        for s, origin in a["proposals"]:
            for factor, label in [(1., ""), (.5, " half"), (2., " double")]:
                value = s * factor
                if config.min_pixel_size <= value <= min(config.max_pixel_size, w / 2, h / 2):
                    if not any(abs(value - old[0]) < .08 for old in pool):
                        pool.append((value, origin + label))
    candidates = [((s, s), origin) for s, origin in pool]
    # Accept mildly rectangular spacings only with strong regular evidence
    # in BOTH directions; irregular AI contours keep a common spacing.
    if not config.square:
        best_axes = []
        for axis in axes:
            fits = []
            for spacing, _ in axis["proposals"]:
                phase = _phase(axis, spacing)
                pos, weights = axis["pos"], axis["weights"]
                index = np.rint((pos - phase) / spacing)
                residual = pos - (phase + index * spacing)
                keep = abs(residual) <= max(.7, .18 * spacing)
                if np.count_nonzero(keep) >= 4 and np.ptp(index[keep]) > 0:
                    xx, yy, ww = index[keep], pos[keep], weights[keep]
                    xx = xx - np.average(xx, weights=ww)
                    slope = np.sum(ww * xx * yy) / np.sum(ww * xx * xx)
                    if abs(slope / spacing - 1) < .025:
                        spacing = float(slope)
                phase = _phase(axis, spacing)
                metric = _measure(axis, spacing, make_lines(len(axis["profile"]), spacing, phase))
                fits.append((metric["score"], spacing, metric["edge_fit"]))
            best_axes.append(max(fits, default=(0, 1, 0)))
        bx, by = best_axes
        if min(bx[2], by[2]) > .85 and max(bx[1], by[1]) / min(bx[1], by[1]) <= 1.12:
            if config.min_pixel_size <= min(bx[1],by[1]) and max(bx[1],by[1]) <= config.max_pixel_size:
                candidates.append(((bx[1], by[1]), "strong regular colour edges"))

    ranked = [_fit_candidate(axes, sizes, origin) for sizes, origin in candidates]
    ranked.sort(key=lambda fit: fit.rank)
    finalists = []
    for fit in ranked[:3]:
        refined = [cuts if m["edge_fit"] > .94 else _walk(a, s, phase, config.local_warp == "auto")
                   for a, s, phase, cuts, m in zip(axes, fit.sizes, fit.phases, fit.lines, fit.metrics)]
        metrics = [_measure(axis, spacing, cuts) for axis, spacing, cuts in zip(axes, fit.sizes, refined)]
        score = float(np.mean([metric["score"] for metric in metrics]))
        finalists.append(replace(fit, score=score, lines=refined, metrics=metrics))
    if not finalists:
        report["rejection"] = "no candidate spacing within search range"
        return None, report
    finalists.sort(key=lambda fit: fit.rank)
    # FFT bins/gap modes propose a scale, not a continuous optimum. With drifting
    # contours a small spacing change also changes which local edges _walk uses.
    # Before rejecting a near-threshold result, examine a bounded neighbourhood
    # of the three finalists. Successful existing detections remain untouched.
    initial_score = finalists[0].score
    report["spacing_refinement"] = {"attempted": False, "initial_score": initial_score,
                                    "candidates": []}
    if (.25 <= initial_score < _MIN_GRID_SCORE
            and min(metric["unit_gaps"] for metric in finalists[0].metrics) >= .10):
        extra = _refine_spacing(axes, finalists, shape, config)
        report["spacing_refinement"].update(attempted=True, candidates=[fit.report() for fit in extra])
        # The same acceptance thresholds apply; adding trials is not permission
        # to lower the evidence requirement or report an artificial confidence.
        finalists.extend(fit for fit in extra if min(metric["unit_gaps"] for metric in fit.metrics) >= .10)
        finalists.sort(key=lambda fit: fit.rank)
    best = finalists[0]
    report["candidates"] = [fit.report(include_source=True) for fit in ranked]
    report["refined"] = [fit.report() for fit in finalists]
    report["selected_score"] = best.score
    if best.score < _MIN_GRID_SCORE or min(metric["unit_gaps"] for metric in best.metrics) < .10:
        report["rejection"] = (f"grid score below {_MIN_GRID_SCORE:.2f}" if best.score < _MIN_GRID_SCORE else
                               "unit cell interval support below 0.10 in one axis")
        return None, report
    warped = any(len(c) != len(make_lines(n, s, p)) or not np.allclose(c, make_lines(n, s, p))
                 for c, n, s, p in zip(best.lines, (w, h), best.sizes, best.phases))
    return GridCandidate(*best.sizes, *best.phases, *best.lines, float(np.clip(best.score, 0., 1.)), warped,
                         {"source": best.source, "axis_metrics": best.metrics}), report


def _coarse_grid(features, shape, config):
    edge, report = _detect_grid(features, shape, config)
    report["ramp_curvature_ratio"] = list(features.ramp_ratio)
    report["evidence_model"] = "colour boundaries"
    if max(features.ramp_ratio) >= .65:
        return edge, report
    # A separate, strictly gated observation model: linear interpolation has
    # curvature at source pixel CENTRES, not at cell boundaries. FFT remains
    # only a proposal source; measured curvature must support the lattice.
    linear = replace(features, profile_x=features.curvature_x, profile_y=features.curvature_y)
    knot, alternate = _detect_grid(linear, shape, replace(config, local_warp="off"))
    report["interpolation_search"] = alternate
    if knot is None or knot.support < .65:
        return edge, report
    if min(m["edge_fit"] for m in knot.metadata["axis_metrics"]) < .75:
        return edge, report
    if edge is not None and knot.support < edge.support + .08:
        return edge, report
    knot.phase_x = (knot.phase_x + .5 - knot.sx / 2) % knot.sx
    knot.phase_y = (knot.phase_y + .5 - knot.sy / 2) % knot.sy
    knot.x_lines = make_lines(shape[1], knot.sx, knot.phase_x)
    knot.y_lines = make_lines(shape[0], knot.sy, knot.phase_y)
    knot.metadata["source"] = "validated interpolation knots"
    report["evidence_model"] = "linear interpolation knots"
    report["selected_score"] = knot.support
    return knot, report


def _native_resolution(features, shape, chosen, report):
    """Conservative one-pixel alternative, independent of filename and image size.

    A perfect per-pixel reconstruction error alone would make every photograph
    win. Require repeated sharp one-pixel details in both axes AND weak alignment
    of raw edges to the proposed coarser grid instead.
    """
    axes = features.native_axes
    boundary_fit = []
    if chosen is not None:
        for g, cuts, direction in ((features.gradient_x, chosen.x_lines, 0),
                                   (features.gradient_y, chosen.y_lines, 1)):
            mass = np.minimum(g, .35) * (g > .06)
            profile = mass.sum(axis=direction)
            positions = np.unique(np.clip(np.rint(cuts).astype(int), 0, len(profile) - 1))
            boundary_fit.append(float(profile[positions].sum() / max(float(profile.sum()), 1e-9)))
    sharp = min(features.ramp_ratio) >= 1.6
    detail = all(a['turn_fraction'] >= .08 and a['turn_count'] >= 8
                 and a['supporting_lines'] >= 3 for a in axes)
    coarse_supported = len(boundary_fit) == 2 and min(boundary_fit) >= .80
    # Without a competing grid, sharp reversals alone also describe white or
    # grain noise. Require repeated flat pixel regions alongside those details.
    flat_fraction = [float(np.count_nonzero(g < .005) / g.size)
                     for g in (features.gradient_x, features.gradient_y)]
    preserve = sharp and detail and not coarse_supported and (chosen is not None or min(flat_fraction) > .20)
    report['native_resolution'] = dict(
        axes=list(axes), sharpness_ratio=list(features.ramp_ratio),
        coarse_boundary_fit=boundary_fit, selected=bool(preserve),
        flat_neighbor_fraction=flat_fraction,
        reason=('repeated sharp one-pixel detail' if preserve and chosen is None else
                'one-pixel detail contradicts coarse grid' if preserve else 'insufficient native detail evidence'))
    if not preserve:
        return chosen, report
    report['rejected_coarse_grid'] = None if chosen is None else dict(
        spacing=[chosen.sx, chosen.sy], score=chosen.support, source=chosen.metadata['source'])
    report['evidence_model'] = 'native pixel detail'
    # Preservation does not establish a unique original grid.
    confidence = float(min(.75, .5 + min(a['turn_fraction'] for a in axes)))
    report['selected_score'] = confidence
    h, w = shape[:2]
    return GridCandidate(1., 1., 0., 0., np.arange(w + 1, dtype=float),
                         np.arange(h + 1, dtype=float), confidence,
                         metadata={'source': 'native pixel detail', 'native_preserved': True}), report


def _exact_integer_grid(features, shape, config, *, require_two=False):
    """Find exact repetition from unsmoothed edge coordinates in one scan.

    Projection peaks can hide adjacent cell boundaries behind stronger repeated
    shapes. A common divisor is usable only when every examined nonzero change
    fits it in both axes; even faint interpolation/noise changes invalidate it.
    Only clean 2x repetition can override an accepted grid. Other integer repeats
    rescue a rejected grid. Large-image scanlines retain their restricted scope.
    """
    if require_two and not config.min_pixel_size <= 2 <= config.max_pixel_size:
        return None
    sizes, phases = [], []
    for gradient, axis in ((features.gradient_x, 0), (features.gradient_y, 1)):
        positions = np.flatnonzero(gradient.max(axis=axis) > 1e-6)
        if len(positions) < 4:
            return None
        spacing = int(np.gcd.reduce(np.diff(positions)))
        if require_two and spacing != 2:
            return None
        if spacing < max(2, config.min_pixel_size) or spacing > config.max_pixel_size:
            return None
        sizes.append(float(spacing))
        phases.append(float(positions[0] % spacing))
    if (config.square and sizes[0] != sizes[1]) or max(sizes) / min(sizes) > 1.12:
        return None
    source = ('exact two-pixel repetition' if sizes == [2., 2.]
              else 'validated integer repetition')
    h, w = shape[:2]
    return GridCandidate(*sizes, *phases, make_lines(w, sizes[0], phases[0]),
                         make_lines(h, sizes[1], phases[1]),
                         .95 if features.mode == 'full image' else .85,
                         metadata={'source': source, 'evidence_scope': features.mode})


def detect_grid(features, shape, config):
    chosen, report = _coarse_grid(features, shape, config)
    exact = _exact_integer_grid(features, shape, config, require_two=chosen is not None)
    if exact is not None:
        chosen = exact
        report['evidence_model'] = exact.metadata['source']
        if exact.sx == exact.sy == 2:
            report['exact_two_pixel_grid'] = dict(
                spacing=[2., 2.], phase=[exact.phase_x, exact.phase_y], score=exact.support,
                all_changes_aligned=features.mode == 'full image', evidence_scope=features.mode)
        else:
            report['integer_repetition'] = dict(
                spacing=[exact.sx, exact.sy], phase=[exact.phase_x, exact.phase_y],
                evidence_scope=features.mode)
        report['selected_score'] = exact.support
    return _native_resolution(features, shape, chosen, report)


def validate_grid_segments(rgba, features, chosen, report):
    """Let distributed non-axis-aligned contours veto an already weak lattice.

    Strong grids and native/resampling evidence take precedence. Too few edges
    abstain; a positive segment result never creates a grid or inflates its score.
    """
    evidence = dict(checked=False, decision='unchanged')
    report['axis_segments'] = evidence
    if chosen is None:
        evidence['reason'] = 'no candidate grid to validate'
        return chosen
    if chosen.has_protected_evidence or min(chosen.sx, chosen.sy) < 3:
        evidence['reason'] = 'native pixels or validated resampling grid take precedence'
        return chosen
    if chosen.support >= .45 or chosen.has_repeated_boundaries:
        evidence['reason'] = 'strong existing grid evidence takes precedence'
        return chosen
    if min(features.ramp_ratio) < 1.25:
        evidence['reason'] = 'soft boundaries; missing straight runs are inconclusive'
        return chosen
    evidence.update(axis_segment_evidence(rgba, (chosen.sx, chosen.sy)), checked=True)
    active = [p for p in evidence['patches'] if p['edges'] >= 32 and p['mass'] >= 1.]
    weak = [p for p in active if p['vertical'] + p['horizontal'] < .25]
    evidence['contradicting_patches'] = len(weak)
    # Requiring both orientation and sustained runs avoids treating short blurred
    # pixel steps as curves. Uniform patch votes keep one long outline from voting
    # for an entire image; blank/transparent patches never count against a grid.
    contradiction = (len(active) >= 4 and len(weak) / len(active) >= .75
                     and evidence['segment_fraction'] < .25 and evidence['axis_fraction'] < .75)
    if not contradiction:
        supported = (len(active) >= 3 and evidence['segment_fraction'] >= .35
                     and evidence['axis_fraction'] >= .75)
        evidence.update(decision='supported' if supported else 'inconclusive',
                        reason='axis-aligned runs support the candidate' if supported else
                               'insufficient contradictory evidence; preserve candidate')
        return chosen
    evidence.update(decision='rejected', reason='weak grid contradicted by non-axis-aligned contours in multiple patches')
    report['segment_rejected_grid'] = dict(spacing=[chosen.sx, chosen.sy], score=chosen.support,
                                           size=[len(chosen.x_lines)-1, len(chosen.y_lines)-1],
                                           source=chosen.metadata['source'])
    report['selected_score'] = 0.
    return None


# Grid selection when a source lattice cannot be confirmed.

def _estimate_edge_grid(rgba, features, config, report):
    """One inexpensive scale estimate for sharp, rectilinear art without a lattice.

    Reuse source projections and the bounded segment scan. No extra FFT/search,
    and no claim that a median edge interval recovers the original pixel grid.
    """
    detail = report['edge_estimate'] = dict(applied=False)
    if min(features.ramp_ratio) < 1.:
        detail['reason'] = 'soft boundaries; retain ordinary rendering'
        return None
    axes, sizes = [], []
    for profile in (features.profile_x, features.profile_y):
        positions = peaks(profile, max(.0008, .2 * float(profile.max())))
        separated = []
        for p in positions:
            if not separated or p - separated[-1] >= 4:
                separated.append(p)
        if len(separated) < 8:
            detail['reason'] = 'too few distributed edge peaks'
            return None
        pos = np.asarray(separated)
        axes.append(dict(profile=profile, pos=pos, weights=profile[pos]))
        sizes.append(float(np.median(np.diff(pos))))
    # The finer direction is conservative when backgrounds hide many boundaries.
    # Reject coarse estimates instead of imposing an arbitrary huge pixel block.
    spacing = min(sizes)
    detail.update(axis_median_gaps=sizes, spacing=spacing)
    if not config.min_pixel_size <= spacing <= min(config.max_pixel_size, max(rgba.shape[:2]) / 128):
        detail['reason'] = 'estimated spacing outside range or too coarse'
        return None
    evidence = axis_segment_evidence(rgba, (spacing, spacing))
    detail['segments'] = evidence
    active = [p for p in evidence['patches'] if p['edges'] >= 32 and p['mass'] >= 1.]
    supporters = sum(p['axis_aligned'] >= .70 and p['vertical'] + p['horizontal'] >= .35 for p in active)
    if (len(active) < 4 or supporters < 2 * len(active) / 3
            or evidence['axis_fraction'] < .75 or evidence['segment_fraction'] < .45):
        detail['reason'] = 'insufficient distributed straight-edge support'
        return None
    phases = [_phase(a, spacing) for a in axes]
    cuts = [_walk(a, spacing, p, config.local_warp == 'auto') for a, p in zip(axes, phases)]
    if max(len(c) - 1 for c in cuts) < 128:
        detail['reason'] = 'adjusted grid would be too coarse'
        return None
    regular = [make_lines(len(a['profile']), spacing, p) for a, p in zip(axes, phases)]
    warped = any(len(c) != len(r) or not np.allclose(c, r) for c, r in zip(cuts, regular))
    detail.update(applied=True, reason='distributed straight edges; median interval estimate',
                  generated_size=[len(c) - 1 for c in cuts])
    return GridCandidate(spacing, spacing, *phases, *cuts, 0., warped,
                         {'source': 'axis-aligned edge estimate', 'estimated': True})


def route_image(rgba, features, chosen, config, segment_evidence=None):
    """Prefer recovered/native grids; render a bounded fallback without a lattice.

    This is an abstaining heuristic, not a calibrated pixel-art/photo classifier.
    A generated grid can never be coarser than an existing accepted grid.
    """
    h, w = rgba.shape[:2]
    report = dict(applied=False, mode=config.photo_mode,
                  curvature_ratio=list(features.ramp_ratio))

    def keep(reason):
        report['reason'] = reason
        return chosen, report

    if config.photo_mode == 'off':
        return keep('ordinary-image rendering disabled')
    if max(w, h) <= 192 or min(w, h) < 16:
        return keep('limited source resolution; preserve existing recovery')
    if chosen is not None:
        if chosen.has_protected_evidence:
            return keep('native pixels or validated resampling grid')
        if chosen.has_repeated_boundaries:
            return keep('repeated cell intervals or aligned grid in both axes')
    if chosen is not None and min(features.ramp_ratio) >= 1.25:
        return keep('sharp pixel-like transitions; abstain from ordinary-image rendering')

    # Accepted grids keep their existing behavior. A rejected curved outline must
    # not re-enter through a finer scale; reuse the validation result without a scan.
    if chosen is None and (segment_evidence or {}).get('decision') != 'rejected':
        estimated = _estimate_edge_grid(rgba, features, config, report)
        if estimated is not None:
            report['reason'] = 'edge-guided estimate; original lattice unconfirmed'
            return estimated, report

    # About 4 source pixels per rendered pixel, bounded to 96..256 on the long side.
    # Sparse transparent subjects receive a finer budget to avoid losing their detail.
    target = min(256, max(96, round(max(w, h) / 4)))
    spacing = max(w, h) / target
    alpha = rgba[..., 3]
    if np.any(alpha <= .01):
        yy = np.flatnonzero(np.any(alpha > .05, axis=1))
        xx = np.flatnonzero(np.any(alpha > .05, axis=0))
        if len(xx) and len(yy):
            spacing = min(spacing, max(1., max(xx[-1] - xx[0] + 1, yy[-1] - yy[0] + 1) / 128))
    if spacing < 1.5:
        return keep('small visible subject; avoid further reduction')
    nx, ny = max(1, round(w / spacing)), max(1, round(h / spacing))
    if chosen is not None and (nx < len(chosen.x_lines) - 1 or ny < len(chosen.y_lines) - 1):
        return keep('existing grid retains more detail than the rendering budget')

    if config.square:
        # Equal nominal step; partial edge cells still cover the entire input.
        xs = np.r_[np.arange(0., w - .5, spacing), float(w)]
        ys = np.r_[np.arange(0., h - .5, spacing), float(h)]
        sx = sy = spacing
    else:
        xs, ys = np.linspace(0, w, nx + 1), np.linspace(0, h, ny + 1)
        sx, sy = w / nx, h / ny
    # Verify the final counts too, including partial cells in square mode.
    if chosen is not None and (len(xs) < len(chosen.x_lines) or len(ys) < len(chosen.y_lines)):
        return keep('generated grid would lose recovered cells')
    report.update(applied=True, reason=('no reliable grid; automatic pixelization' if chosen is None else
                                       'soft image without convincing pixel-grid evidence'),
                  generated_size=[len(xs) - 1, len(ys) - 1],
                  previous_grid=None if chosen is None else dict(
                      size=[len(chosen.x_lines) - 1, len(chosen.y_lines) - 1],
                      spacing=[chosen.sx, chosen.sy], score=chosen.support),
                  confidence_note='generated rendering grid, not a recovered source lattice')
    return GridCandidate(sx, sy, 0., 0., xs, ys, 0., False,
                         {'source': 'ordinary image rendering', 'stylized': True}), report
