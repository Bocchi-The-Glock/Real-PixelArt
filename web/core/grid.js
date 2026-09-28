/** Source-grid fitting and conservative fallback selection.
 *
 * This is the JavaScript counterpart of grid.py's candidate and routing stages.
 * Profiles stay in original image coordinates; FFTs propose scales rather than
 * deciding the selected grid. Diagnostic keys intentionally match the Python API.
 */
import { axisSegmentEvidence } from './features.js';
import {
  roundEven, median, quantile, mean, diff, smooth, peaks, rfftMagnitude,
  sumFloat32, sumFloat32Buffered, sumFloat32Sequential,
} from './numeric.js';

const MIN_GRID_SCORE = 0.30;
const modulo = (value, period) => ((value % period) + period) % period;
const clip = (value, low, high) => Math.max(low, Math.min(high, value));
const gaussian = value => Math.exp(-0.5 * value * value);
const maximum = values => values.reduce((best, value) => Math.max(best, value), -Infinity);
const minimum = values => values.reduce((best, value) => Math.min(best, value), Infinity);

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function weightedMean(values, weights) {
  let total = 0;
  let weight = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i] * weights[i];
    weight += weights[i];
  }
  return total / weight;
}

function searchSorted(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function interpolate(values, position) {
  const left = clip(Math.floor(position), 0, values.length - 1);
  const right = clip(left + 1, 0, values.length - 1);
  return position <= 0 ? values[0] : position >= values.length - 1 ? values.at(-1)
    : values[left] + (values[right] - values[left]) * (position - left);
}

// NumPy arange uses a fixed represented step rather than repeated addition.
function arange(start, stop, step = 1) {
  const length = Math.max(0, Math.ceil((stop - start) / step));
  const increment = start + step - start;
  return Array.from({ length }, (_, i) => start + i * increment);
}

function linspace(start, stop, count, endpoint = true) {
  const step = (stop - start) / (endpoint ? count - 1 : count);
  const values = Array.from({ length: count }, (_, i) => start + i * step);
  if (endpoint && count > 1) values[count - 1] = stop;
  return values;
}

function allClose(a, b, rtol = 1e-5, atol = 1e-8) {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= atol + rtol * Math.abs(b[i]));
}

function candidate(sizes, phases, lines, support = 0, warped = false, metadata = {}) {
  return {
    sx: sizes[0], sy: sizes[1], phase_x: phases[0], phase_y: phases[1],
    x_lines: lines[0], y_lines: lines[1], support, warped, metadata,
  };
}

export function hasProtectedEvidence(chosen) {
  return Boolean(chosen.metadata.native_preserved || [
    'validated interpolation knots', 'exact two-pixel repetition', 'validated integer repetition',
  ].includes(chosen.metadata.source));
}

export function hasRepeatedBoundaries(chosen) {
  const metrics = chosen.metadata.axis_metrics || [];
  if (metrics.length !== 2) return false;
  const unitSupport = Math.min(...metrics.map(metric => metric.unit_gaps));
  const alignment = Math.min(...metrics.map(metric => metric.edge_fit));
  return unitSupport > 0.45 || (alignment > 0.65 && unitSupport > 0.30);
}

export function makeLines(length, spacing, phase = 0) {
  const margin = Math.max(0.5, 0.2 * spacing);
  const inside = arange(phase - spacing, length + spacing, spacing)
    .filter(value => value >= margin && value <= length - margin);
  return [0, ...inside, length];
}

// Candidate proposals, source-coordinate phase fitting, and cut placement.

function highestIndices(values, indices, count) {
  return Array.from(indices).sort((a, b) => values[a] - values[b]).slice(-count).reverse();
}

