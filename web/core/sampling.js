/** Recover source-cell colors and alpha, then independently recolor the result.
 *
 * Numerical choices follow the Python reference: float32 sampling, float64
 * sRGB/D65 Lab and CIEDE2000, deterministic first-index color ties. No DOM or I/O.
 */
import { DENSE_PIXEL_LIMIT, validateColorOptions } from './config.js';
import { f32, roundEven, sumFloat32 } from './numeric.js';

const DEG = Math.PI / 180;

export function resolveAlphaMode(image, requested = 'auto') {
  if (!['auto', 'binary', 'coverage'].includes(requested)) {
    throw new Error('alpha_mode must be auto, binary, or coverage');
  }
  let visible = 0;
  let opaque = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    visible += image.data[i] > 0;
    opaque += image.data[i] >= f32(0.94);
  }
  return [requested === 'auto' ? 'sample' : requested, opaque / Math.max(visible, 1)];
}

function integerCuts(lines, length) {
  if (lines.length < 2 || lines[0] !== 0 || lines.at(-1) !== length) {
    throw new Error('cut lines must be finite, increasing and cover the complete input');
  }
  const cuts = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (!Number.isFinite(lines[i]) || (i && lines[i] <= lines[i - 1])) {
      throw new Error('cut lines must be finite, increasing and cover the complete input');
    }
    cuts[i] = roundEven(lines[i]);
    if (i && cuts[i] <= cuts[i - 1]) throw new Error('cut lines must cover at least one source pixel');
  }
  return cuts;
}

function samplePositions(cuts, fractions) {
  const result = new Int32Array((cuts.length - 1) * fractions.length);
  for (let i = 0; i < cuts.length - 1; i++) {
    const width = cuts[i + 1] - cuts[i];
    for (let j = 0; j < fractions.length; j++) {
      result[i * fractions.length + j] = Math.min(cuts[i] + Math.trunc(width * fractions[j]), cuts[i + 1] - 1);
    }
  }
  return result;
}

function reduceAt32(values, start, length, stride = 1) {
  return length === 1 ? values[start]
    : f32(values[start] + sumFloat32(values, start + stride, length - 1, stride));
}

/** Half-open region sums: reduce rows before columns, as in the reference. */
function cellSums(image, xs, ys, channel = 3, moment = 0) {
  const { width, data } = image;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const result = new Float32Array(nx * ny);
  const columns = new Float32Array(width);
  let source = data;
  let stride = width * 4;
  let step = 4;
  let offset = channel;
  // Allocate one plane only when a premultiplied color moment is required.
  if (moment) {
    source = new Float32Array(image.width * image.height);
    for (let p = 0; p < source.length; p++) {
      const value = data[p * 4 + channel];
      source[p] = f32((moment === 2 ? f32(value * value) : value) * data[p * 4 + 3]);
    }
    stride = width;
    step = 1;
    offset = 0;
  }
  for (let y = 0; y < ny; y++) {
    const height = ys[y + 1] - ys[y];
    for (let x = 0; x < width; x++) {
      columns[x] = reduceAt32(source, ys[y] * stride + x * step + offset, height, stride);
    }
    for (let x = 0; x < nx; x++) {
      result[y * nx + x] = reduceAt32(columns, xs[x], xs[x + 1] - xs[x]);
    }
  }
  return result;
}

