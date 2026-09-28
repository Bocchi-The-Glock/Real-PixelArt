/** Original-resolution edge, curvature, native-pixel and Fourier evidence. */
import {DENSE_PIXEL_LIMIT} from './config.js';
import {f32, fft, rfft, roundEven, smooth, sumFloat32, sumFloat32Buffered, sumFloat32Sequential} from './numeric.js';

const WEIGHTS = [.299, .587, .114, 0].map(f32);
const matrix = (width, height, data = new Float32Array(width * height)) => ({width, height, data});

function scanPositions(length, limit) {
  const count = Math.min(limit, length), step = count > 1 ? (length - 1) / (count - 1) : 0;
  return Int32Array.from({length: count}, (_, i) => Math.trunc(i === count - 1 ? length - 1 : step * i));
}

function positionsBetween(last, count) {
  return Int32Array.from({length: count}, (_, i) => count === 1 ? 0 : Math.trunc(i * last / (count - 1)));
}

function premultiplied(data, offset, channel) {
  return channel === 3 ? data[offset + 3] : f32(data[offset + channel] * data[offset + 3]);
}

/** Source rows or columns laid out as independent, premultiplied scanlines. */
function scanlines(image, positions, vertical = false) {
  const length = vertical ? image.height : image.width;
  const values = new Float32Array(positions.length * length * 4);
  for (let line = 0; line < positions.length; line++) {
    for (let p = 0; p < length; p++) {
      const source = (vertical ? p * image.width + positions[line] : positions[line] * image.width + p) * 4;
      const target = (line * length + p) * 4;
      for (let c = 0; c < 4; c++) values[target + c] = premultiplied(image.data, source, c);
    }
  }
  return {values, length, count: positions.length};
}

function nativeAxis({values, length, count}) {
  let edgeCount = 0, turnCount = 0, supportingLines = 0, activeLines = 0;
  for (let line = 0; line < count; line++) {
    let edges = 0, turns = 0;
    const previous = new Float32Array(4);
    for (let x = 1; x < length; x++) {
      const offset = (line * length + x) * 4;
      let strength = 0, reversal = 0;
      for (let c = 0; c < 4; c++) {
        const delta = f32(values[offset + c] - values[offset - 4 + c]);
        strength = Math.max(strength, Math.abs(delta));
        if (x > 1) reversal = Math.max(reversal,
          f32(f32(f32(Math.abs(previous[c]) + Math.abs(delta)) - Math.abs(f32(previous[c] + delta))) * .5));
        previous[c] = delta;
      }
      if (strength > f32(.06)) edges++;
      if (x > 1 && reversal > f32(.06)) turns++;
    }
    edgeCount += edges;
    turnCount += turns;
    if (turns >= 2) supportingLines++;
    if (edges >= 4) activeLines++;
  }
  return {edge_count: edgeCount, turn_count: turnCount, turn_fraction: turnCount / Math.max(1, edgeCount),
    supporting_lines: supportingLines, active_lines: activeLines};
}

function curvature(lines) {
  const {values, length, count} = lines;
  const result = new Float32Array(length * count);
  for (let line = 0; line < count; line++) {
    for (let x = 1; x < length - 1; x++) {
      const offset = (line * length + x) * 4;
      let value = 0;
      for (let c = 0; c < 4; c++) {
        value = Math.max(value, Math.abs(f32(f32(values[offset + 4 + c] - values[offset + c])
          - f32(values[offset + c] - values[offset - 4 + c]))));
      }
      result[line * length + x] = value;
    }
  }
  return result;
}

function columnMean(values, width, height, pairwise = false) {
  const result = new Float32Array(width);
  const reduce = pairwise ? sumFloat32 : sumFloat32Sequential;
  for (let x = 0; x < width; x++) result[x] = f32(reduce(values, x, height, width) / height);
  return result;
}

function rowMean(values, width, height, pairwise = true) {
  const result = new Float32Array(height);
  const reduce = pairwise ? sumFloat32 : sumFloat32Sequential;
  for (let y = 0; y < height; y++) result[y] = f32(reduce(values, y * width, width) / width);
  return result;
}

function transpose(values, width, height) {
  const result = new Float32Array(values.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) result[x * height + y] = values[y * width + x];
  return result;
}