function analyzeAxis(profile, spectrum, minSize, maxSize) {
  const positions = peaks(profile, Math.max(maximum(profile) * 0.16, 0.0008));
  const groups = [];
  for (const position of positions) {
    const previous = groups.at(-1);
    let valley = Infinity;
    if (previous) for (let i = previous.at(-1); i <= position; i++) valley = Math.min(valley, profile[i]);
    if (previous && valley >= 0.90 * Math.min(profile[previous.at(-1)], profile[position])) previous.push(position);
    else groups.push([position]);
  }
  const pos = groups.map(group => (group[0] + group.at(-1)) / 2);
  const weights = pos.map(position => interpolate(profile, position));
  const gaps = diff(pos);
  const gapWeights = weights.slice(1).map((value, i) => Math.min(value, weights[i]));
  const proposals = [];
  if (gaps.length && maxSize >= minSize) {
    const steps = arange(minSize, maxSize + 0.125, 0.25);
    const density = steps.map(spacing => sum(Array.from(gaps, (gap, i) =>
      gapWeights[i] * gaussian((gap - spacing) / Math.max(0.65, 0.09 * spacing)))));
    const indices = Array.from(peaks([-1, ...density, -1]), index => index - 1);
    for (const index of highestIndices(density, indices, 3)) proposals.push([steps[index], 'edge gaps']);
  }
  const average = mean(profile);
  const power = rfftMagnitude(Float64Array.from(profile, value => value - average));
  const inRange = index => index > 0 && profile.length / index >= minSize && profile.length / index <= maxSize;
  for (const index of highestIndices(power, Array.from(peaks(power)).filter(inRange), 3)) {
    proposals.push([profile.length / index, 'edge FFT']);
  }
  const logProfile = smooth(smooth(spectrum));
  const baseline = smooth(logProfile, 12);
  const trough = Float64Array.from(baseline, (value, i) => value - logProfile[i]);
  for (const index of highestIndices(trough, Array.from(peaks(trough)).filter(inRange), 4)) {
    proposals.push([profile.length / index, 'image FFT trough']);
  }
  const upper = quantile(profile, 0.95);
  return { profile, pos, weights, gaps, gap_weights: gapWeights, power, trough, proposals,
    contrast: (upper - quantile(profile, 0.20)) / Math.max(upper, 1e-9) };
}

function fitPhase(axis, spacing) {
  const { pos, weights } = axis;
  if (!pos.length) return 0;
  const phases = linspace(0, spacing, Math.min(64, Math.max(12, Math.trunc(spacing * 4))), false);
  let best = phases[0];
  let bestFit = -Infinity;
  for (const phase of phases) {
    let fit = 0;
    for (let i = 0; i < pos.length; i++) {
      const distance = Math.abs(modulo(pos[i] - phase + spacing / 2, spacing) - spacing / 2);
      fit += weights[i] * gaussian(distance / Math.max(0.6, 0.12 * spacing));
    }
    if (fit > bestFit) { bestFit = fit; best = phase; }
  }
  for (let iteration = 0; iteration < 2; iteration++) {
    let total = 0;
    let weight = 0;
    for (let i = 0; i < pos.length; i++) {
      const residual = modulo(pos[i] - best + spacing / 2, spacing) - spacing / 2;
      if (Math.abs(residual) < Math.max(0.8, 0.2 * spacing)) {
        total += residual * weights[i];
        weight += weights[i];
      }
    }
    if (weight > 0) best = modulo(best + total / weight, spacing);
  }
  return Math.min(best, spacing - best) < 1e-7 ? 0 : best;
}

function walkCuts(axis, spacing, phase, allowWarp) {
  const length = axis.profile.length;
  const regular = makeLines(length, spacing, phase);
  if (!allowWarp || spacing < 3 || axis.pos.length < 4) return regular;
  const { pos, weights } = axis;
  let anchorIndex = -1;
  for (let i = 0; i < pos.length; i++) {
    if (Math.abs(pos[i] - length / 2) <= spacing && (anchorIndex < 0 || weights[i] > weights[anchorIndex])) anchorIndex = i;
  }
  if (anchorIndex < 0) return regular;
  const anchor = pos[anchorIndex];
  const cuts = [anchor];
  for (const direction of [-1, 1]) {
    let current = anchor;
    while (true) {
      const predicted = current + direction * spacing;
      if (predicted <= 0.2 * spacing || predicted >= length - 0.2 * spacing) break;
      const low = searchSorted(pos, predicted - 0.24 * spacing);
      const high = searchSorted(pos, predicted + 0.24 * spacing);
      let bestIndex = -1;
      let bestScore = -Infinity;
      for (let i = low; i < high; i++) {
        const score = weights[i] * gaussian((pos[i] - predicted) / (0.2 * spacing));
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      }
      current = bestIndex >= 0 ? pos[bestIndex] : predicted;
      cuts.push(current);
    }
  }
  return [0, ...cuts.sort((a, b) => a - b), length];
}

