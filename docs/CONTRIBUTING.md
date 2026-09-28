# Contributing to RealPixelArt

The Python API and browser engine implement the same stages. The website and
Tauri and Electron apps share the JavaScript engine; neither ships a Python interpreter.
Start at `pipeline.pixelize()` (Python) or `core/pipeline.js` (JavaScript).

## Five functional modules

| File | Responsibility | Main entry points |
| --- | --- | --- |
| `config.py` | Options, shared limits and validation. | `Config`, `validate_scale`, `validate_color_options` |
| `pipeline.py` | Run stages, measure time and return results. | `pixelize`, `PixelizeResult` |
| `grid.py` | Source-resolution features, grid detection, cuts, validation and fallback selection. | `extract_features`, `detect_grid`, `validate_grid_segments`, `route_image` |
| `sampling.py` | Cell colors/alpha, color distance, optional reduction and palette matching. | `recover_cells`, `render_cells`, `process_colors` |
| `tools.py` | Decode/normalize images, export PNGs and draw optional diagnostics. | `load_image`, `to_pil`, `export_png`, `save_result`, `write_debug` |

`__init__.py` exposes the public API; `__main__.py` parses CLI arguments.
`palettes.json` stores color libraries. NumPy and Pillow remain the only runtime
dependencies; pytest is a development dependency.

## Dependency direction

```text
pipeline -> config, grid, sampling, tools
grid     -> config
sampling -> config, tools
tools    -> config
config   -> Python standard library
```

Lower-level modules must not import `pipeline` or the package root. Avoid cycles
even inside delayed imports. Optional Pillow drawing support is loaded only
when diagnostics are requested; this is unrelated to package dependencies.
The regression suite checks both the module layout and these dependency rules.

Keep sampling and recoloring independently callable even though they share a
file. Changing a color limit or palette must use the cached native image, without
detecting its grid or sampling its cells again. Diagnostic previews must never
become evidence for detection.

## Preserve numerical behavior

- Internal images are float32 RGBA in `[0, 1]`, using encoded sRGB. Fully
  transparent RGB is cleared and must not vote in color recovery.
- Grid cuts use source coordinates and cover the full image. Sampling rounds
  cuts to integer, half-open boxes, including partial edge cells.
- Keep reduction order, candidate order, tie-breaking and threshold comparisons
  unchanged during a refactor. Changing them can change output pixels.
- Distinguish recovered, estimated, generated and native-preserved grids in the
  metadata. A heuristic confidence score is not a correctness probability.
- Color postprocessing preserves alpha and dimensions. Export enlargement uses
  nearest-neighbor sampling and never reruns the algorithm.

Follow [PEP 8 naming conventions](https://peps.python.org/pep-0008/#naming-conventions):
snake_case for functions and variables, CapWords for classes, and UPPER_CASE for
constants. Keep established, reasonable names and public keyword arguments.
Short mathematical names such as `rgb`, `sx`, `x`, and `y` are useful in context;
avoid ambiguous single letters `l`, `O`, and `I`. Group standard-library,
third-party and package imports separately.

## Validate a change

From the project root:

```bash
python -m pip install -e ".[test]"
python -m pytest src/tests/test_realpixelart.py -q
python realpixelart.py -i input/lastTour.png --debug
python scripts/export_web_reference.py
npm --prefix web test
node web/build.mjs
node web/build.mjs --check
cd desktop
npm ci
npm test
npm run test:rust
npm run test:native
```

Keep regression cases in the existing test file. For a behavior-preserving
change, freeze the old package and compare output pixels, grid parameters,
confidence and diagnostics on the same real and synthetic inputs. Measure
performance separately: warm up both versions, alternate execution order and
report repeated measurements with the environment. Preserve slow results too.

Commit the JavaScript source and updated `web/core-manifest.json` with changes.
The existing desktop executable needs rebuilding for a new release. See
[web architecture](../web/README.md) for the module map and parity constraints.
Python is used only for reference tests during development/CI; building or
running the static website does not require Python.

## Internal import migration

The package-level API remains unchanged, including
`from realpixelart import Config, pixelize, process_colors, save_result`.
Direct imports from the former internal modules should use these locations:

| Former module | Current module |
| --- | --- |
| `features`, grid functions in `natural` | `grid` |
| `color_math`, `palette`, `natural.render_cells` | `sampling` |
| Palette constants and `validate_color_options` | `config` |
| `image_io`, `diagnostics` | `tools` |

Old module files are removed rather than retained as compatibility shells.
