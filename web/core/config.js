/** Options shared by the worker, numerical core, and UI manifest. */
export const DENSE_PIXEL_LIMIT = 4_000_000;
export const MAX_COLORS = 512;
export const PALETTE_IDS = Object.freeze([
  'DMC436', 'MARD24', 'MARD48', 'MARD72', 'MARD96', 'MARD120',
  'MARD144', 'MARD221', 'MARD280',
]);
export const DEFAULTS = Object.freeze({
  colors: null, palette: null, color_mode: 'natural', scale: 1,
  sampling: 'robust', alpha_mode: 'auto', local_warp: 'auto', photo_mode: 'auto',
  min_pixel_size: 2, max_pixel_size: 64, square: false, confidence_threshold: 0.45,
});

export function validateScale(scale) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
    throw new Error('scale must be an integer from 1 to 16');
  }
  return scale;
}

export function validateColorOptions({ colors = null, palette = null, color_mode = 'natural' } = {}) {
  if (colors !== null && (!Number.isInteger(colors) || colors < 1 || colors > MAX_COLORS)) {
    throw new Error(`colors must be an integer from 1 to ${MAX_COLORS}`);
  }
  if (palette !== null && !PALETTE_IDS.includes(palette)) throw new Error('unknown palette');
  if (!['natural', 'rgb'].includes(color_mode)) throw new Error('color_mode must be natural or rgb');
}

export function configuration(options = {}) {
  for (const name of Object.keys(options)) {
    if (!(name in DEFAULTS)) throw new Error(`unknown configuration option: ${name}`);
  }
  const config = { ...DEFAULTS, ...options };
  validateColorOptions(config);
  validateScale(config.scale);
  for (const [name, choices] of Object.entries({
    sampling: ['robust', 'center', 'median'], alpha_mode: ['auto', 'binary', 'coverage'],
    local_warp: ['auto', 'off'], photo_mode: ['auto', 'off'],
  })) {
    if (!choices.includes(config[name])) throw new Error(`${name} must be ${choices.join(' or ')}`);
  }
  if (!(Number.isFinite(config.min_pixel_size) && Number.isFinite(config.max_pixel_size)
      && config.min_pixel_size >= 1 && config.min_pixel_size <= config.max_pixel_size)) {
    throw new Error('scale range must satisfy 1 <= min_pixel_size <= max_pixel_size');
  }
  if (!(config.confidence_threshold >= 0 && config.confidence_threshold <= 1)) {
    throw new Error('confidence_threshold must lie in [0,1]');
  }
  return config;
}