function measureAxis(axis, spacing, lines) {
  const { pos, weights, gaps, power } = axis;
  if (pos.length < 4) return { score: 0, edge_fit: 0, unit_gaps: 0, fft: 0 };
  const tolerance = Math.max(0.65, 0.14 * spacing);
  const matches = pos.map(position => {
    const upper = clip(searchSorted(lines, position), 1, lines.length - 1);
    const distance = Math.min(Math.abs(position - lines[upper]), Math.abs(position - lines[upper - 1]));
    return gaussian(distance / tolerance);
  });
  const chance = Math.min(0.85, 2.5066 * tolerance / spacing);
  const explained = Math.max(0, (weightedMean(matches, weights) - chance) / (1 - chance));
  const units = weightedMean(Array.from(gaps, gap => gaussian((gap - spacing) / Math.max(0.7, 0.12 * spacing))), axis.gap_weights);
  const frequency = axis.profile.length / spacing;
  const periodic = interpolate(power, frequency) / Math.max(maximum(power.subarray ? power.subarray(1) : power.slice(1)), 1e-9);
  return { score: 0.48 * units + 0.42 * explained + 0.10 * periodic, edge_fit: explained, unit_gaps: units, fft: periodic };
}

const rankFits = (a, b) => b.score - a.score || b.sizes[0] - a.sizes[0];

function fitReport(fit, includeSource = false) {
  return { spacing: Array.from(fit.sizes), ...(includeSource ? { source: fit.source } : {}), score: fit.score, axes: fit.metrics };
}

function fitCandidate(axes, sizes, source, allowWarp = null) {
  const phases = axes.map((axis, i) => fitPhase(axis, sizes[i]));
  const lines = axes.map((axis, i) => allowWarp === null ? makeLines(axis.profile.length, sizes[i], phases[i])
    : walkCuts(axis, sizes[i], phases[i], allowWarp));
  const metrics = axes.map((axis, i) => measureAxis(axis, sizes[i], lines[i]));
  return { score: mean(metrics.map(metric => metric.score)), sizes, source, phases, lines, metrics };
}

function refineSpacing(axes, finalists, image, config) {
  const extra = [];
  const seen = finalists.map(fit => fit.sizes);
  for (const fit of finalists) {
    const { sizes } = fit;
    const step = Math.max(0.25, roundEven(Math.min(...sizes) * 0.02 * 4) / 4);
    const centre = roundEven(sizes[0] / step) * step;
    for (const offset of [-2, -1, 0, 1, 2]) {
      const sx = centre + offset * step;
      const trial = [sx, sizes[1] * sx / sizes[0]];
      if (!(config.min_pixel_size <= Math.min(...trial)
        && Math.max(...trial) <= Math.min(config.max_pixel_size, image.width / 2, image.height / 2))) continue;
      if (seen.some(old => allClose(trial, old, 0, 1e-7))) continue;
      seen.push(trial);
      extra.push(fitCandidate(axes, trial, fit.source + ' local spacing refinement', config.local_warp === 'auto'));
    }
  }
  return extra;
}