/** Exact separable 2-D FFT with reusable row/column buffers. */
function logSpectrum(gray, width, height) {
  const bins = Math.floor(width / 2) + 1;
  const horizontalReal = new Float64Array(height * bins), horizontalImag = new Float64Array(height * bins);
  for (let y = 0; y < height; y++) {
    rfft(gray.subarray(y * width, (y + 1) * width),
      horizontalReal.subarray(y * bins, (y + 1) * bins), horizontalImag.subarray(y * bins, (y + 1) * bins));
  }
  const result = matrix(bins, height), real = new Float64Array(height), imaginary = new Float64Array(height);
  for (let x = 0; x < bins; x++) {
    for (let y = 0; y < height; y++) {
      real[y] = horizontalReal[y * bins + x];
      imaginary[y] = horizontalImag[y * bins + x];
    }
    fft(real, imaginary);
    for (let y = 0; y < height; y++) result.data[y * bins + x] = Math.log1p(Math.hypot(real[y], imaginary[y]));
  }
  return result;
}

function scanlineFeatures(lines) {
  const {values, length, count} = lines;
  const gradient = new Float32Array(length * count), gray = new Float32Array(length * count);
  const curves = curvature(lines);
  for (let line = 0; line < count; line++) {
    for (let x = 0; x < length; x++) {
      const pixel = line * length + x, offset = pixel * 4;
      for (let c = 0; c < 4; c++) {
        if (x) gradient[pixel] = Math.max(gradient[pixel], Math.abs(f32(values[offset + c] - values[offset - 4 + c])));
        gray[pixel] = f32(gray[pixel] + f32(WEIGHTS[c] * values[offset + c]));
      }
      gray[pixel] = f32(gray[pixel] + f32(.5 * f32(1 - values[offset + 3])));
    }
  }
  const bins = Math.floor(length / 2) + 1, spectral = new Float64Array(bins);
  const real = new Float64Array(bins), imaginary = new Float64Array(bins);
  for (let line = 0; line < count; line++) {
    rfft(gray.subarray(line * length, (line + 1) * length), real, imaginary);
    for (let x = 0; x < bins; x++) spectral[x] += Math.log1p(Math.hypot(real[x], imaginary[x]));
  }
  const capped = gradient.map(value => Math.min(value, f32(.35)));
  return {gradient, profile: smooth(columnMean(capped, length, count)),
    spectral: Float32Array.from(spectral, value => value / count),
    curvature: smooth(columnMean(curves, length, count)),
    ratio: sumFloat32Buffered(curves) / Math.max(sumFloat32Buffered(gradient), 1e-9)};
}

function previewEdges(image) {
  const {width, height, data} = image;
  const ratio = Math.min(1, 1024 / Math.max(width, height));
  const nx = Math.max(1, roundEven(width * ratio)), ny = Math.max(1, roundEven(height * ratio));
  const gx = matrix(nx, ny), gy = matrix(nx, ny);
  for (let y = 0; y < ny; y++) {
    const sy = Math.trunc((y + .5) * height / ny);
    for (let x = 0; x < nx; x++) {
      const sx = Math.trunc((x + .5) * width / nx), target = y * nx + x;
      const source = (sy * width + sx) * 4;
      const left = (sy * width + Math.max(0, sx - 1)) * 4;
      const top = (Math.max(0, sy - 1) * width + sx) * 4;
      for (let c = 0; c < 4; c++) {
        const value = premultiplied(data, source, c);
        gx.data[target] = Math.max(gx.data[target], Math.abs(f32(value - premultiplied(data, left, c))));
        gy.data[target] = Math.max(gy.data[target], Math.abs(f32(value - premultiplied(data, top, c))));
      }
    }
  }
  return [gx, gy];
}

function sparseFeatures(image) {
  const {width, height, data} = image;
  const rows = scanPositions(height, 96), cols = scanPositions(width, 96);
  const horizontal = scanlines(image, rows), vertical = scanlines(image, cols, true);
  const x = scanlineFeatures(horizontal), y = scanlineFeatures(vertical);
  const pw = Math.min(width, 512), ph = Math.min(height, 512);
  const ox = Math.floor((width - pw) / 2), oy = Math.floor((height - ph) / 2);
  const gray = new Float32Array(pw * ph);
  for (let py = 0; py < ph; py++) for (let px = 0; px < pw; px++) {
    const source = ((py + oy) * width + px + ox) * 4, p = py * pw + px;
    for (let c = 0; c < 3; c++) gray[p] = f32(gray[p] + f32(WEIGHTS[c] * premultiplied(data, source, c)));
    gray[p] = f32(gray[p] + f32(.5 * f32(1 - data[source + 3])));
  }
  return {gradient_x: matrix(width, rows.length, x.gradient),
    gradient_y: matrix(cols.length, height, transpose(y.gradient, height, cols.length)),
    profile_x: x.profile, profile_y: y.profile, spectrum: logSpectrum(gray, pw, ph),
    spectral_x: x.spectral, spectral_y: y.spectral, curvature_x: x.curvature, curvature_y: y.curvature,
    ramp_ratio: [x.ratio, y.ratio], native_axes: [nativeAxis(horizontal), nativeAxis(vertical)],
    mode: '96 original-resolution scanlines per axis', spectrum_size: [pw, ph], preview_edges: previewEdges(image)};
}

