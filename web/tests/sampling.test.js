import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configuration } from '../core/config.js';
import { pixelize } from '../core/pipeline.js';
import { recoverCells, renderCells, processColors, paletteCatalog, paletteRgb, rgbToLab, deltaE2000, nearest } from '../core/sampling.js';

const libraries = JSON.parse(fs.readFileSync(new URL('../core/palettes.json', import.meta.url)));
function source(width, height, rgba) {
  const data = new Float32Array(width * height * 4);
  for (let p = 0; p < data.length; p += 4) data.set(rgba, p);
  return { width, height, data, has_alpha: true };
}
function pixel(image, x, y, rgba) { image.data.set(rgba, (y * image.width + x) * 4); }
function bytes(rows) { return { width: rows.length, height: 1, data: Uint8Array.from(rows.flat()), has_alpha: true }; }

test('optional binary-alpha postprocessing is reversible and preserves retained RGB', () => {
  const rows = [0, 1, 127, 128, 191, 192, 254, 255].map(alpha => [20, 40, 60, alpha]);
  const base = bytes(rows), original = base.data.slice();
  const result = processColors(base, { no_semitransparent: true });
  assert.deepEqual([...result.image.data], rows.flatMap(([r, g, b, a]) => a >= 192 ? [r, g, b, 255] : [0, 0, 0, 0]));
  assert.equal(result.diagnostics.output_colors, 1);
  assert.deepEqual(base.data, original);
  assert.deepEqual(processColors(base, { no_semitransparent: false }).image, base);
  assert.deepEqual(processColors(result.image, { no_semitransparent: true }).image, result.image);
  for (const invalid of [1, 'false', null]) {
    assert.throws(() => processColors(base, { no_semitransparent: invalid }), /boolean/);
    assert.throws(() => configuration({ no_semitransparent: invalid }), /boolean/);
  }
});

test('discarded translucent colors do not take palette slots', () => {
  const base = bytes([...Array.from({length: 20}, () => [255, 0, 0, 191]), [0, 0, 255, 192]]);
  for (const color_mode of ['rgb', 'natural']) {
    const colored = processColors(base, { colors: 1, color_mode, no_semitransparent: true }, libraries);
    assert.deepEqual([...colored.image.data.slice(-4)], [0, 0, 255, 255]);
    assert.equal(colored.diagnostics.input_colors, 1);
    const palette = processColors(base, { palette: 'MARD24', colors: 2, color_mode, no_semitransparent: true }, libraries);
    assert.ok([...palette.image.data].filter((_, i) => i % 4 === 3).every(a => a === 0 || a === 255));
  }
  const transparent = processColors(bytes([[255, 0, 0, 127]]), { no_semitransparent: true });
  assert.equal(transparent.diagnostics.output_colors, 0);
});

test('binary-alpha option leaves grid detection and sampling byte-identical', () => {
  const input = bytes(Array.from({length: 16}, (_, i) => [i * 15, 90, 160, i * 17]));
  const normal = pixelize(input, {photo_mode: 'off'});
  const binary = pixelize(input, {photo_mode: 'off', no_semitransparent: true});
  assert.deepEqual(binary.grid, normal.grid);
  assert.deepEqual(binary.native_image, normal.native_image);
  assert.deepEqual(binary.image, processColors(normal.native_image, {no_semitransparent: true}).image);
});

test('robust rejects an isolated center impulse and retains a thin line or highlight', () => {
  const image = source(9, 9, [0.2, 0.4, 0.6, 1]);
  pixel(image, 4, 4, [1, 1, 1, 1]);
  const robust = recoverCells(image, [0, 9], [0, 9]);
  const center = recoverCells(image, [0, 9], [0, 9], 'center');
  assert.deepEqual([...robust.rgba], [...Float32Array.from([0.2, 0.4, 0.6, 1])]);
  assert.equal(robust.structure.rejected_central_impulses, 1);
  assert.equal(center.rgba[0], 1);
  for (let y = 0; y < 9; y++) pixel(image, 4, y, [1, 1, 1, 1]);
  assert.equal(recoverCells(image, [0, 9], [0, 9]).rgba[0], 1);
  const highlight = source(9, 9, [0, 0, 0, 1]);
  for (const y of [3, 4]) for (const x of [3, 4]) pixel(highlight, x, y, [1, 1, 1, 1]);
  const retained = recoverCells(highlight, [0, 9], [0, 9]);
  assert.equal(retained.rgba[0], 1);
  assert.equal(retained.structure.supported_central_strokes, 1);
});

test('hidden RGB cannot influence median or robust sampling; coverage stays fractional', () => {
  const first = source(5, 5, [1, 0, 0, 0]);
  const second = source(5, 5, [0, 1, 1, 0]);
  pixel(first, 0, 0, [0.25, 0.5, 0.75, 1]);
  pixel(second, 0, 0, [0.25, 0.5, 0.75, 1]);
  for (const method of ['center', 'median', 'robust']) {
    assert.deepEqual(recoverCells(first, [0, 5], [0, 5], method), recoverCells(second, [0, 5], [0, 5], method));
  }
  const covered = recoverCells(first, [0, 5], [0, 5], 'robust', 'coverage');
  assert.deepEqual([...covered.rgba], [...Float32Array.from([0.25, 0.5, 0.75, 1 / 25])]);
  assert.equal(recoverCells(first, [0, 5], [0, 5]).rgba[3], 0);
});