function detectCandidates(features, image, config) {
  const { width: w, height: h } = image;
  const axes = [
    analyzeAxis(features.profile_x, features.spectral_x, config.min_pixel_size, Math.min(config.max_pixel_size, w / 2)),
    analyzeAxis(features.profile_y, features.spectral_y, config.min_pixel_size, Math.min(config.max_pixel_size, h / 2)),
  ];
  const report = { axis_proposals: axes.map(axis => axis.proposals), candidates: [],
    axis_evidence: axes.map(axis => ({ peaks: axis.pos.length, contrast: axis.contrast })) };
  if (axes.some(axis => axis.pos.length < 4 || axis.contrast < 0.25)) {
    report.rejection = 'insufficient edge peaks or projection contrast';
    return { chosen: null, report };
  }
  const pool = [];
  for (const axis of axes) for (const [spacing, origin] of axis.proposals) {
    for (const [factor, label] of [[1, ''], [0.5, ' half'], [2, ' double']]) {
      const value = spacing * factor;
      if (config.min_pixel_size <= value && value <= Math.min(config.max_pixel_size, w / 2, h / 2)
        && !pool.some(old => Math.abs(value - old[0]) < 0.08)) pool.push([value, origin + label]);
    }
  }
  const candidates = pool.map(([size, origin]) => [[size, size], origin]);
  if (!config.square) {
    const bestAxes = axes.map(axis => {
      const fits = axis.proposals.map(([proposal]) => {
        let spacing = proposal;
        let phase = fitPhase(axis, spacing);
        const { pos, weights } = axis;
        const indices = pos.map(position => roundEven((position - phase) / spacing));
        const keep = pos.map((position, i) => Math.abs(position - (phase + indices[i] * spacing)) <= Math.max(0.7, 0.18 * spacing));
        const xx = indices.filter((_, i) => keep[i]);
        const yy = pos.filter((_, i) => keep[i]);
        const ww = weights.filter((_, i) => keep[i]);
        if (xx.length >= 4 && maximum(xx) - minimum(xx) > 0) {
          const centre = weightedMean(xx, ww);
          const shifted = xx.map(value => value - centre);
          const slope = sum(shifted.map((value, i) => ww[i] * value * yy[i]))
            / sum(shifted.map((value, i) => ww[i] * value * value));
          if (Math.abs(slope / spacing - 1) < 0.025) spacing = slope;
        }
        phase = fitPhase(axis, spacing);
        const metric = measureAxis(axis, spacing, makeLines(axis.profile.length, spacing, phase));
        return [metric.score, spacing, metric.edge_fit];
      });
      // Python max(tuple) compares subsequent fields too when scores tie.
      return fits.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] || [0, 1, 0];
    });
    const [bx, by] = bestAxes;
    if (Math.min(bx[2], by[2]) > 0.85 && Math.max(bx[1], by[1]) / Math.min(bx[1], by[1]) <= 1.12
      && config.min_pixel_size <= Math.min(bx[1], by[1]) && Math.max(bx[1], by[1]) <= config.max_pixel_size) {
      candidates.push([[bx[1], by[1]], 'strong regular colour edges']);
    }
  }
  const ranked = candidates.map(([sizes, source]) => fitCandidate(axes, sizes, source)).sort(rankFits);
  const finalists = ranked.slice(0, 3).map(fit => {
    const lines = axes.map((axis, i) => fit.metrics[i].edge_fit > 0.94 ? fit.lines[i]
      : walkCuts(axis, fit.sizes[i], fit.phases[i], config.local_warp === 'auto'));
    const metrics = axes.map((axis, i) => measureAxis(axis, fit.sizes[i], lines[i]));
    return { ...fit, score: mean(metrics.map(metric => metric.score)), lines, metrics };
  }).sort(rankFits);
  if (!finalists.length) {
    report.rejection = 'no candidate spacing within search range';
    return { chosen: null, report };
  }
  const initialScore = finalists[0].score;
  report.spacing_refinement = { attempted: false, initial_score: initialScore, candidates: [] };
  if (initialScore >= 0.25 && initialScore < MIN_GRID_SCORE && Math.min(...finalists[0].metrics.map(metric => metric.unit_gaps)) >= 0.10) {
    const extra = refineSpacing(axes, finalists, image, config);
    Object.assign(report.spacing_refinement, { attempted: true, candidates: extra.map(fit => fitReport(fit)) });
    finalists.push(...extra.filter(fit => Math.min(...fit.metrics.map(metric => metric.unit_gaps)) >= 0.10));
    finalists.sort(rankFits);
  }
  const best = finalists[0];
  report.candidates = ranked.map(fit => fitReport(fit, true));
  report.refined = finalists.map(fit => fitReport(fit));
  report.selected_score = best.score;
  if (best.score < MIN_GRID_SCORE || Math.min(...best.metrics.map(metric => metric.unit_gaps)) < 0.10) {
    report.rejection = best.score < MIN_GRID_SCORE ? `grid score below ${MIN_GRID_SCORE.toFixed(2)}`
      : 'unit cell interval support below 0.10 in one axis';
    return { chosen: null, report };
  }
  const warped = best.lines.some((cuts, i) => !allClose(cuts, makeLines([w, h][i], best.sizes[i], best.phases[i])));
  return { chosen: candidate(best.sizes, best.phases, best.lines, clip(best.score, 0, 1), warped,
    { source: best.source, axis_metrics: best.metrics }), report };
}

