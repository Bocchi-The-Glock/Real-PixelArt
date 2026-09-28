/** Browser-independent processing API. Image files and UI belong to adapters. */
import { configuration } from './config.js';
import { extractFeatures } from './features.js';
import { detectGrid, validateGridSegments, routeImage } from './grid.js';
import { recoverCells, renderCells, resolveAlphaMode, processColors } from './sampling.js';
import { byteImage, floatImage } from './tools.js';
import { median, diff, roundEven } from './numeric.js';

const now = () => performance.now() / 1000;

export function pixelize(source, options = {}, libraries = {}) {
  const config = configuration(options), start = now(), image = floatImage(source);
  const { width: w, height: h } = image;
  const timings = { read_preprocess: now() - start };
  let t = now();
  const features = extractFeatures(image);
  timings.fft_edges = now() - t;
  t = now();
  let { chosen, report: search } = detectGrid(features, image, config);
  search.feature_sampling = features.mode;
  const [fw, fh] = features.spectrum_size || [w, h];
  search.fft_view = { size: [fw, fh], origin: [Math.floor((w-fw)/2), Math.floor((h-fh)/2)], display_only: features.spectrum_size !== null };
  timings.grid_detection = now() - t;
  t = now(); chosen = validateGridSegments(image, features, chosen, search);
  timings.grid_validation = now() - t;
  t = now();
  const routed = routeImage(image, features, chosen, config, search.axis_segments);
  chosen = routed.chosen; search.image_routing = routed.report;
  timings.image_routing = now() - t;
  t = now();
  const stylized = !!chosen?.metadata.stylized, warnings = [];
  let cells, grid, confidence;
  if (source.metadata?.frames > 1) warnings.push(`MPO photo: selected frame ${source.metadata.selected_frame + 1} of ${source.metadata.frames} (${source.metadata.selection}); supplementary images ignored.`);
  if (!chosen) {
    const [mode, nearOpaque] = resolveAlphaMode(image, config.alpha_mode);
    cells = { rgba: image.data, width: w, height: h, confidence: new Float32Array(w*h),
      structure: { alpha_mode_requested: config.alpha_mode, alpha_mode: mode, source_near_opaque_fraction: nearOpaque } };
    if (mode === 'binary') for (let i = 0; i < image.data.length; i += 4) {
      image.data[i+3] = image.data[i+3] >= .5 ? 1 : 0;
      if (!image.data[i+3]) image.data[i] = image.data[i+1] = image.data[i+2] = 0;
    }
    grid = { sx: 1, sy: 1, phase_x: 0, phase_y: 0,
      x_lines: Array.from({length: w+1}, (_, i) => i), y_lines: Array.from({length: h+1}, (_, i) => i), warped: false, source: 'no evidence' };
    confidence = 0;
    warnings.push('No reliable grid evidence; preserved original dimensions (low confidence).');
  } else {
    cells = stylized ? renderCells(image, chosen, config) : recoverCells(image, chosen.x_lines, chosen.y_lines, config.sampling, config.alpha_mode);
    grid = { sx: chosen.sx, sy: chosen.sy, phase_x: chosen.phase_x, phase_y: chosen.phase_y,
      x_lines: Array.from(chosen.x_lines, roundEven), y_lines: Array.from(chosen.y_lines, roundEven), warped: chosen.warped, source: chosen.metadata.source };
    confidence = chosen.support;
    if (chosen.metadata.estimated) warnings.push('Estimated grid from axis-aligned edges; original lattice unconfirmed (low confidence).');
    else if (stylized) warnings.push('Applied conservative ordinary-image pixelization; the rendering grid is generated, not a detected original grid.');
    else if (confidence < config.confidence_threshold) warnings.push('Low heuristic grid confidence; check the grid overlay.');
  }
  timings.sampling = now() - t;
  t = now(); const native = byteImage(cells, source.has_alpha);
  timings.prepare_images = now() - t;
  t = now(); const colored = processColors(native, config, libraries);
  timings.palette = now() - t;
  Object.assign(grid, { output_size: [colored.image.width, colored.image.height], input_size: [w,h], fallback: !chosen,
    stylized, estimated: !!chosen?.metadata.estimated, native_preserved: !!chosen?.metadata.native_preserved,
    coverage: 'full input; integer half-open source boxes',
    median_cell_width: median(diff(grid.x_lines)), median_cell_height: median(diff(grid.y_lines)) });
  const debug = { source, spectrum: features.spectrum, spectrum_size: features.spectrum_size || [w,h], feature_sampling: features.mode,
    edge_x: features.preview_edges?.[0] || features.gradient_x, edge_y: features.preview_edges?.[1] || features.gradient_y,
    profile_x: features.profile_x, profile_y: features.profile_y, curvature_x: features.curvature_x, curvature_y: features.curvature_y };
  timings.total = now() - start;
  return { image: colored.image, native_image: native, grid, confidence, timings, cell_confidence: cells.confidence, debug_data: debug,
    diagnostics: { warnings, input: source.metadata || {}, fallback: !chosen, confidence_kind: 'uncalibrated heuristic score',
      grid_search: search, structure: cells.structure, selected_score: stylized || grid.estimated ? 0 : search.selected_score,
      color_processing: colored.diagnostics } };
}
