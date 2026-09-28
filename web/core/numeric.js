/** Small numerical primitives shared by the browser image algorithms. */
export const f32 = Math.fround;

/** NumPy/Python nearest-even rounding, including negative halves. */
export function roundEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor + (floor % 2 !== 0);
}

export function mean(values) {
  return values.length ? sum(values) / values.length : NaN;
}

export function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function quantile(values, q) {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  const position = (sorted.length - 1) * q;
  const first = Math.floor(position);
  const fraction = position - first;
  const a = sorted[first], b = sorted[Math.min(first + 1, sorted.length - 1)];
  // NumPy switches endpoints above the midpoint to avoid cancellation.
  return fraction >= .5 ? b - (b - a) * (1 - fraction) : a + (b - a) * fraction;
}

export function median(values) { return quantile(values, .5); }

export function diff(values) {
  return Float64Array.from({length: Math.max(0, values.length - 1)}, (_, i) => values[i + 1] - values[i]);
}

export function smooth(values, radius = 1) {
  const result = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    for (let k = -radius; k <= radius; k++) {
      const weight = radius === 1 ? (k === 0 ? .5 : .25) : 1 / (radius * 2 + 1);
      result[i] += values[Math.max(0, Math.min(values.length - 1, i + k))] * weight;
    }
  }
  return result;
}

/** Represent a flat local maximum by its midpoint, excluding endpoints. */
export function peaks(values, threshold = 0) {
  const result = [];
  let start = 0;
  while (start < values.length) {
    let end = start + 1;
    while (end < values.length && values[end] === values[start]) end++;
    if (start > 0 && end < values.length && values[start] > values[start - 1]
      && values[start] > values[end] && values[start] >= threshold) {
      result.push(Math.floor((start + end - 1) / 2));
    }
    start = end;
  }
  return Int32Array.from(result);
}

/** Match NumPy's contiguous float32 pairwise sum (eight lanes, 128-item blocks). */
export function sumFloat32(values, start = 0, count = values.length, stride = 1) {
  if (count < 8) {
    let total = -0;
    for (let i = 0; i < count; i++) total = f32(total + values[start + i * stride]);
    return total;
  }
  if (count <= 128) {
    let a = values[start], b = values[start + stride];
    let c = values[start + 2 * stride], d = values[start + 3 * stride];
    let e = values[start + 4 * stride], f = values[start + 5 * stride];
    let g = values[start + 6 * stride], h = values[start + 7 * stride];
    let i = 8;
    for (; i < count - count % 8; i += 8) {
      const p = start + i * stride;
      a = f32(a + values[p]); b = f32(b + values[p + stride]);
      c = f32(c + values[p + 2 * stride]); d = f32(d + values[p + 3 * stride]);
      e = f32(e + values[p + 4 * stride]); f = f32(f + values[p + 5 * stride]);
      g = f32(g + values[p + 6 * stride]); h = f32(h + values[p + 7 * stride]);
    }
    let total = f32(f32(f32(a + b) + f32(c + d)) + f32(f32(e + f) + f32(g + h)));
    for (; i < count; i++) total = f32(total + values[start + i * stride]);
    return total;
  }
  let half = Math.floor(count / 2);
  half -= half % 8;
  return f32(sumFloat32(values, start, half, stride)
    + sumFloat32(values, start + half * stride, count - half, stride));
}

export function sumFloat32Sequential(values, start = 0, count = values.length, stride = 1) {
  let total = 0;
  for (let i = 0; i < count; i++) total = f32(total + values[start + i * stride]);
  return total;
}

/** Whole-array reductions use NumPy's 8192-element iterator buffers. */
export function sumFloat32Buffered(values) {
  let total = 0;
  for (let start = 0; start < values.length; start += 8192) {
    total = f32(total + sumFloat32(values, start, Math.min(8192, values.length - start)));
  }
  return total;
}

// Standalone Cooley-Tukey FFT with small mixed radices; Bluestein handles prime
// factors larger than 31. No padded-image approximation: lengths remain exact.
// Calls are synchronous; plans reuse scratch buffers within this worker/thread.
// A small LRU cap bounds retained plans across differently sized input images.
const plans = new Map();

function remember(length, plan) {
  plans.set(length, plan);
  while (plans.size > 12) plans.delete(plans.keys().next().value);
  return plan;
}