export function recoverCells(image, xLines, yLines, method = 'robust', alphaMode = 'auto') {
  if (!['robust', 'center', 'median'].includes(method)) throw new Error('unknown sampling method');
  const [resolvedAlpha, nearOpaque] = resolveAlphaMode(image, alphaMode);
  const xs = integerCuts(xLines, image.width);
  const ys = integerCuts(yLines, image.height);
  const nx = xs.length - 1, ny = ys.length - 1;
  const mass = cellSums(image, xs, ys);
  const rgba = new Float32Array(nx * ny * 4);
  const confidence = new Float32Array(nx * ny);
  const fractions = method === 'center' ? [0.5] : [0.18, 0.34, 0.5, 0.66, 0.82];
  const xp = samplePositions(xs, fractions), yp = samplePositions(ys, fractions);
  const sampleCount = fractions.length ** 2;
  const samples = new Float32Array(sampleCount * 4);
  const alphaSamples = new Float32Array(sampleCount);
  const red = new Float32Array(sampleCount), green = new Float32Array(sampleCount), blue = new Float32Array(sampleCount);
  const source = image.data;
  let detailCount = 0, rejectedCount = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const id = y * nx + x, out = id * 4;
      if (mass[id] <= 0) continue;
      let sample = 0, visible = 0;
      for (let dy = 0; dy < fractions.length; dy++) {
        for (let dx = 0; dx < fractions.length; dx++) {
          const p = (yp[y * fractions.length + dy] * image.width + xp[x * fractions.length + dx]) * 4;
          const alpha = source[p + 3];
          for (let c = 0; c < 4; c++) samples[sample * 4 + c] = source[p + c];
          alphaSamples[sample] = alpha;
          const valid = alpha > f32(1e-6);
          red[sample] = valid ? source[p] : Infinity;
          green[sample] = valid ? source[p + 1] : Infinity;
          blue[sample] = valid ? source[p + 2] : Infinity;
          visible += valid;
          sample++;
        }
      }
      const middle = Math.floor(sampleCount / 2) * 4;
      let a = samples[middle + 3];
      let r = a === 0 ? 0 : samples[middle];
      let g = a === 0 ? 0 : samples[middle + 1];
      let b = a === 0 ? 0 : samples[middle + 2];
      let support = 1;
      if (method !== 'center') {
        alphaSamples.sort(); red.sort(); green.sort(); blue.sort();
        const medianAlpha = alphaSamples[Math.floor(sampleCount / 2)];
        const mid = Math.max(0, Math.floor((visible - 1) / 2));
        const mr = visible ? red[mid] : 0, mg = visible ? green[mid] : 0, mb = visible ? blue[mid] : 0;
        let nearMedian = 0;
        for (let k = 0; k < sampleCount; k++) {
          const p = k * 4;
          if (samples[p + 3] > f32(1e-6) && Math.max(Math.abs(f32(samples[p] - mr)),
            Math.abs(f32(samples[p + 1] - mg)), Math.abs(f32(samples[p + 2] - mb))) < f32(0.12)) nearMedian++;
        }
        if (method === 'median') {
          r = mr; g = mg; b = mb; a = medianAlpha;
          support = nearMedian / Math.max(visible, 1);
        } else {
          const cx = xs[x] + Math.floor((xs[x + 1] - xs[x]) / 2);
          const cy = ys[y] + Math.floor((ys[y + 1] - ys[y]) / 2);
          const cr = f32(r * a), cg = f32(g * a), cb = f32(b * a);
          let near = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const py = Math.max(ys[y], Math.min(ys[y + 1] - 1, cy + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const px = Math.max(xs[x], Math.min(xs[x + 1] - 1, cx + dx));
              const p = (py * image.width + px) * 4, pa = source[p + 3];
              const distance = Math.max(Math.abs(f32(f32(source[p] * pa) - cr)),
                Math.abs(f32(f32(source[p + 1] * pa) - cg)), Math.abs(f32(f32(source[p + 2] * pa) - cb)), Math.abs(f32(pa - a)));
              near += distance < f32(0.10);
            }
          }
          const coherent = near >= 3;
          const tiny = xs[x + 1] - xs[x] <= 2 || ys[y + 1] - ys[y] <= 2;
          const deviation = Math.max(Math.abs(f32(r - mr)), Math.abs(f32(g - mg)), Math.abs(f32(b - mb))) > f32(0.10);
          const reject = !coherent && !tiny && (deviation || Math.abs(f32(a - medianAlpha)) > f32(0.10));
          detailCount += coherent && deviation && a > 0;
          if (reject) {
            r = mr; g = mg; b = mb; a = medianAlpha;
            rejectedCount++;
          }
          support = reject ? nearMedian / Math.max(visible, 1) : near / 9;
        }
      }
      rgba[out] = r; rgba[out + 1] = g; rgba[out + 2] = b; rgba[out + 3] = a;
      confidence[id] = support;
    }
  }
  if (resolvedAlpha === 'coverage') {
    const missing = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const id = y * nx + x;
        if (mass[id] > 0 && rgba[id * 4 + 3] === 0) missing.push(id);
        rgba[id * 4 + 3] = mass[id] / ((xs[x + 1] - xs[x]) * (ys[y + 1] - ys[y]));
      }
    }
    if (missing.length) {
      for (let c = 0; c < 3; c++) {
        const sums = cellSums(image, xs, ys, c, 1);
        for (const id of missing) rgba[id * 4 + c] = sums[id] / Math.max(mass[id], 1e-8);
      }
    }
  } else if (resolvedAlpha === 'binary') {
    for (let p = 3; p < rgba.length; p += 4) rgba[p] = rgba[p] >= 0.5 ? 1 : 0;
  }
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] <= 0) rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
  }
  return { rgba, width: nx, height: ny, confidence, structure: {
    supported_central_strokes: detailCount, rejected_central_impulses: rejectedCount,
    samples_per_cell: sampleCount, alpha_mode_requested: alphaMode, alpha_mode: resolvedAlpha,
    source_near_opaque_fraction: nearOpaque, contour_expansion: false,
  } };
}

