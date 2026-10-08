"""Fast single-grid pipeline; the Python API has no filesystem side effects."""
from dataclasses import dataclass, field
from time import perf_counter

import numpy as np
from PIL import Image

from .config import Config
from .grid import extract_features, detect_grid, validate_grid_segments, route_image
from .sampling import (
    CellResult, _resolve_alpha_mode, recover_cells, render_cells, process_colors,
)
from .tools import load_image, to_pil


@dataclass
class PixelizeResult:
    image: Image.Image
    grid: dict
    confidence: float
    timings: dict
    diagnostics: dict
    cell_confidence: np.ndarray = field(repr=False)
    debug_data: dict = field(default_factory=dict, repr=False)
    native_image: Image.Image | None = field(default=None, repr=False)


def pixelize(image, config=None):
    """Return a native image; config.scale affects export only."""
    config = Config() if config is None else config
    if not isinstance(config, Config):
        raise TypeError("config must be a Config instance")
    start = perf_counter()
    data = load_image(image)
    rgba = data.rgba
    h, w = rgba.shape[:2]
    timings = {"read_preprocess": perf_counter() - start}
    t = perf_counter()
    features = extract_features(rgba)
    timings["fft_edges"] = perf_counter() - t
    t = perf_counter()
    chosen, search = detect_grid(features, rgba.shape, config)
    search['feature_sampling'] = features.mode
    fw, fh = features.spectrum_size or (w, h)
    search['fft_view'] = dict(size=[fw, fh], origin=[(w-fw)//2, (h-fh)//2],
                             display_only=features.spectrum_size is not None)
    timings["grid_detection"] = perf_counter() - t
    t = perf_counter()
    chosen = validate_grid_segments(rgba, features, chosen, search)
    timings['grid_validation'] = perf_counter() - t
    t = perf_counter()
    chosen, routing = route_image(rgba, features, chosen, config, search.get('axis_segments'))
    search['image_routing'] = routing
    timings['image_routing'] = perf_counter() - t
    stylized = chosen is not None and chosen.metadata.get('stylized', False)
    t = perf_counter()
    warnings = []
    source = None
    if data.metadata.get('frames', 1) > 1:
        warnings.append(f"MPO photo: selected frame {data.metadata['selected_frame'] + 1} of "
                        f"{data.metadata['frames']} ({data.metadata['selection']}); supplementary images ignored.")
    if chosen is None:
        # load_image owns this buffer. A full-size fallback need not allocate a
        # second float RGBA image just to return the same pixels.
        cells = CellResult(rgba, np.zeros((h, w), np.float32))
        alpha_mode, near_opaque = _resolve_alpha_mode(rgba[..., 3], config.alpha_mode)
        cells.structure.update(alpha_mode_requested=config.alpha_mode, alpha_mode=alpha_mode,
                               source_near_opaque_fraction=near_opaque)
        if alpha_mode == "binary":
            source = to_pil(rgba, True)
            for start_row in range(0, h, 64):
                stripe = cells.rgba[start_row:start_row + 64]
                stripe[..., 3] = stripe[..., 3] >= .5
                stripe[stripe[..., 3] == 0, :3] = 0
        grid = dict(sx=1., sy=1., phase_x=0., phase_y=0., x_lines=list(range(w + 1)),
                    y_lines=list(range(h + 1)), warped=False, source="no evidence")
        confidence = 0.
        warnings.append("No reliable grid evidence; preserved original dimensions (low confidence).")
    else:
        cells = (render_cells(rgba, chosen, config) if stylized else
                 recover_cells(rgba, chosen.x_lines, chosen.y_lines, config.sampling,
                               alpha_mode=config.alpha_mode))
        grid = dict(sx=chosen.sx, sy=chosen.sy, phase_x=chosen.phase_x, phase_y=chosen.phase_y,
                    x_lines=np.rint(chosen.x_lines).astype(int).tolist(),
                    y_lines=np.rint(chosen.y_lines).astype(int).tolist(),
                    warped=chosen.warped, source=chosen.metadata["source"])
        confidence = chosen.support
        if chosen.metadata.get('estimated'):
            warnings.append("Estimated grid from axis-aligned edges; original lattice unconfirmed (low confidence).")
        elif stylized:
            warnings.append("Applied conservative ordinary-image pixelization; the rendering grid is generated, not a detected original grid.")
        elif confidence < config.confidence_threshold:
            warnings.append("Low heuristic grid confidence; check the grid overlay.")
    timings["sampling"] = perf_counter() - t
    t = perf_counter()
    native = to_pil(cells.rgba, data.has_alpha)
    source = source if source is not None else to_pil(rgba, True)
    cell_confidence, structure, input_metadata = cells.confidence, cells.structure, data.metadata
    # Release floating source/recovery buffers before optional color work.
    del cells, rgba, data
    timings['prepare_images'] = perf_counter() - t
    t = perf_counter()
    colored = process_colors(native, colors=config.colors, palette=config.palette,
                             color_mode=config.color_mode, no_semitransparent=config.no_semitransparent)
    timings["palette"] = perf_counter() - t
    output = colored.image
    grid.update(output_size=list(output.size), input_size=[w, h], fallback=chosen is None, stylized=bool(stylized),
                estimated=chosen is not None and chosen.metadata.get('estimated', False),
                native_preserved=chosen is not None and chosen.metadata.get('native_preserved', False),
                coverage="full input; integer half-open source boxes",
                median_cell_width=float(np.median(np.diff(grid["x_lines"]))),
                median_cell_height=float(np.median(np.diff(grid["y_lines"]))))
    debug = dict(source=source, spectrum=features.spectrum,
                 spectrum_size=features.spectrum_size or (w, h), feature_sampling=features.mode,
                 edge_x=features.gradient_x if features.preview_edges is None else features.preview_edges[0],
                 edge_y=features.gradient_y if features.preview_edges is None else features.preview_edges[1],
                 profile_x=features.profile_x, profile_y=features.profile_y,
                 curvature_x=features.curvature_x, curvature_y=features.curvature_y)
    timings["total"] = perf_counter() - start
    return PixelizeResult(output, grid, confidence, timings,
                          dict(warnings=warnings, input=input_metadata, fallback=chosen is None,
                               confidence_kind="uncalibrated heuristic score", grid_search=search,
                               structure=structure, selected_score=0. if stylized or grid['estimated'] else search.get("selected_score"),
                               color_processing=colored.diagnostics),
                          cell_confidence, debug, native_image=native)