function fftPlan(length) {
  if (plans.has(length)) {
    const plan = plans.get(length);
    plans.delete(length);
    plans.set(length, plan);
    return plan;
  }
  if ((length & (length - 1)) === 0) {
    const reverse = new Uint32Array(length);
    for (let i = 1; i < length; i++) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) ? length >> 1 : 0);
    const cosine = new Float64Array(length / 2), sine = new Float64Array(length / 2);
    for (let k = 0; k < length / 2; k++) {
      cosine[k] = Math.cos(-2 * Math.PI * k / length);
      sine[k] = Math.sin(-2 * Math.PI * k / length);
    }
    return remember(length, {length, reverse, cosine, sine});
  }
  let radix = 0;
  for (let factor = 3; factor <= 31 && factor <= length; factor += 2) {
    if (length % factor === 0) { radix = factor; break; }
  }
  if (!radix && length % 2 === 0) radix = 2;
  if (radix) {
    const inner = length / radix;
    const cosine = new Float64Array(length), sine = new Float64Array(length);
    for (let k = 0; k < length; k++) {
      cosine[k] = Math.cos(-2 * Math.PI * k / length);
      sine[k] = Math.sin(-2 * Math.PI * k / length);
    }
    const factorCos = new Float64Array(radix * radix), factorSin = new Float64Array(radix * radix);
    for (let q = 0; q < radix; q++) for (let j = 0; j < radix; j++) {
      factorCos[q * radix + j] = Math.cos(-2 * Math.PI * ((q * j) % radix) / radix);
      factorSin[q * radix + j] = Math.sin(-2 * Math.PI * ((q * j) % radix) / radix);
    }
    return remember(length, {length, radix, inner, cosine, sine, factorCos, factorSin,
      subplan: fftPlan(inner), workReal: new Float64Array(length), workImag: new Float64Array(length),
      factorReal: new Float64Array(radix), factorImag: new Float64Array(radix)});
  }
  let size = 1;
  while (size < 2 * length - 1) size *= 2;
  const cosine = new Float64Array(length), sine = new Float64Array(length);
  const kernelReal = new Float64Array(size), kernelImag = new Float64Array(size);
  for (let k = 0; k < length; k++) {
    const angle = Math.PI * ((k * k) % (2 * length)) / length;
    cosine[k] = Math.cos(angle);
    sine[k] = Math.sin(angle);
    kernelReal[k] = cosine[k];
    kernelImag[k] = sine[k];
    if (k) { kernelReal[size - k] = cosine[k]; kernelImag[size - k] = sine[k]; }
  }
  const convolution = fftPlan(size);
  radix2(kernelReal, kernelImag, convolution);
  return remember(length, {length, size, cosine, sine, kernelReal, kernelImag, convolution,
    workReal: new Float64Array(size), workImag: new Float64Array(size)});
}

function mixedRadix(real, imaginary, plan) {
  const {radix, inner, cosine, sine, factorCos, factorSin, subplan,
    workReal, workImag, factorReal, factorImag} = plan;
  for (let j = 0; j < radix; j++) {
    const offset = j * inner;
    for (let i = 0; i < inner; i++) {
      workReal[offset + i] = real[i * radix + j];
      workImag[offset + i] = imaginary[i * radix + j];
    }
    transform(workReal.subarray(offset, offset + inner), workImag.subarray(offset, offset + inner), subplan);
  }
  for (let k = 0; k < inner; k++) {
    for (let j = 0; j < radix; j++) {
      const offset = j * inner + k, angle = j * k;
      factorReal[j] = workReal[offset] * cosine[angle] - workImag[offset] * sine[angle];
      factorImag[j] = workReal[offset] * sine[angle] + workImag[offset] * cosine[angle];
    }
    if (radix === 3) {
      const r = factorReal[1] + factorReal[2], im = factorImag[1] + factorImag[2];
      const dr = (factorReal[1] - factorReal[2]) * Math.sqrt(3) / 2;
      const di = (factorImag[1] - factorImag[2]) * Math.sqrt(3) / 2;
      real[k] = factorReal[0] + r;
      imaginary[k] = factorImag[0] + im;
      real[k + inner] = factorReal[0] - r * .5 + di;
      imaginary[k + inner] = factorImag[0] - im * .5 - dr;
      real[k + 2 * inner] = factorReal[0] - r * .5 - di;
      imaginary[k + 2 * inner] = factorImag[0] - im * .5 + dr;
      continue;
    }
    for (let q = 0; q < radix; q++) {
      let r = 0, im = 0;
      for (let j = 0; j < radix; j++) {
        const angle = q * radix + j;
        r += factorReal[j] * factorCos[angle] - factorImag[j] * factorSin[angle];
        im += factorReal[j] * factorSin[angle] + factorImag[j] * factorCos[angle];
      }
      real[k + q * inner] = r;
      imaginary[k + q * inner] = im;
    }
  }
}