/** Use area color only in smooth cells of an ordinary-image rendering grid. */
export function renderCells(image, grid, config) {
  const cells = recoverCells(image, grid.x_lines, grid.y_lines, config.sampling, config.alpha_mode);
  cells.structure.rendering = 'ordinary image';
  if (config.sampling !== 'robust') return cells;
  const xs = integerCuts(grid.x_lines, image.width), ys = integerCuts(grid.y_lines, image.height);
  const { width: nx, height: ny, rgba } = cells;
  let smoothCount = 0;
  if (image.width * image.height > DENSE_PIXEL_LIMIT) {
    const fractions = Array.from({ length: 8 }, (_, i) => (i + 0.5) / 8);
    const xx = samplePositions(xs, fractions), yy = samplePositions(ys, fractions);
    const alphas = new Float32Array(64);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const means = [0, 0, 0], moments = [0, 0, 0];
        for (let dy = 0; dy < 8; dy++) {
          for (let dx = 0; dx < 8; dx++) {
            const p = (yy[y * 8 + dy] * image.width + xx[x * 8 + dx]) * 4;
            const a = image.data[p + 3];
            alphas[dy * 8 + dx] = a;
            for (let c = 0; c < 3; c++) {
              const value = image.data[p + c];
              means[c] = f32(means[c] + f32(value * a));
              moments[c] = f32(moments[c] + f32(f32(value * value) * a));
            }
          }
        }
        // NumPy reduces the RGB channels sequentially, the scalar alpha with a
        // pairwise sum. Match both orders before the smooth-region threshold.
        const mass = Math.max(sumFloat32(alphas, 0, 64), f32(1e-8));
        const out = (y * nx + x) * 4;
        let variance = 0, difference = 0;
        for (let c = 0; c < 3; c++) {
          means[c] = f32(means[c] / mass);
          variance = Math.max(variance, f32(f32(moments[c] / mass) - f32(means[c] * means[c])));
          difference = Math.max(difference, Math.abs(f32(rgba[out + c] - means[c])));
        }
        if (variance < f32(0.06 ** 2) && difference < f32(0.12) && rgba[out + 3] > 0) {
          for (let c = 0; c < 3; c++) rgba[out + c] = means[c];
          smoothCount++;
        }
      }
    }
    cells.structure.rendering_sampler = '64 area samples in smooth regions; supported centre at boundaries';
    cells.structure.rendering_samples_per_cell = 64;
  } else {
    const mass = cellSums(image, xs, ys);
    const means = new Float32Array(nx * ny * 3), variance = new Float32Array(nx * ny);
    for (let c = 0; c < 3; c++) {
      const sums = cellSums(image, xs, ys, c, 1), moments = cellSums(image, xs, ys, c, 2);
      for (let id = 0; id < mass.length; id++) {
        const mean = f32(sums[id] / Math.max(mass[id], f32(1e-8)));
        means[id * 3 + c] = mean;
        variance[id] = Math.max(variance[id], f32(f32(moments[id] / Math.max(mass[id], f32(1e-8))) - f32(mean * mean)));
      }
    }
    for (let id = 0; id < mass.length; id++) {
      if (variance[id] < f32(0.06 ** 2) && rgba[id * 4 + 3] > 0) {
        for (let c = 0; c < 3; c++) rgba[id * 4 + c] = means[id * 3 + c];
        smoothCount++;
      }
    }
    cells.structure.rendering_sampler = 'area in smooth regions; supported centre at boundaries';
  }
  cells.structure.averaged_smooth_cells = smoothCount;
  return cells;
}

