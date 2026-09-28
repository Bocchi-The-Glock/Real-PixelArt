import assert from 'node:assert/strict';
import test from 'node:test';
import { sourcePreview, fftPreview, edgePreview } from '../core/diagnostics.js';

const matrix = (width, height, values) => ({ width, height, data: Float32Array.from(values) });
const grayPixels = preview => Array.from(preview.data).filter((_, index) => index % 4 === 0);

test('odd FFT preview reflects both coordinates and normalizes already-logarithmic evidence', () => {
  // Golden pixels from Python _fft_preview + min/99.5-percentile normalization.
  // A nonzero floor catches missing black-point subtraction; middle tones catch
  // an erroneous second log1p. This also exercises odd-height Hermitian reflection.
  const spectrum = matrix(3, 3, [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const before = spectrum.data.slice();
  const preview = fftPreview(spectrum, 5);
  assert.equal(preview.width, 5);
  assert.equal(preview.height, 3);
  assert.deepEqual(grayPixels(preview), [
    159, 128, 191, 223, 255,
    64, 32, 0, 32, 64,
    255, 223, 96, 128, 159,
  ]);
  assert.deepEqual(spectrum.data, before, 'drawing must not alter detector evidence');
});

test('even FFT preview keeps the Nyquist column and uses the sampled percentile', () => {
  const preview = fftPreview(matrix(3, 4, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 4);
  assert.deepEqual(grayPixels(preview), [
    187, 163, 140, 163,
    255, 93, 210, 233,
    47, 23, 0, 23,
    117, 233, 70, 93,
  ]);
  for (let i = 0; i < preview.data.length; i += 4) {
    assert.equal(preview.data[i], preview.data[i + 1]);
    assert.equal(preview.data[i], preview.data[i + 2]);
    assert.equal(preview.data[i + 3], 255);
  }
});

test('a constant one-pixel spectrum has a finite black preview', () => {
  const preview = fftPreview(matrix(1, 1, [8]), 1);
  assert.deepEqual([preview.width, preview.height], [1, 1]);
  assert.deepEqual(Array.from(preview.data), [0, 0, 0, 255]);
});

test('edge preview shares the positive-strength 95th-percentile cap between directions', () => {
  const preview = edgePreview(
    matrix(3, 2, [.01, .02, .04, .10, .20, 0]),
    matrix(3, 2, [0, .02, .08, .01, 0, 0]), 3, 2,
  );
  // Combined positive strengths have a .18 cap, not independent axis maxima.
  assert.deepEqual(Array.from(preview.data), [
    14, 0, 0, 255, 28, 28, 28, 255, 57, 113, 57, 255,
    142, 14, 14, 255, 255, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const faint = edgePreview(matrix(2, 1, [.01, 0]), matrix(2, 1, [.02, 0]), 2, 1);
  assert.deepEqual(Array.from(faint.data), [51, 102, 51, 255, 0, 0, 0, 255]);
});

test('source preview composites alpha on neutral gray without changing source pixels', () => {
  const source = { width: 4, height: 1, data: Uint8Array.from([
    200, 10, 50, 255, 255, 0, 100, 128, 44, 17, 88, 0, 17, 240, 30, 64,
  ]) };
  const before = source.data.slice();
  assert.deepEqual(Array.from(sourcePreview(source).data), [
    200, 10, 50, 255, 223, 95, 145, 255,
    190, 190, 190, 255, 147, 203, 150, 255,
  ]);
  assert.deepEqual(source.data, before);
});

test('source preview is bounded and samples original pixel centres', () => {
  const data = new Uint8Array(2049 * 4);
  for (let x = 0; x < 2049; x++) { data[4 * x] = x % 256; data[4 * x + 3] = 255; }
  const preview = sourcePreview({ width: 2049, height: 1, data });
  assert.deepEqual([preview.width, preview.height], [1024, 1]);
  assert.equal(preview.data[0], 1); // Original x=1; no averaging with neighbours.
  assert.equal(preview.data[512 * 4], 1); // Original x=1025.
  assert.equal(preview.data[1023 * 4], 255); // Original x=2047.
});
