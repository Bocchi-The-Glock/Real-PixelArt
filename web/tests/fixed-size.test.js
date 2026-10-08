import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configuration } from '../core/config.js';
import { pixelize } from '../core/pipeline.js';
import { recoverCells, processColors } from '../core/sampling.js';
import { byteImage, floatImage, encodePng, decodePng } from '../core/tools.js';

const libraries = JSON.parse(fs.readFileSync(new URL('../core/palettes.json', import.meta.url)));
const xCuts = [0, 12, 26, 39, 49, 58, 69, 83, 96];
const yCuts = [0, 14, 26, 36, 47, 58, 72];

/** A colored tile board with bounded, nonuniform cell widths; no random noise. */
function tileBoard({ transparent = false, hiddenRgb = [0, 0, 0] } = {}) {
  const width = xCuts.at(-1), height = yCuts.at(-1);
  const data = new Uint8Array(width * height * 4);
  const palette = [[24, 40, 64], [238, 190, 58], [45, 155, 188], [238, 103, 80]];
  for (let row = 0; row < 6; row++) for (let column = 0; column < 8; column++) {
    const clear = transparent && (column === 0 || row === 0 || column === 7 || row === 5);
    const rgba = clear ? [...hiddenRgb, 0] : [...palette[(column + 2 * row) % palette.length], 255];
    for (let y = yCuts[row]; y < yCuts[row + 1]; y++) {
      for (let x = xCuts[column]; x < xCuts[column + 1]; x++) data.set(rgba, (y * width + x) * 4);
    }
  }
  return { width, height, data, has_alpha: transparent };
}

function checkCoverage(result, input, target) {
  assert.deepEqual([result.image.width, result.image.height], target);
  assert.deepEqual(result.grid.output_size, target);
  for (const [cuts, count, length] of [
    [result.grid.x_lines, target[0], input.width], [result.grid.y_lines, target[1], input.height],
  ]) {
    assert.equal(cuts.length, count + 1);
    assert.equal(cuts[0], 0); assert.equal(cuts.at(-1), length);
    assert.ok(cuts.every(Number.isInteger));
    assert.ok(cuts.slice(1).every((line, i) => line > cuts[i]));
  }
}

test('fixed size covers the entire source, including asymmetric and one-pixel axes', () => {
  const input = tileBoard();
  for (const target_size of [[8, 6], [7, 5], [5, 9], [1, 5], [7, 1], [1, 1], [95, 71], [96, 72]]) {
    for (const local_warp of ['auto', 'off']) {
      const result = pixelize(input, { target_size, local_warp });
      checkCoverage(result, input, target_size);
      assert.deepEqual(result.image, pixelize(input, { target_size, local_warp }).image);
    }
  }
});

test('near-native odd source dimensions retain nonempty cells on both axes', () => {
  const width = 17, height = 19, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const outlined = x === 2 || x === 14 || y === 3 || y === 15;
    const stripe = Math.floor(x / 3) % 2 === 0;
    data.set(outlined ? [18, 24, 40, 255] : stripe ? [45, 155, 188, 255] : [238, 190, 58, 255],
      (y * width + x) * 4);
  }
  const input = { width, height, data, has_alpha: false };
  for (const local_warp of ['auto', 'off']) {
    const result = pixelize(input, { target_size: [16, 18], local_warp });
    checkCoverage(result, input, [16, 18]);
  }
});

test('fixed size follows measured boundaries better than uniform resizing', () => {
  const input = tileBoard(), result = pixelize(input, { target_size: [8, 6] });
  const distance = (a, b) => a.reduce((error, value, i) => error + Math.abs(value - b[i]), 0);
  const uniformError = distance(xCuts, xCuts.map((_, i) => i * 12))
    + distance(yCuts, yCuts.map((_, i) => i * 12));
  const adaptiveError = distance(result.grid.x_lines, xCuts) + distance(result.grid.y_lines, yCuts);
  assert.ok(adaptiveError < uniformError / 2, `${adaptiveError} vs uniform ${uniformError}`);
  assert.ok(result.grid.x_lines.some((value, i) => value !== i * 12));
});

test('fixed size takes priority over automatic square and spacing preferences', () => {
  const input = tileBoard(), plain = pixelize(input, { target_size: [5, 9] });
  const constrained = pixelize(input, {
    target_size: [5, 9], square: true, min_pixel_size: 32, max_pixel_size: 64,
  });
  assert.deepEqual(constrained.grid, plain.grid);
  assert.deepEqual(constrained.image, plain.image);
});

test('fixed size uses existing samplers, then applies independent color processing', () => {
  const input = tileBoard({ transparent: true });
  for (const sampling of ['robust', 'center', 'median']) {
    const plain = pixelize(input, { target_size: [8, 6], sampling });
    const cells = recoverCells(floatImage(input), plain.grid.x_lines, plain.grid.y_lines, sampling, 'auto');
    assert.deepEqual(plain.native_image, byteImage(cells, input.has_alpha));
    const options = { colors: 2, palette: 'MARD24', no_semitransparent: true };
    const colored = pixelize(input, { target_size: [8, 6], sampling, ...options }, libraries);
    assert.deepEqual(colored.grid, plain.grid);
    assert.deepEqual(colored.native_image, plain.native_image);
    assert.deepEqual(colored.image, processColors(plain.native_image, options, libraries).image);
  }
});

test('transparent hidden RGB does not affect fixed grid or visible output', () => {
  const a = pixelize(tileBoard({ transparent: true, hiddenRgb: [255, 0, 0] }), { target_size: [8, 6] });
  const b = pixelize(tileBoard({ transparent: true, hiddenRgb: [0, 255, 255] }), { target_size: [8, 6] });
  assert.deepEqual(a.grid, b.grid);
  assert.deepEqual(a.image, b.image);
  assert.equal(a.image.data[3], 0);
  assert.equal(a.image.data[(3 * 8 + 4) * 4 + 3], 255);
});

test('null fixed size leaves automatic output and its diagnostics unchanged', () => {
  const input = tileBoard();
  const automatic = pixelize(input), disabled = pixelize(input, { target_size: null });
  for (const key of ['image', 'native_image', 'grid', 'confidence', 'diagnostics']) {
    assert.deepEqual(disabled[key], automatic[key]);
  }
});

test('fixed size validates counts and rejects magnifying the source grid', () => {
  for (const target_size of [[], [4], [4, 5, 6], [0, 4], [-1, 4], [2.5, 4], [true, 4],
    ['4', 5], '8x6', [NaN, 4], [Infinity, 4], [4097, 1], [1001, 1000]]) {
    assert.throws(() => configuration({ target_size }), /target_size/);
  }
  for (const target_size of [[97, 6], [8, 73]]) {
    assert.throws(() => pixelize(tileBoard(), { target_size }), /target|source|input/i);
  }
});

test('fixed native size stays separate from nearest-neighbor export scale', async () => {
  const result = pixelize(tileBoard(), { target_size: [7, 5], scale: 3 });
  assert.deepEqual([result.image.width, result.image.height], [7, 5]);
  const decoded = await decodePng(await encodePng(result.image, 3));
  assert.deepEqual([decoded.width, decoded.height], [21, 15]);
  for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
    const from = (Math.floor(y / 3) * 7 + Math.floor(x / 3)) * 4;
    const to = (y * decoded.width + x) * 4;
    assert.deepEqual(decoded.data.slice(to, to + 4), result.image.data.slice(from, from + 4));
  }
});