// sRGB/D65 and perceptual distance. Public scalar helpers support reference tests.
export function rgbToLab(rgb) {
  const linear = Array.from(rgb, value => {
    const encoded = value / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = linear;
  const xyz = [(r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883];
  const d = 6 / 29;
  const [x, y, z] = xyz.map(value => value > d ** 3 ? Math.cbrt(value) : value / (3 * d * d) + 4 / 29);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function deltaE2000(first, second) {
  const [l1, a1, b1] = first, [l2, a2, b2] = second;
  const cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const cbar7 = cbar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cbar7 / (cbar7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const c1 = Math.hypot(ap1, b1), c2 = Math.hypot(ap2, b2);
  const h1 = ((Math.atan2(b1, ap1) / DEG) % 360 + 360) % 360;
  const h2 = ((Math.atan2(b2, ap2) / DEG) % 360 + 360) % 360;
  const zero = c1 * c2 === 0;
  let dh = h2 - h1;
  if (dh > 180 + 1e-12) dh -= 360;
  else if (dh < -180 - 1e-12) dh += 360;
  if (zero) dh = 0;
  const dl = l2 - l1, dc = c2 - c1;
  const dhTerm = 2 * Math.sqrt(c1 * c2) * Math.sin(dh * DEG / 2);
  const lm = (l1 + l2) / 2, cm = (c1 + c2) / 2;
  let hm = Math.abs(h1 - h2) <= 180 + 1e-12 ? (h1 + h2) / 2
    : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  if (zero) hm = h1 + h2;
  const t = 1 - 0.17 * Math.cos((hm - 30) * DEG) + 0.24 * Math.cos(2 * hm * DEG)
    + 0.32 * Math.cos((3 * hm + 6) * DEG) - 0.20 * Math.cos((4 * hm - 63) * DEG);
  const sl = 1 + 0.015 * (lm - 50) ** 2 / Math.sqrt(20 + (lm - 50) ** 2);
  const sc = 1 + 0.045 * cm, sh = 1 + 0.015 * cm * t;
  const cm7 = cm ** 7;
  const rt = -2 * Math.sqrt(cm7 / (cm7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * DEG);
  const vl = dl / sl, vc = dc / sc, vh = dhTerm / sh;
  return Math.sqrt(Math.max(0, vl * vl + vc * vc + vh * vh + rt * vc * vh));
}

function distance(first, second, mode) {
  if (mode === 'natural') return deltaE2000(first, second) ** 2;
  return (first[0] - second[0]) ** 2 + (first[1] - second[1]) ** 2 + (first[2] - second[2]) ** 2;
}

function colorSpace(rgb, mode) {
  return mode === 'natural' ? rgb.map(rgbToLab) : rgb;
}

export function nearest(points, palette, mode) {
  const result = new Int32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    let minimum = Infinity, chosen = 0;
    for (let j = 0; j < palette.length; j++) {
      const value = distance(points[i], palette[j], mode);
      if (value < minimum) { minimum = value; chosen = j; }
    }
    result[i] = chosen;
  }
  return result;
}

function paletteLibraries(libraries) {
  return Array.isArray(libraries) ? libraries : libraries.palettes;
}

export function paletteCatalog(libraries) {
  return paletteLibraries(libraries).map(p => ({
    id: p.id, name: `${p.brand}-${p.nominal_size}色`, brand: p.brand,
    nominal_size: p.nominal_size, entries: p.colors.length,
    unique_colors: new Set(p.colors.map(c => c.hex.toUpperCase())).size,
  }));
}

export function paletteRgb(name, libraries) {
  validateColorOptions({ palette: name });
  if (name === null) throw new Error('a palette name is required');
  const palette = paletteLibraries(libraries).find(p => p.id === name);
  const colors = [...new Set(palette.colors.map(c => c.hex.toUpperCase().replace(/^#/, '')))];
  return colors.map(hex => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)));
}

function representatives(rgb, weights, budget = 2048) {
  if (rgb.length <= budget) return [rgb, weights];
  let bins;
  for (const shift of [3, 4, 5]) {
    bins = new Map();
    for (let i = 0; i < rgb.length; i++) {
      const key = ((rgb[i][0] >> shift) << 16) | ((rgb[i][1] >> shift) << 8) | (rgb[i][2] >> shift);
      const bin = bins.get(key);
      if (bin) {
        bin.weight += weights[i];
        if (weights[i] > weights[bin.index]) bin.index = i;
      } else bins.set(key, { index: i, weight: weights[i] });
    }
    if (bins.size <= budget) break;
  }
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  return [sorted.map(([, bin]) => rgb[bin.index]), Float64Array.from(sorted, ([, bin]) => bin.weight)];
}

function selectPalette(rgb, weights, count, mode) {
  if (rgb.length <= count) return rgb;
  const points = colorSpace(rgb, mode);
  let first = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[first]) first = i;
  const selected = [first], used = new Uint8Array(rgb.length);
  used[first] = 1;
  const best = Float64Array.from(points, point => distance(point, points[first], mode));
  const logWeights = Float64Array.from(weights, Math.log1p);
  for (let k = 1; k < count; k++) {
    let maximum = -Infinity, chosen = 0;
    for (let i = 0; i < best.length; i++) {
      const priority = used[i] ? -1 : best[i] * logWeights[i];
      if (priority > maximum) { maximum = priority; chosen = i; }
    }
    selected.push(chosen); used[chosen] = 1;
    for (let i = 0; i < best.length; i++) best[i] = Math.min(best[i], distance(points[i], points[chosen], mode));
  }
  for (let iteration = 0; iteration < 8; iteration++) {
    const assignment = nearest(points, selected.map(index => points[index]), mode);
    const members = Array.from({ length: count }, () => []);
    for (let i = 0; i < assignment.length; i++) members[assignment[i]].push(i);
    let changed = false;
    for (let cluster = 0; cluster < count; cluster++) {
      if (!members[cluster].length) continue;
      const mean = [0, 0, 0];
      let mass = 0;
      for (const index of members[cluster]) {
        mass += weights[index];
        for (let c = 0; c < 3; c++) mean[c] += points[index][c] * weights[index];
      }
      for (let c = 0; c < 3; c++) mean[c] /= mass;
      let candidate = members[cluster][0], minimum = Infinity;
      for (const index of members[cluster]) {
        const cost = distance(points[index], mean, mode);
        if (cost < minimum) { minimum = cost; candidate = index; }
      }
      let oldCost = 0, newCost = 0;
      for (const index of members[cluster]) {
        oldCost += weights[index] * distance(points[index], points[selected[cluster]], mode);
        newCost += weights[index] * distance(points[index], points[candidate], mode);
      }
      if (newCost < oldCost - 1e-9) {
        changed ||= selected[cluster] !== candidate;
        selected[cluster] = candidate;
      }
    }
    if (!changed) break;
  }
  return [...new Set(selected)].sort((a, b) => a - b).map(index => rgb[index]);
}

function colorKey(data, offset) {
  return data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
}

function unpackColor(key) {
  return [key >>> 16, (key >>> 8) & 255, key & 255];
}

/** Recolor bytes only; dimensions and alpha never change and no grid is sampled. */
export function processColors(image, options = {}, libraries) {
  const { colors = null, palette = null, color_mode: mode = 'natural' } = options;
  validateColorOptions({ colors, palette, color_mode: mode });
  const start = performance.now();
  const data = new Uint8Array(image.data);
  const output = { ...image, data };
  if (colors === null && palette === null) {
    return { image: output, diagnostics: { applied: false, palette: null, limit: null, mode }, seconds: (performance.now() - start) / 1000 };
  }
  const histogram = new Map();
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) { data[p] = data[p + 1] = data[p + 2] = 0; continue; }
    const key = colorKey(data, p);
    histogram.set(key, (histogram.get(key) ?? 0) + data[p + 3] / 255);
  }
  const keys = [...histogram.keys()].sort((a, b) => a - b);
  const rgb = keys.map(unpackColor), weights = Float64Array.from(keys, key => histogram.get(key));
  let mapped = rgb;
  if (rgb.length && palette) {
    const available = paletteRgb(palette, libraries);
    const matched = nearest(colorSpace(rgb, mode), colorSpace(available, mode), mode);
    const used = [...new Set(matched)].sort((a, b) => a - b);
    const candidates = used.map(index => available[index]);
    const lookup = new Map(used.map((index, i) => [index, i]));
    const support = new Float64Array(used.length);
    for (let i = 0; i < matched.length; i++) support[lookup.get(matched[i])] += weights[i];
    if (colors !== null && candidates.length > colors) {
      const reduced = selectPalette(candidates, support, colors, mode);
      const remap = nearest(colorSpace(candidates, mode), colorSpace(reduced, mode), mode);
      mapped = Array.from(matched, index => reduced[remap[lookup.get(index)]]);
    } else mapped = Array.from(matched, index => available[index]);
  } else if (rgb.length && rgb.length > colors) {
    const [candidates, support] = representatives(rgb, weights);
    const reduced = selectPalette(candidates, support, colors, mode);
    mapped = Array.from(nearest(colorSpace(rgb, mode), colorSpace(reduced, mode), mode), index => reduced[index]);
  }
  const remap = new Map(keys.map((key, i) => [key, mapped[i]]));
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) continue;
    const color = remap.get(colorKey(data, p));
    data[p] = color[0]; data[p + 1] = color[1]; data[p + 2] = color[2];
  }
  const diagnostics = { applied: true, palette, limit: colors, mode, input_colors: rgb.length,
    output_colors: new Set(mapped.map(color => color[0] * 65536 + color[1] * 256 + color[2])).size };
  if (palette) diagnostics.library = paletteCatalog(libraries).find(entry => entry.id === palette);
  return { image: output, diagnostics, seconds: (performance.now() - start) / 1000 };
}
