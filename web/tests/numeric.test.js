import test from 'node:test';
import assert from 'node:assert/strict';
import {fft, rfftMagnitude, roundEven, peaks, smooth, median, quantile} from '../core/numeric.js';
import {extractFeatures, axisSegmentEvidence} from '../core/features.js';

test('nearest-even rounding, plateau maxima and clamped smoothing match Python conventions', () => {
  assert.deepEqual([-2.5, -1.5, -.5, .5, 1.5, 2.5].map(roundEven), [-2, -2, 0, 0, 2, 2]);
  assert.deepEqual(Array.from(peaks([0, 2, 2, 2, 0, 1, 0])), [2, 5]);
  assert.deepEqual(Array.from(peaks([2, 2, 0, 3, 3])), []);
  assert.deepEqual(Array.from(peaks([0, 2, 0, 1, 0], 1.5)), [1]);
  assert.deepEqual(Array.from(smooth([0, 1, 0])), [.25, .5, .25]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([4, 1, 3, 2], .25), 1.75);
});

test('complex FFT matches a direct DFT for power-of-two, mixed and prime lengths', () => {
  for (const n of [1, 2, 3, 8, 17, 31, 32, 37, 63, 127, 130, 131, 257]) {
    const sourceReal = Float64Array.from({length: n}, (_, i) => Math.sin(i * 1.1) + .2 * Math.cos(i));
    const sourceImag = Float64Array.from({length: n}, (_, i) => Math.sin(i * .35));
    const real = sourceReal.slice(), imaginary = sourceImag.slice();
    fft(real, imaginary);
    const realSpectrum = rfftMagnitude(sourceReal);
    for (let k = 0; k < n; k++) {
      let expectedReal = 0, expectedImag = 0, realOnly = 0, imaginaryOnly = 0;
      for (let i = 0; i < n; i++) {
        const angle = -2 * Math.PI * k * i / n;
        expectedReal += sourceReal[i] * Math.cos(angle) - sourceImag[i] * Math.sin(angle);
        expectedImag += sourceReal[i] * Math.sin(angle) + sourceImag[i] * Math.cos(angle);
        realOnly += sourceReal[i] * Math.cos(angle);
        imaginaryOnly += sourceReal[i] * Math.sin(angle);
      }
      assert.ok(Math.abs(real[k] - expectedReal) < 1e-8, `real n=${n}, bin=${k}`);
      assert.ok(Math.abs(imaginary[k] - expectedImag) < 1e-8, `imag n=${n}, bin=${k}`);
      if (k < realSpectrum.length) assert.ok(Math.abs(realSpectrum[k] - Math.hypot(realOnly, imaginaryOnly)) < 1e-8,
        `real-input n=${n}, bin=${k}`);
    }
  }
});

test('reused FFT plans retain the correct transform length and do not retain signal data', () => {
  for (const n of [1536, 1237, 1452, 1083, 1536]) {
    const values = Float64Array.from({length: n}, (_, i) => Math.cos(2 * Math.PI * 7 * i / n));
    const spectrum = rfftMagnitude(values);
    assert.equal(spectrum.length, Math.floor(n / 2) + 1);
    assert.ok(Math.abs(spectrum[7] - n / 2) < 1e-8);
    assert.ok(spectrum.every((value, i) => i === 7 || value < 1e-8));
    assert.ok(rfftMagnitude(new Float64Array(n)).every(value => value === 0));
  }
});

function geometricImage(hiddenRgb = 0) {
  const width = 48, height = 40, data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (x >= 8 && x < 40 && y >= 8 && y < 32) {
      const highlight = x >= 24 && x < 32 && y >= 8 && y < 16;
      data.set(highlight ? [1, 1, 1, 1] : [1, .25, 0, 1], offset);
    } else data.set([hiddenRgb, hiddenRgb / 2, hiddenRgb, 0], offset);
  }
  return {width, height, data, has_alpha: true};
}

test('feature extraction uses original coordinates and ignores hidden transparent RGB', () => {
  const clean = geometricImage(), hidden = geometricImage(1);
  const expected = extractFeatures(clean), actual = extractFeatures(hidden);
  for (const key of ['gradient_x', 'gradient_y', 'spectrum']) {
    assert.deepEqual(actual[key], expected[key], key);
  }
  for (const key of ['profile_x', 'profile_y', 'spectral_x', 'spectral_y',
    'curvature_x', 'curvature_y', 'native_axes', 'ramp_ratio']) assert.deepEqual(actual[key], expected[key], key);
  assert.equal(actual.gradient_x.width, 48);
  assert.equal(actual.gradient_y.height, 40);
  assert.equal(actual.spectrum.width, 25);
  assert.equal(actual.spectrum.height, 40);
  assert.equal(actual.gradient_x.data[20 * 48 + 8], 1);
  assert.equal(actual.gradient_x.data[20 * 48 + 9], 0);
  assert.equal(actual.gradient_y.data[8 * 48 + 12], 1);
  const segments = axisSegmentEvidence(clean, [8, 8]);
  assert.equal(segments.active_patches, 1);
  assert.ok(segments.axis_fraction > .8);
  assert.ok(segments.segment_fraction > .7);
  assert.deepEqual(axisSegmentEvidence(hidden, [8, 8]), segments);
});