export function extractFeatures(image) {
  const {width, height, data} = image;
  if (width * height > DENSE_PIXEL_LIMIT) return sparseFeatures(image);
  const gx = matrix(width, height), gy = matrix(width, height), gray = new Float32Array(width * height);
  // Two premultiplied rows share the left/top evidence without recomputing
  // neighboring colors or allocating another full-image RGBA buffer.
  let previous = new Float32Array(width * 4), current = new Float32Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, offset = p * 4, local = x * 4, alpha = data[offset + 3];
      for (let c = 0; c < 4; c++) {
        const value = c === 3 ? alpha : f32(data[offset + c] * alpha);
        current[local + c] = value;
        if (x) gx.data[p] = Math.max(gx.data[p], Math.abs(f32(value - current[local - 4 + c])));
        if (y) gy.data[p] = Math.max(gy.data[p], Math.abs(f32(value - previous[local + c])));
        gray[p] = f32(gray[p] + f32(WEIGHTS[c] * value));
      }
      gray[p] = f32(gray[p] + f32(.5 * f32(1 - alpha)));
    }
    [previous, current] = [current, previous];
  }
  const rows = scanPositions(height, 64), cols = scanPositions(width, 64);
  const horizontal = scanlines(image, rows), vertical = scanlines(image, cols, true);
  const cx = curvature(horizontal), cy = transpose(curvature(vertical), height, cols.length);
  const spectrum = logSpectrum(gray, width, height), bins = spectrum.width;
  // Python's spectrum is Fortran-contiguous: columns use pairwise reduction,
  // rows use sequential reduction. Keep that order even in row-major JS storage.
  const sx = new Float32Array(bins), sy = new Float32Array(height);
  for (let x = 0; x < bins; x++) sx[x] = height > 1
    ? f32(sumFloat32(spectrum.data, bins + x, height - 1, bins) / (height - 1)) : spectrum.data[x];
  for (let y = 0; y < height; y++) sy[y] = bins > 1
    ? f32(sumFloat32Sequential(spectrum.data, y * bins + 1, bins - 1) / (bins - 1)) : spectrum.data[y * bins];
  const cappedX = gx.data.map(value => Math.min(value, f32(.35)));
  const cappedY = gy.data.map(value => Math.min(value, f32(.35)));
  const sampledX = new Float32Array(rows.length * width), sampledY = new Float32Array(cols.length * height);
  for (let row = 0; row < rows.length; row++) sampledX.set(gx.data.subarray(rows[row] * width, (rows[row] + 1) * width), row * width);
  for (let col = 0; col < cols.length; col++) for (let y = 0; y < height; y++) sampledY[col * height + y] = gy.data[y * width + cols[col]];
  return {gradient_x: gx, gradient_y: gy, profile_x: smooth(columnMean(cappedX, width, height)),
    profile_y: smooth(rowMean(cappedY, width, height)), spectrum, spectral_x: sx, spectral_y: sy.slice(0, Math.floor(height / 2) + 1),
    curvature_x: smooth(columnMean(cx, width, rows.length)), curvature_y: smooth(rowMean(cy, cols.length, height)),
    ramp_ratio: [sumFloat32Buffered(cx) / Math.max(sumFloat32Buffered(sampledX), 1e-9), sumFloat32Buffered(cy) / Math.max(sumFloat32Buffered(sampledY), 1e-9)],
    native_axes: [nativeAxis(horizontal), nativeAxis(vertical)], mode: 'full image', spectrum_size: null, preview_edges: null};
}