function coarseGrid(features, image, config) {
  const { chosen: edge, report } = detectCandidates(features, image, config);
  report.ramp_curvature_ratio = Array.from(features.ramp_ratio);
  report.evidence_model = 'colour boundaries';
  if (Math.max(...features.ramp_ratio) >= 0.65) return { chosen: edge, report };
  const linear = { ...features, profile_x: features.curvature_x, profile_y: features.curvature_y };
  const { chosen: knot, report: alternate } = detectCandidates(linear, image, { ...config, local_warp: 'off' });
  report.interpolation_search = alternate;
  if (knot === null || knot.support < 0.65
    || Math.min(...knot.metadata.axis_metrics.map(metric => metric.edge_fit)) < 0.75
    || (edge !== null && knot.support < edge.support + 0.08)) return { chosen: edge, report };
  knot.phase_x = modulo(knot.phase_x + 0.5 - knot.sx / 2, knot.sx);
  knot.phase_y = modulo(knot.phase_y + 0.5 - knot.sy / 2, knot.sy);
  knot.x_lines = makeLines(image.width, knot.sx, knot.phase_x);
  knot.y_lines = makeLines(image.height, knot.sy, knot.phase_y);
  knot.metadata.source = 'validated interpolation knots';
  report.evidence_model = 'linear interpolation knots';
  report.selected_score = knot.support;
  return { chosen: knot, report };
}

// Sharp one-pixel detail and exact repeated cells take precedence over weak fits.