function radix2(real, imaginary, plan) {
  const {length, reverse, cosine, sine} = plan;
  for (let i = 0; i < length; i++) {
    const j = reverse[i];
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const half = size / 2, step = length / size;
    for (let start = 0; start < length; start += size) {
      for (let j = 0; j < half; j++) {
        const a = start + j, b = a + half, k = j * step;
        const r = real[b] * cosine[k] - imaginary[b] * sine[k];
        const im = real[b] * sine[k] + imaginary[b] * cosine[k];
        real[b] = real[a] - r;
        imaginary[b] = imaginary[a] - im;
        real[a] += r;
        imaginary[a] += im;
      }
    }
  }
}

/** In-place forward complex FFT; operands must be Float64Array of equal length. */
export function fft(real, imaginary) {
  const length = real.length;
  if (length <= 1) return;
  transform(real, imaginary, fftPlan(length));
}

function transform(real, imaginary, plan) {
  const {length} = plan;
  if (plan.reverse) { radix2(real, imaginary, plan); return; }
  if (plan.radix) { mixedRadix(real, imaginary, plan); return; }
  const {size, cosine, sine, kernelReal, kernelImag, convolution, workReal: ar, workImag: ai} = plan;
  ar.fill(0);
  ai.fill(0);
  for (let i = 0; i < length; i++) {
    ar[i] = real[i] * cosine[i] + imaginary[i] * sine[i];
    ai[i] = imaginary[i] * cosine[i] - real[i] * sine[i];
  }
  radix2(ar, ai, convolution);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * kernelReal[i] - ai[i] * kernelImag[i];
    ai[i] = -(ar[i] * kernelImag[i] + ai[i] * kernelReal[i]);
    ar[i] = r;
  }
  radix2(ar, ai, convolution);
  for (let i = 0; i < length; i++) {
    const r = ar[i] / size, im = -ai[i] / size;
    real[i] = r * cosine[i] + im * sine[i];
    imaginary[i] = im * cosine[i] - r * sine[i];
  }
}

const realPlans = new Map();

/** Real-input FFT: even lengths pack adjacent samples into one half-size FFT. */
export function rfft(values, real = new Float64Array(Math.floor(values.length / 2) + 1),
  imaginary = new Float64Array(real.length)) {
  const length = values.length;
  if (length <= 1) { real[0] = values[0] ?? 0; imaginary[0] = 0; return {real, imaginary}; }
  if (length % 2) {
    const r = Float64Array.from(values), im = new Float64Array(length);
    fft(r, im);
    real.set(r.subarray(0, real.length)); imaginary.set(im.subarray(0, imaginary.length));
    return {real, imaginary};
  }
  const half = length / 2;
  let plan = realPlans.get(length);
  if (!plan) {
    const cosine = new Float64Array(half + 1), sine = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      cosine[k] = Math.cos(-2 * Math.PI * k / length);
      sine[k] = Math.sin(-2 * Math.PI * k / length);
    }
    plan = {cosine, sine, r: new Float64Array(half), im: new Float64Array(half)};
    realPlans.set(length, plan);
    while (realPlans.size > 12) realPlans.delete(realPlans.keys().next().value);
  }
  const {cosine, sine, r, im} = plan;
  for (let i = 0; i < half; i++) { r[i] = values[2 * i]; im[i] = values[2 * i + 1]; }
  fft(r, im);
  real[0] = r[0] + im[0]; imaginary[0] = 0;
  real[half] = r[0] - im[0]; imaginary[half] = 0;
  for (let k = 1; k < half; k++) {
    const opposite = half - k;
    const evenReal = (r[k] + r[opposite]) * .5, evenImag = (im[k] - im[opposite]) * .5;
    const oddReal = (im[k] + im[opposite]) * .5, oddImag = (r[opposite] - r[k]) * .5;
    real[k] = evenReal + cosine[k] * oddReal - sine[k] * oddImag;
    imaginary[k] = evenImag + cosine[k] * oddImag + sine[k] * oddReal;
  }
  return {real, imaginary};
}

export function rfftMagnitude(values) {
  const {real, imaginary} = rfft(values);
  return Float64Array.from(real, (value, i) => Math.hypot(value, imaginary[i]));
}