/** Supporting evidence from at most nine unscaled patches, never a classifier. */
export function axisSegmentEvidence(image, spacing) {
  const {width, height, data} = image;
  const pw = Math.min(width, 130), ph = Math.min(height, 130);
  if (Math.min(pw, ph) < 5) return {active_patches: 0, sampled_pixels: 0, patches: []};
  const xs = positionsBetween(width - pw, Math.min(3, Math.max(1, Math.floor(width / pw))));
  const ys = positionsBetween(height - ph, Math.min(3, Math.max(1, Math.floor(height / ph))));
  const lengths = spacing.map(value => Math.max(3, Math.min(16, roundEven(.5 * value))));
  const patches = [], iw = pw - 2, ih = ph - 2;
  for (const oy of ys) for (const ox of xs) {
    const values = new Float32Array(pw * ph * 4);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const source = ((oy + y) * width + ox + x) * 4, target = (y * pw + x) * 4;
      for (let c = 0; c < 4; c++) values[target + c] = premultiplied(data, source, c);
    }
    const gx = new Float32Array(iw * ih), gy = new Float32Array(iw * ih), strength = new Float32Array(iw * ih);
    let maximum = 0;
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      const p = y * iw + x;
      for (let c = 0; c < 4; c++) {
        const source = (y * pw + x) * 4 + c;
        const dx0 = f32(f32(values[source + 8] - values[source]) * .5);
        const dx1 = f32(f32(values[source + pw * 4 + 8] - values[source + pw * 4]) * .5);
        const dx2 = f32(f32(values[source + pw * 8 + 8] - values[source + pw * 8]) * .5);
        const dy0 = f32(f32(values[source + pw * 8] - values[source]) * .5);
        const dy1 = f32(f32(values[source + pw * 8 + 4] - values[source + 4]) * .5);
        const dy2 = f32(f32(values[source + pw * 8 + 8] - values[source + 8]) * .5);
        gx[p] = Math.max(gx[p], Math.abs(f32(f32(f32(dx0 + f32(2 * dx1)) + dx2) * .25)));
        gy[p] = Math.max(gy[p], Math.abs(f32(f32(f32(dy0 + f32(2 * dy1)) + dy2) * .25)));
      }
      strength[p] = Math.max(gx[p], gy[p]);
      maximum = Math.max(maximum, strength[p]);
    }
    const threshold = Math.max(f32(.012), Math.min(f32(.04), f32(f32(.15) * maximum)));
    const vertical = new Uint8Array(iw * ih), horizontal = new Uint8Array(iw * ih), mass = new Float32Array(iw * ih);
    let edges = 0;
    for (let p = 0; p < strength.length; p++) if (strength[p] >= threshold) {
      edges++;
      vertical[p] = gx[p] >= f32(3 * gy[p]);
      horizontal[p] = gy[p] >= f32(3 * gx[p]);
      mass[p] = Math.min(strength[p], f32(.2));
    }
    const sustained = (mask, length, axis) => {
      const result = new Uint8Array(mask.length), before = Math.floor(length / 2), after = Math.floor((length - 1) / 2);
      for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) if (mask[y * iw + x]) {
        let count = 0;
        for (let k = -before; k <= after; k++) {
          const sx = axis === 0 ? x + k : x, sy = axis === 1 ? y + k : y;
          if (sx >= 0 && sx < iw && sy >= 0 && sy < ih) count += mask[sy * iw + sx];
        }
        result[y * iw + x] = count >= length - (length >= 6 ? 1 : 0);
      }
      return result;
    };
    const vr = sustained(vertical, lengths[1], 1), hr = sustained(horizontal, lengths[0], 0);
    const weight = sumFloat32Buffered(mass), denom = Math.max(weight, 1e-9);
    const selectedMass = mask => sumFloat32Buffered(mass.filter((_, p) => mask[p]));
    patches.push({origin: [ox, oy], edges, mass: weight, vertical: selectedMass(vr) / denom,
      horizontal: selectedMass(hr) / denom, axis_aligned: selectedMass(vertical.map((v, p) => v | horizontal[p])) / denom});
  }
  const active = patches.filter(p => p.edges >= 32 && p.mass >= 1);
  return {sampled_pixels: patches.length * ph * pw, patch_size: [pw, ph], run_length: lengths,
    active_patches: active.length, patches,
    segment_fraction: active.length ? active.reduce((total, p) => total + p.vertical + p.horizontal, 0) / active.length : 0,
    axis_fraction: active.length ? active.reduce((total, p) => total + p.axis_aligned, 0) / active.length : 0};
}