function nativeResolution(features, image, chosen, report) {
  const axes = features.native_axes;
  const boundaryFit = [];
  if (chosen !== null) {
    for (const [gradient, cuts, direction] of [[features.gradient_x, chosen.x_lines, 0], [features.gradient_y, chosen.y_lines, 1]]) {
      const profile = new Float32Array(direction === 0 ? gradient.width : gradient.height);
      const row = new Float32Array(gradient.width);
      for (let y = 0; y < gradient.height; y++) {
        for (let x = 0; x < gradient.width; x++) {
          const value = gradient.data[y * gradient.width + x];
          const mass = value > Math.fround(0.06) ? Math.min(value, Math.fround(0.35)) : 0;
          if (direction === 0) profile[x] += mass;
          else row[x] = mass;
        }
        if (direction === 1) profile[y] = features.mode === 'full image' ? sumFloat32(row) : sumFloat32Sequential(row);
      }
      const positions = new Set(cuts.map(value => clip(roundEven(value), 0, profile.length - 1)));
      const boundary = sumFloat32Buffered(Float32Array.from(positions, position => profile[position]));
      boundaryFit.push(boundary / Math.max(sumFloat32Buffered(profile), 1e-9));
    }
  }
  const sharp = Math.min(...features.ramp_ratio) >= 1.6;
  const detail = axes.every(axis => axis.turn_fraction >= 0.08 && axis.turn_count >= 8 && axis.supporting_lines >= 3);
  const coarseSupported = boundaryFit.length === 2 && Math.min(...boundaryFit) >= 0.80;
  const flatFraction = [features.gradient_x, features.gradient_y].map(gradient => {
    let count = 0;
    for (const value of gradient.data) if (value < Math.fround(0.005)) count++;
    return count / gradient.data.length;
  });
  const preserve = sharp && detail && !coarseSupported && (chosen !== null || Math.min(...flatFraction) > 0.20);
  report.native_resolution = { axes: Array.from(axes), sharpness_ratio: Array.from(features.ramp_ratio),
    coarse_boundary_fit: boundaryFit, selected: preserve, flat_neighbor_fraction: flatFraction,
    reason: preserve && chosen === null ? 'repeated sharp one-pixel detail'
      : preserve ? 'one-pixel detail contradicts coarse grid' : 'insufficient native detail evidence' };
  if (!preserve) return { chosen, report };
  report.rejected_coarse_grid = chosen === null ? null : {
    spacing: [chosen.sx, chosen.sy], score: chosen.support, source: chosen.metadata.source,
  };
  report.evidence_model = 'native pixel detail';
  const confidence = Math.min(0.75, 0.5 + Math.min(...axes.map(axis => axis.turn_fraction)));
  report.selected_score = confidence;
  return { chosen: candidate([1, 1], [0, 0], [arange(0, image.width + 1), arange(0, image.height + 1)],
    confidence, false, { source: 'native pixel detail', native_preserved: true }), report };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function exactIntegerGrid(features, image, config, requireTwo = false) {
  if (requireTwo && !(config.min_pixel_size <= 2 && 2 <= config.max_pixel_size)) return null;
  const sizes = [];
  const phases = [];
  for (const [gradient, direction] of [[features.gradient_x, 0], [features.gradient_y, 1]]) {
    const active = new Uint8Array(direction === 0 ? gradient.width : gradient.height);
    for (let y = 0; y < gradient.height; y++) for (let x = 0; x < gradient.width; x++) {
      if (gradient.data[y * gradient.width + x] > Math.fround(1e-6)) active[direction === 0 ? x : y] = 1;
    }
    const positions = [];
    for (let i = 0; i < active.length; i++) if (active[i]) positions.push(i);
    if (positions.length < 4) return null;
    let spacing = 0;
    for (let i = 1; i < positions.length; i++) spacing = gcd(spacing, positions[i] - positions[i - 1]);
    if ((requireTwo && spacing !== 2) || spacing < Math.max(2, config.min_pixel_size) || spacing > config.max_pixel_size) return null;
    sizes.push(spacing);
    phases.push(positions[0] % spacing);
  }
  if ((config.square && sizes[0] !== sizes[1]) || Math.max(...sizes) / Math.min(...sizes) > 1.12) return null;
  const source = sizes[0] === 2 && sizes[1] === 2 ? 'exact two-pixel repetition' : 'validated integer repetition';
  return candidate(sizes, phases, [makeLines(image.width, sizes[0], phases[0]), makeLines(image.height, sizes[1], phases[1])],
    features.mode === 'full image' ? 0.95 : 0.85, false, { source, evidence_scope: features.mode });
}

export function detectGrid(features, image, config) {
  let { chosen, report } = coarseGrid(features, image, config);
  const exact = exactIntegerGrid(features, image, config, chosen !== null);
  if (exact !== null) {
    chosen = exact;
    report.evidence_model = exact.metadata.source;
    if (exact.sx === 2 && exact.sy === 2) report.exact_two_pixel_grid = {
      spacing: [2, 2], phase: [exact.phase_x, exact.phase_y], score: exact.support,
      all_changes_aligned: features.mode === 'full image', evidence_scope: features.mode,
    };
    else report.integer_repetition = {
      spacing: [exact.sx, exact.sy], phase: [exact.phase_x, exact.phase_y], evidence_scope: features.mode,
    };
    report.selected_score = exact.support;
  }
  return nativeResolution(features, image, chosen, report);
}

export function validateGridSegments(image, features, chosen, report) {
  const evidence = { checked: false, decision: 'unchanged' };
  report.axis_segments = evidence;
  if (chosen === null) { evidence.reason = 'no candidate grid to validate'; return chosen; }
  if (hasProtectedEvidence(chosen) || Math.min(chosen.sx, chosen.sy) < 3) {
    evidence.reason = 'native pixels or validated resampling grid take precedence'; return chosen;
  }
  if (chosen.support >= 0.45 || hasRepeatedBoundaries(chosen)) {
    evidence.reason = 'strong existing grid evidence takes precedence'; return chosen;
  }
  if (Math.min(...features.ramp_ratio) < 1.25) {
    evidence.reason = 'soft boundaries; missing straight runs are inconclusive'; return chosen;
  }
  Object.assign(evidence, axisSegmentEvidence(image, [chosen.sx, chosen.sy]), { checked: true });
  const active = evidence.patches.filter(patch => patch.edges >= 32 && patch.mass >= 1);
  const weak = active.filter(patch => patch.vertical + patch.horizontal < 0.25);
  evidence.contradicting_patches = weak.length;
  const contradiction = active.length >= 4 && weak.length / active.length >= 0.75
    && evidence.segment_fraction < 0.25 && evidence.axis_fraction < 0.75;
  if (!contradiction) {
    const supported = active.length >= 3 && evidence.segment_fraction >= 0.35 && evidence.axis_fraction >= 0.75;
    Object.assign(evidence, { decision: supported ? 'supported' : 'inconclusive', reason: supported
      ? 'axis-aligned runs support the candidate' : 'insufficient contradictory evidence; preserve candidate' });
    return chosen;
  }
  Object.assign(evidence, { decision: 'rejected', reason: 'weak grid contradicted by non-axis-aligned contours in multiple patches' });
  report.segment_rejected_grid = { spacing: [chosen.sx, chosen.sy], score: chosen.support,
    size: [chosen.x_lines.length - 1, chosen.y_lines.length - 1], source: chosen.metadata.source };
  report.selected_score = 0;
  return null;
}

// Grid selection when a source lattice cannot be confirmed.

function estimateEdgeGrid(image, features, config, report) {
  const detail = { applied: false };
  report.edge_estimate = detail;
  if (Math.min(...features.ramp_ratio) < 1) { detail.reason = 'soft boundaries; retain ordinary rendering'; return null; }
  const axes = [];
  const sizes = [];
  for (const profile of [features.profile_x, features.profile_y]) {
    const positions = peaks(profile, Math.max(0.0008, 0.2 * maximum(profile)));
    const separated = [];
    for (const position of positions) if (!separated.length || position - separated.at(-1) >= 4) separated.push(position);
    if (separated.length < 8) { detail.reason = 'too few distributed edge peaks'; return null; }
    axes.push({ profile, pos: separated, weights: separated.map(position => profile[position]) });
    sizes.push(median(diff(separated)));
  }
  const spacing = Math.min(...sizes);
  Object.assign(detail, { axis_median_gaps: sizes, spacing });
  if (!(config.min_pixel_size <= spacing && spacing <= Math.min(config.max_pixel_size, Math.max(image.height, image.width) / 128))) {
    detail.reason = 'estimated spacing outside range or too coarse'; return null;
  }
  const evidence = axisSegmentEvidence(image, [spacing, spacing]);
  detail.segments = evidence;
  const active = evidence.patches.filter(patch => patch.edges >= 32 && patch.mass >= 1);
  const supporters = active.filter(patch => patch.axis_aligned >= 0.70 && patch.vertical + patch.horizontal >= 0.35).length;
  if (active.length < 4 || supporters < 2 * active.length / 3 || evidence.axis_fraction < 0.75 || evidence.segment_fraction < 0.45) {
    detail.reason = 'insufficient distributed straight-edge support'; return null;
  }
  const phases = axes.map(axis => fitPhase(axis, spacing));
  const cuts = axes.map((axis, i) => walkCuts(axis, spacing, phases[i], config.local_warp === 'auto'));
  if (Math.max(...cuts.map(lines => lines.length - 1)) < 128) { detail.reason = 'adjusted grid would be too coarse'; return null; }
  const warped = cuts.some((lines, i) => !allClose(lines, makeLines(axes[i].profile.length, spacing, phases[i])));
  Object.assign(detail, { applied: true, reason: 'distributed straight edges; median interval estimate',
    generated_size: cuts.map(lines => lines.length - 1) });
  return candidate([spacing, spacing], phases, cuts, 0, warped, { source: 'axis-aligned edge estimate', estimated: true });
}

export function routeImage(image, features, chosen, config, segmentEvidence = null) {
  const { width: w, height: h, data } = image;
  const report = { applied: false, mode: config.photo_mode, curvature_ratio: Array.from(features.ramp_ratio) };
  const keep = reason => { report.reason = reason; return { chosen, report }; };
  if (config.photo_mode === 'off') return keep('ordinary-image rendering disabled');
  if (Math.max(w, h) <= 192 || Math.min(w, h) < 16) return keep('limited source resolution; preserve existing recovery');
  if (chosen !== null) {
    if (hasProtectedEvidence(chosen)) return keep('native pixels or validated resampling grid');
    if (hasRepeatedBoundaries(chosen)) return keep('repeated cell intervals or aligned grid in both axes');
  }
  if (chosen !== null && Math.min(...features.ramp_ratio) >= 1.25) return keep('sharp pixel-like transitions; abstain from ordinary-image rendering');
  if (chosen === null && segmentEvidence?.decision !== 'rejected') {
    const estimated = estimateEdgeGrid(image, features, config, report);
    if (estimated !== null) {
      report.reason = 'edge-guided estimate; original lattice unconfirmed';
      return { chosen: estimated, report };
    }
  }
  const target = Math.min(256, Math.max(96, roundEven(Math.max(w, h) / 4)));
  let spacing = Math.max(w, h) / target;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] <= Math.fround(0.01)) { transparent = true; break; }
  }
  if (transparent) {
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > Math.fround(0.05)) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (right >= left && bottom >= top) spacing = Math.min(spacing, Math.max(1, Math.max(right - left + 1, bottom - top + 1) / 128));
  }
  if (spacing < 1.5) return keep('small visible subject; avoid further reduction');
  const nx = Math.max(1, roundEven(w / spacing));
  const ny = Math.max(1, roundEven(h / spacing));
  if (chosen !== null && (nx < chosen.x_lines.length - 1 || ny < chosen.y_lines.length - 1)) return keep('existing grid retains more detail than the rendering budget');
  const xs = config.square ? [...arange(0, w - 0.5, spacing), w] : linspace(0, w, nx + 1);
  const ys = config.square ? [...arange(0, h - 0.5, spacing), h] : linspace(0, h, ny + 1);
  const sx = config.square ? spacing : w / nx;
  const sy = config.square ? spacing : h / ny;
  if (chosen !== null && (xs.length < chosen.x_lines.length || ys.length < chosen.y_lines.length)) return keep('generated grid would lose recovered cells');
  Object.assign(report, { applied: true, reason: chosen === null ? 'no reliable grid; automatic pixelization'
    : 'soft image without convincing pixel-grid evidence', generated_size: [xs.length - 1, ys.length - 1],
    previous_grid: chosen === null ? null : { size: [chosen.x_lines.length - 1, chosen.y_lines.length - 1],
      spacing: [chosen.sx, chosen.sy], score: chosen.support },
    confidence_note: 'generated rendering grid, not a recovered source lattice' });
  return { chosen: candidate([sx, sy], [0, 0], [xs, ys], 0, false,
    { source: 'ordinary image rendering', stylized: true }), report };
}
