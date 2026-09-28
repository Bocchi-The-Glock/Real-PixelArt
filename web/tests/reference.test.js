/** Cross-language oracle: generate fixtures with scripts/export_web_reference.py.
 * The browser engine itself never imports Python or downloads these test files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pixelize } from '../core/pipeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = process.env.REALPIXELART_REFERENCE_DIR || path.join(root, 'build/web-reference');
const manifestPath = path.join(directory, 'manifest.json');
const libraries = JSON.parse(fs.readFileSync(path.join(root, 'web/core/palettes.json'), 'utf8'));

test('Python and JavaScript ship identical color libraries', () => {
  assert.deepEqual(libraries, JSON.parse(fs.readFileSync(path.join(root, 'src/realpixelart/palettes.json'), 'utf8')));
});

function compareGrid(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === 'number') assert.ok(Math.abs(actual[key] - value) <= 1e-6,
      `grid.${key}: ${actual[key]} differs from ${value}`);
    else assert.deepEqual(actual[key], value, `grid.${key}`);
  }
}

if (!fs.existsSync(manifestPath)) {
  test('Python reference fixtures', { skip: 'Run python scripts/export_web_reference.py, then rerun these tests.' }, () => {});
} else {
  const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const filename of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    test(`Python parity: ${fixture.name}`, () => {
      const source = { ...fixture.image, data: new Uint8Array(fs.readFileSync(path.join(directory, fixture.image.source))) };
      const actual = pixelize(source, fixture.config, libraries);
      assert.equal(actual.image.width, fixture.expected.width, 'output width');
      assert.equal(actual.image.height, fixture.expected.height, 'output height');
      for (const [key, filenameKey] of [['image', 'output'], ['native_image', 'native']]) {
        const expected = fs.readFileSync(path.join(directory, fixture.expected[filenameKey]));
        assert.equal(actual[key].data.length, expected.length, `${key} RGBA length`);
        // Stop at the first differing channel; printing full image buffers makes
        // a failure unnecessarily huge and hides the useful location/value.
        for (let i = 0; i < expected.length; i++) if (actual[key].data[i] !== expected[i]) {
          assert.fail(`${key} pixel ${Math.floor(i / 4)}, channel ${i % 4}: ${actual[key].data[i]} !== ${expected[i]}`);
        }
      }
      compareGrid(actual.grid, fixture.expected.grid);
      assert.ok(Math.abs(actual.confidence - fixture.expected.confidence) <= 1e-6, 'heuristic confidence');
      const oldSearch = fixture.expected.diagnostics.grid_search;
      const newSearch = actual.diagnostics.grid_search;
      assert.equal(newSearch.evidence_model, oldSearch.evidence_model, 'evidence model');
      assert.equal(newSearch.axis_segments.decision, oldSearch.axis_segments.decision, 'segment validation');
      assert.equal(newSearch.image_routing.reason, oldSearch.image_routing.reason, 'routing reason');
      assert.deepEqual(actual.diagnostics.warnings, fixture.expected.diagnostics.warnings, 'diagnostic warnings');
    });
  }
}