test('half-open partial cells and nearest-even cut rounding preserve dimensions', () => {
  const image = source(7, 5, [0.2, 0.4, 0.6, 0.49]);
  const cells = recoverCells(image, [0, 2.5, 7], [0, 3.5, 5], 'median', 'binary');
  assert.equal(cells.width, 2); assert.equal(cells.height, 2);
  assert.ok(cells.rgba.every(value => value === 0));
  for (const xs of [[1, 7], [0, 3, 3, 7], [0, NaN, 7], [0, 0.1, 7]]) {
    assert.throws(() => recoverCells(image, xs, [0, 5]), /cut lines/);
  }
});

test('ordinary photo rendering averages smooth colors but leaves a strong center line', () => {
  const image = source(9, 9, [0.2, 0.4, 0.6, 1]);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) image.data[(y * 9 + x) * 4] += x * 0.001;
  const grid = { x_lines: [0, 9], y_lines: [0, 9] };
  const smooth = renderCells(image, grid, configuration());
  assert.equal(smooth.structure.averaged_smooth_cells, 1);
  assert.ok(Math.abs(smooth.rgba[0] - 0.204) < 1e-6);
  for (let y = 0; y < 9; y++) pixel(image, 4, y, [0, 0, 0, 1]);
  const line = renderCells(image, grid, configuration());
  assert.deepEqual([...line.rgba], [0, 0, 0, 1]);
  assert.equal(line.structure.averaged_smooth_cells, 0);
});

test('Lab primaries and published CIEDE2000 pair agree with reference values', () => {
  const lab = rgbToLab(new Uint8Array([255, 0, 0]));
  const expected = [53.24079414130722, 80.09245959641109, 67.20319651585301];
  lab.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9));
  const a = [50, 2.6772, -79.7751], b = [50, 0, -82.7485];
  assert.ok(Math.abs(deltaE2000(a, b) - 2.0425) < 5e-5);
  assert.ok(Math.abs(deltaE2000(b, a) - 2.0425) < 5e-5);
  assert.equal(nearest([[5, 0, 0]], [[0, 0, 0], [10, 0, 0]], 'rgb')[0], 0);
});

test('postprocessing is an exact no-op without options and preserves alpha with options', () => {
  const image = bytes([[20, 40, 60, 255], [255, 0, 0, 128], [20, 90, 140, 0], [240, 240, 240, 2]]);
  const noOp = processColors(image, {}, libraries);
  assert.deepEqual(noOp.image, image);
  assert.notEqual(noOp.image.data, image.data);
  for (const color_mode of ['rgb', 'natural']) {
    const result = processColors(image, { colors: 2, color_mode }, libraries);
    assert.equal(result.image.width, image.width);
    assert.equal(result.image.height, image.height);
    assert.deepEqual([...result.image.data].filter((_, i) => i % 4 === 3), [255, 128, 0, 2]);
    assert.equal(result.diagnostics.input_colors, 3);
    assert.ok(result.diagnostics.output_colors <= 2);
    assert.deepEqual([...result.image.data.slice(8, 12)], [0, 0, 0, 0]);
    assert.deepEqual(result.image, processColors(image, { colors: 2, color_mode }, libraries).image);
  }
});

test('equal-frequency palette ties are deterministic and color bins use real colors', () => {
  const equal = bytes([[255, 255, 255, 255], [0, 0, 0, 255]]);
  assert.deepEqual([...processColors(equal, { colors: 1, color_mode: 'rgb' }, libraries).image.data], [0, 0, 0, 255, 0, 0, 0, 255]);
  const rows = Array.from({ length: 2304 }, (_, i) => [(i >> 8) * 23, (i >> 4 & 15) * 17, (i & 15) * 17, 255]);
  const image = bytes(rows), result = processColors(image, { colors: 8, color_mode: 'rgb' }, libraries);
  const original = new Set(rows.map(row => row.slice(0, 3).join(',')));
  assert.ok(result.diagnostics.output_colors <= 8);
  for (let p = 0; p < result.image.data.length; p += 4) assert.ok(original.has([...result.image.data.slice(p, p + 3)].join(',')));
});

test('all nine libraries constrain colors independently of grid recovery', () => {
  const image = bytes([[25, 35, 65, 255], [240, 210, 110, 255], [210, 30, 50, 90], [0, 0, 0, 0]]);
  assert.equal(paletteCatalog(libraries).length, 9);
  for (const library of paletteCatalog(libraries)) {
    for (const color_mode of ['rgb', 'natural']) {
      const palette = new Set(paletteRgb(library.id, libraries).map(row => row.join(',')));
      const result = processColors(image, { colors: 2, palette: library.id, color_mode }, libraries);
      assert.ok(result.diagnostics.output_colors <= 2);
      assert.equal(result.diagnostics.library.id, library.id);
      for (let p = 0; p < 12; p += 4) assert.ok(palette.has([...result.image.data.slice(p, p + 3)].join(',')));
    }
  }
  assert.throws(() => processColors(image, { colors: 513 }, libraries), /colors/);
});
