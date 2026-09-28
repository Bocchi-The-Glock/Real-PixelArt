import { t, translate, setLanguage, language, preference } from './i18n.js';

const $ = id => document.getElementById(id);
let file = null, worker = null, busy = false, operation = '', generation = 0, defaults = null;
let engine = { state: 'idle', key: 'starting', detail: '' };
let result = null, stale = false, urls = [], originalUrl = null, downloadUrl = null, previewUnavailable = false;
let palettes = [], colorTimer = null, colorDirty = false;
let colorCount = null, colorMaximum = 512, colorRevision = 0, pendingColorRevision = 0;
const colorMinimumStop = 200; // Short, distinct stops for Unlimited and 2.
const views = { original: { factor: null, x: 0, y: 0 }, result: { factor: null, x: 0, y: 0 } };
let status = { key: 'selectImage', kind: '', values: {} };
let theme = preference('realpixelart-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function renderTheme() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#101112' : '#f6f7f5';
  $('theme-toggle').title = t(theme === 'dark' ? 'day' : 'night');
  $('theme-toggle').setAttribute('aria-label', $('theme-toggle').title);
  $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
  $('language-toggle').title = language === 'zh' ? 'Switch to English' : '切换中文';
  $('language-toggle').setAttribute('aria-label', $('language-toggle').title);
  $('language-label').textContent = language === 'zh' ? 'EN' : '中';
}
function renderState() {
  $('run').textContent = t(busy && operation === 'process' ? 'generating' : 'generate');
  $('original-label').textContent = file?.name || t('noFile');
  $('original-placeholder').querySelector('strong').textContent = t(previewUnavailable ? 'previewLater' : 'choose');
  $('scale-value').textContent = `${$('scale').value}×`;
  if (result) {
    const [width, height] = result.meta.grid.output_size, scale = Number($('scale').value);
    $('result-size').textContent = `${width} × ${height}` + (scale === 1 ? '' : ` (${width * scale} × ${height * scale})`);
  } else $('result-size').textContent = '—';
  renderColorLimit();
  let visibleStatus = status;
  if (engine.state === 'loading' && status.kind !== 'error') visibleStatus = { key: engine.key, kind: 'busy' };
  else if (engine.state === 'error' && !busy && status.kind !== 'error') visibleStatus = { key: 'engineFailed', kind: 'error', values: { detail: engine.detail } };
  else if (engine.state === 'ready' && ['selectImage', 'ready'].includes(status.key)) visibleStatus = { key: 'engineReady', kind: '' };
  $('status').textContent = t(visibleStatus.key, visibleStatus.values);
  $('status').dataset.engineState = engine.state;
  $('status').parentElement.className = `status-strip ${visibleStatus.kind}`;
  $('status-icon').textContent = visibleStatus.kind === 'busy' ? '◌' : visibleStatus.kind === 'error' ? '!' : '○';
  if (result?.meta.grid.native_preserved && visibleStatus.key === 'done') $('status').textContent = t('nativePreserved');
  if (result?.meta.grid.stylized && visibleStatus.key === 'done') $('status').textContent = t('stylized');
  if (result?.meta.grid.estimated && visibleStatus.key === 'done') $('status').textContent = t('estimatedGrid');
  const active = $('diagnostic-tabs').querySelector('.active');
  if (active) $('diagnostic-image').alt = t(active.dataset.i18n);
  for (const option of $('palette').options) {
    const item = palettes.find(p => p.id === option.value);
    if (item) option.textContent = t('paletteName', { brand: item.brand, size: item.nominal_size });
  }
  const library = palettes.find(p => p.id === $('palette').value);
  $('palette-note').hidden = !$('use-palette').checked || !library || library.nominal_size === library.unique_colors;
  if (library) $('palette-note').textContent = t('paletteNote', { nominal: library.nominal_size, actual: library.unique_colors });
  const colorInfo = result?.meta.color_processing;
  $('color-summary').textContent = colorInfo?.applied ? t('colorCount', {
    count: colorInfo.output_colors, seconds: (result.colorSeconds ?? result.meta.timings.palette).toFixed(2) }) : '';
  renderTheme();
}
function setStatus(key, kind = '', values = {}) {
  status = { key, kind, values };
  renderState();
}
function setBusy(value, kind = '') {
  busy = value; operation = kind;
  $('settings-fields').disabled = value;
  $('color-fields').disabled = value && kind !== 'recolor';
  $('run').disabled = value || !file || !defaults;
  $('upload').disabled = value;
  $('original-stage').setAttribute('aria-disabled', String(value));
  $('original-stage').classList.remove('dragover');
  $('sample').disabled = value; $('clear-file').disabled = value;
  $('cancel').hidden = !value;
  $('scale').disabled = value && kind === 'export';
  $('download').disabled = value || !result || stale || colorDirty;
  $('download').setAttribute('aria-disabled', String($('download').disabled));
  $('download-debug').hidden = !result?.meta.debug || stale || colorDirty || value;
  renderState();
}
function invalidate() {
  clearTimeout(colorTimer);
  if (!result) return;
  stale = true; $('download-debug').hidden = true; $('diagnostics').hidden = true;
  setBusy(false); setStatus('staleStatus');
}
function clearResult() {
  clearTimeout(colorTimer); colorDirty = false;
  for (const url of urls) URL.revokeObjectURL(url);
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  urls = []; downloadUrl = null; result = null; stale = false;
  $('result-image').removeAttribute('src'); $('result-image').hidden = true;
  $('result-placeholder').hidden = false; $('result-summary').hidden = true;
  $('diagnostics').hidden = true; $('download-debug').hidden = true;
  $('diagnostic-tabs').replaceChildren(); $('diagnostic-image').removeAttribute('src');
  $('download-debug').removeAttribute('href'); $('result-size').textContent = '—';
  Object.assign(views.result, { factor: null, x: 0, y: 0 }); refreshZoom();
  setBusy(false);
}
async function useFile(next) {
  if (busy || !next) return;
  if (next.size > 64 * 1024 * 1024) { setStatus('largeFile', 'error'); return; }
  file = next; generation++; clearResult(); previewUnavailable = false;
  Object.assign(views.original, { factor: null, x: 0, y: 0 });
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = URL.createObjectURL(file);
  $('clear-file').hidden = false;
  $('original-image').hidden = false; $('original-placeholder').hidden = true;
  $('original-image').src = originalUrl; $('original-size').textContent = '—';
  refreshZoom();
  setStatus('ready');
}
function zoomBounds(name) {
  const image = $(`${name}-image`), stage = $(`${name}-stage`), padding = getComputedStyle(stage);
  const padX = parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight);
  const padY = parseFloat(padding.paddingTop) + parseFloat(padding.paddingBottom);
  let fit = Math.max(.0001, Math.min((stage.clientWidth - padX) / image.naturalWidth,
    (stage.clientHeight - padY) / image.naturalHeight));
  if (name === 'result' && fit >= 1) fit = Math.floor(fit);
  if (name === 'original') fit = Math.min(1, fit);
  return { fit, min: Math.min(.01, fit / 4), max: Math.max(32, fit * 4) };
}
function renderZoom(name) {
  const image = $(`${name}-image`), stage = $(`${name}-stage`), view = views[name];
  const unavailable = image.hidden || !image.complete || !image.naturalWidth;
  $(`${name}-zoom-controls`).hidden = unavailable;
  for (const suffix of ['zoom-in', 'zoom-out', 'fit']) $(`${name}-${suffix}`).disabled = unavailable;
  if (unavailable) { $(`${name}-zoom-value`).textContent = '—'; return; }
  const bounds = zoomBounds(name), factor = views[name].factor ?? bounds.fit;
  image.style.width = `${Math.max(1, image.naturalWidth * factor)}px`;
  image.style.height = `${Math.max(1, image.naturalHeight * factor)}px`;
  // Keep a small part visible so a dragged image is always recoverable.
  for (const [axis, size, viewport] of [['x', image.naturalWidth * factor, stage.clientWidth],
    ['y', image.naturalHeight * factor, stage.clientHeight]]) {
    const limit = (viewport + size) / 2 - Math.min(32, size, viewport);
    view[axis] = Math.max(-limit, Math.min(limit, view[axis]));
  }
  image.style.transform = `translate(${(stage.clientWidth - image.naturalWidth * factor) / 2 + view.x}px, ${(stage.clientHeight - image.naturalHeight * factor) / 2 + view.y}px)`;
  stage.scrollTo(0, 0);
  $(`${name}-zoom-in`).disabled = factor >= bounds.max;
  $(`${name}-zoom-out`).disabled = factor <= bounds.min;
  const text = `${Number((factor * 100).toFixed(1))}%`;
  $(`${name}-zoom-value`).textContent = text;
}
function setZoom(name, factor, point = null) {
  const image = $(`${name}-image`), stage = $(`${name}-stage`);
  if (image.hidden || !image.naturalWidth) return;
  const bounds = zoomBounds(name), rect = image.getBoundingClientRect(), viewport = stage.getBoundingClientRect(), view = views[name];
  const anchor = point || { x: viewport.left + stage.clientWidth / 2, y: viewport.top + stage.clientHeight / 2 };
  const pixel = { x: (anchor.x - rect.left) / rect.width, y: (anchor.y - rect.top) / rect.height };
  view.factor = factor === null ? null : Math.max(bounds.min, Math.min(bounds.max, factor));
  const nextFactor = view.factor ?? bounds.fit;
  view.x = factor === null ? 0 : anchor.x - viewport.left - stage.clientWidth / 2 + (0.5 - pixel.x) * image.naturalWidth * nextFactor;
  view.y = factor === null ? 0 : anchor.y - viewport.top - stage.clientHeight / 2 + (0.5 - pixel.y) * image.naturalHeight * nextFactor;
  renderZoom(name);
}
function refreshZoom() { for (const name of Object.keys(views)) renderZoom(name); }
for (const name of Object.keys(views)) {
  const stage = $(`${name}-stage`), image = $(`${name}-image`);
  let drag = null, suppressClick = false;
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
    suppressClick = false;
    if (image.hidden || !image.complete || !image.naturalWidth) return;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: views[name].x, y: views[name].y, moved: false };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    stage.classList.add('panning'); event.preventDefault();
    views[name].x = drag.x + dx; views[name].y = drag.y + dy;
    renderZoom(name);
  });
  function finishDrag(event) {
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
    const { id, moved } = drag;
    drag = null; suppressClick = moved; stage.classList.remove('panning');
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, finishDrag);
  window.addEventListener('blur', finishDrag);
  // A drag still produces a browser click: consume it before the upload handler.
  stage.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  for (const [suffix, multiplier] of [['zoom-in', 1.25], ['zoom-out', .8]]) {
    $(`${name}-${suffix}`).onclick = () => setZoom(name, (views[name].factor ?? zoomBounds(name).fit) * multiplier);
  }
  $(`${name}-fit`).onclick = () => setZoom(name, null);
  $(`${name}-stage`).addEventListener('wheel', event => {
    if ($(`${name}-image`).hidden || !$(`${name}-image`).naturalWidth || !event.deltaY) return;
    event.preventDefault();
    const { fit } = zoomBounds(name), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1);
    setZoom(name, (views[name].factor ?? fit) * Math.exp(-Math.max(-300, Math.min(300, delta)) * .002),
      { x: event.clientX, y: event.clientY });
  }, { passive: false });
}
$('original-image').onload = () => { $('original-size').textContent = `${$('original-image').naturalWidth} × ${$('original-image').naturalHeight}`; refreshZoom(); };
$('original-image').onerror = () => { previewUnavailable = true; $('original-image').hidden = true; $('original-placeholder').hidden = false; refreshZoom(); renderState(); };
$('result-image').onload = refreshZoom;
const observer = new ResizeObserver(refreshZoom);
observer.observe($('original-stage')); observer.observe($('result-stage'));
$('background').onchange = () => { for (const id of ['original-stage', 'result-stage']) $(id).className = `image-stage ${$('background').value}`; };
$('theme-toggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; preference('realpixelart-theme', theme); renderTheme(); };
$('language-toggle').onclick = () => { setLanguage(language === 'zh' ? 'en' : 'zh'); renderState(); refreshZoom(); };
$('scale').oninput = renderState; // Export-only setting: never invalidates or regenerates the native result.

function renderColorLimit() {
  $('colors').value = String(colorCount === null ? 0 : colorMinimumStop +
    Math.round((colorCount - 2) / (colorMaximum - 2) * (1000 - colorMinimumStop)));
  const label = colorCount === null ? t('keepColors') : String(colorCount);
  $('colors-value').textContent = label; $('colors-max').textContent = String(colorMaximum);
  $('colors-value').hidden = colorCount !== null;
  $('color-editor').hidden = colorCount === null;
  $('colors-number').disabled = colorCount === null;
  $('colors-number').max = String(colorMaximum);
  if (document.activeElement !== $('colors-number')) $('colors-number').value = String(colorCount ?? 2);
  $('colors-decrease').disabled = colorCount === null || colorCount <= 2;
  $('colors-increase').disabled = colorCount === null || colorCount >= colorMaximum;
  $('colors').setAttribute('aria-valuetext', label);
}
function visibility() {
  const library = palettes.find(p => p.id === $('palette').value);
  colorMaximum = $('use-palette').checked && library ? library.unique_colors : 512;
  if (colorCount !== null) colorCount = Math.min(colorMaximum, Math.max(2, colorCount));
  $('palette').disabled = !$('use-palette').checked;
  renderState();
}
$('colors').oninput = () => {
  const position = Number($('colors').value);
  colorCount = position < colorMinimumStop / 2 ? null : 2 + Math.round(
    Math.max(0, position - colorMinimumStop) / (1000 - colorMinimumStop) * (colorMaximum - 2));
};
$('colors').onkeydown = event => {
  const increments = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
  if (!(event.key in increments) && !['Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 1 : event.key === 'End' ? colorMaximum : (colorCount ?? 1) + increments[event.key];
  colorCount = next <= 1 ? null : Math.min(colorMaximum, next);
  scheduleColors();
};
function commitColorNumber() {
  if (colorCount === null) return;
  const value = $('colors-number').valueAsNumber;
  const next = Number.isFinite(value) ? Math.min(colorMaximum, Math.max(2, Math.round(value))) : colorCount;
  $('colors-number').value = String(next);
  if (next !== colorCount) { colorCount = next; scheduleColors(); }
}
$('colors-number').oninput = event => event.stopPropagation();
$('colors-number').onchange = commitColorNumber;
$('colors-number').onblur = commitColorNumber;
$('colors-number').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); commitColorNumber(); $('colors-number').blur(); }
  if (event.key === 'Escape') { $('colors-number').value = String(colorCount); $('colors-number').blur(); }
};
for (const [id, amount] of [['colors-decrease', -1], ['colors-increase', 1]]) {
  $(id).onclick = () => {
    if (colorCount === null) return;
    colorCount = Math.max(2, Math.min(colorMaximum, colorCount + amount)); scheduleColors();
  };
}
function colorConfiguration() {
  return { colors: colorCount,
    palette: $('use-palette').checked ? $('palette').value : null, color_mode: $('color-mode').value };
}
function configuration() {
  return { ...defaults, scale: 1, sampling: $('sampling').value, alpha_mode: $('alpha-mode').value,
    local_warp: $('local-warp').value, min_pixel_size: Number($('min-size').value), max_pixel_size: Number($('max-size').value),
    square: $('square').checked, photo_mode: $('photo-mode').checked ? 'auto' : 'off', ...colorConfiguration() };
}
function coreConfiguration() {
  const { colors, palette, color_mode, ...core } = configuration(); return core;
}
function reset() {
  if (!defaults) return;
  const before = JSON.stringify(coreConfiguration()), wasDebug = $('debug').checked;
  HTMLFormElement.prototype.reset.call($('settings'));
  HTMLFormElement.prototype.reset.call($('color-settings'));
  for (const [key, id] of Object.entries({ sampling: 'sampling', alpha_mode: 'alpha-mode', local_warp: 'local-warp', min_pixel_size: 'min-size', max_pixel_size: 'max-size' })) $(id).value = String(defaults[key]);
  colorCount = defaults.colors;
  $('use-palette').checked = defaults.palette !== null;
  $('palette').value = defaults.palette || 'DMC436'; $('color-mode').value = defaults.color_mode;
  $('square').checked = defaults.square; $('photo-mode').checked = defaults.photo_mode === 'auto'; $('scale').value = String(defaults.scale);
  visibility();
  if (before !== JSON.stringify(coreConfiguration()) || wasDebug !== $('debug').checked) invalidate();
  else scheduleColors();
  renderState();
}
$('settings').addEventListener('input', () => { visibility(); invalidate(); });
$('color-settings').onsubmit = event => { event.preventDefault(); scheduleColors(); };
$('color-settings').addEventListener('input', scheduleColors);
function scheduleColors() {
  colorRevision++; visibility(); clearTimeout(colorTimer);
  if (!result || stale) return;
  colorDirty = true;
  if (busy) return; // A running recolor will queue the latest settings on completion.
  setBusy(false);
  if (!$('color-settings').checkValidity()) { setStatus('colorInvalid', 'error'); return; }
  colorTimer = setTimeout(() => {
    if (!result || stale || busy) return;
    const bytes = result.base.slice(0), id = ++generation;
    pendingColorRevision = colorRevision;
    const debugZip = result.debugZip?.slice(0);
    setBusy(true, 'recolor'); setStatus('coloring', 'busy');
    getWorker().postMessage({ type: 'recolor', id, bytes, settings: colorConfiguration(), debugZip },
      debugZip ? [bytes, debugZip] : [bytes]);
  }, 180);
}
$('reset').onclick = reset;
function blobUrl(buffer, mime = 'image/png') { const url = URL.createObjectURL(new Blob([buffer], { type: mime })); urls.push(url); return url; }
function showResult(data) {
  clearResult(); result = data;
  const { meta } = data;
  if (data.original) {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(new Blob([data.original], { type: 'image/png' }));
  }
  previewUnavailable = false; $('original-image').hidden = false; $('original-placeholder').hidden = true; $('original-image').src = originalUrl;
  $('result-image').src = blobUrl(data.native); $('result-image').hidden = false; $('result-placeholder').hidden = true;
  $('metric-grid').textContent = meta.grid.output_size.join(' × ');
  $('metric-spacing').textContent = `${meta.grid.sx.toFixed(2)} × ${meta.grid.sy.toFixed(2)}`;
  $('metric-confidence').textContent = meta.confidence.toFixed(3);
  $('metric-time').textContent = `${meta.timings.total_with_export.toFixed(2)} s`;
  $('result-summary').hidden = false;
  if (meta.debug) {
    $('download-debug').href = blobUrl(data.debugZip, 'application/zip');
    $('download-debug').download = meta.name.replace(/\.png$/i, '_debug.zip'); $('download-debug').hidden = false;
    $('diagnostics').hidden = false;
    for (const name of ['grid', 'fft', 'edges', 'profiles', 'curvature']) {
      const url = blobUrl(data.diagnostics[name + '.png']), button = document.createElement('button');
      button.type = 'button'; button.dataset.i18n = name; button.textContent = t(name);
      button.onclick = () => { $('diagnostic-image').src = url; $('diagnostic-image').alt = t(name);
        for (const sibling of $('diagnostic-tabs').children) sibling.classList.toggle('active', sibling === button); };
      $('diagnostic-tabs').append(button); if (name === 'grid') button.click();
    }
  }
  setBusy(false); setStatus('done');
}
function getWorker() {
  if (!worker) {
    const activeWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker = activeWorker;
    worker.onmessage = ({ data }) => {
      if (worker !== activeWorker) return;
      if (data.type === 'progress' && ['starting', 'loading'].includes(data.key)) {
        engine = { state: 'loading', key: data.key, detail: '' }; renderState(); return;
      }
      // Engine replies are independent of file changes and job generation IDs.
      // In particular, a ready reply must not unlock an already queued job.
      if (data.id === 'engine-init') {
        if (data.type === 'ready') engine = { state: 'ready', key: 'engineReady', detail: '' };
        else if (data.type === 'error') engine = { state: 'error', key: 'engineFailed', detail: data.message };
        renderState(); return;
      }
      if (data.id !== generation) return;
      if (data.type === 'progress') { if (busy) setStatus(data.key, 'busy'); return; }
      setBusy(false);
      if (data.type === 'result') showResult(data);
      if (data.type === 'recolor') {
        if (pendingColorRevision !== colorRevision) { scheduleColors(); return; }
        result.native = data.native; result.meta.color_processing = data.meta.color_processing;
        result.colorSeconds = data.meta.seconds; colorDirty = false;
        const previous = $('result-image').src;
        $('result-image').src = blobUrl(data.native); URL.revokeObjectURL(previous);
        if (data.debugZip) {
          URL.revokeObjectURL($('download-debug').href);
          result.debugZip = data.debugZip; $('download-debug').href = blobUrl(data.debugZip, 'application/zip');
        }
        setBusy(false); setStatus('colorDone');
      }
      if (data.type === 'export') {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(new Blob([data.output], { type: 'image/png' }));
        const link = document.createElement('a'); link.href = downloadUrl; link.download = result.meta.name;
        document.body.append(link); link.click(); link.remove(); setStatus('exported');
      }
      if (data.type === 'error') {
        if (data.code === 'memory') {
          // Release the worker and its image buffers. A later
          // request creates a fresh engine, including recoloring/export retries.
          worker.terminate(); worker = null;
          engine = { state: 'idle', key: 'starting', detail: '' };
          setStatus('memoryFailed', 'error');
        } else setStatus('failed', 'error', { detail: data.message.trim().split('\n').at(-1) });
      }
    };
    worker.onerror = event => {
      if (worker !== activeWorker) return;
      const initializing = engine.state === 'loading';
      worker.terminate(); worker = null;
      engine = { state: 'error', key: 'engineFailed', detail: event.message };
      setBusy(false); setStatus(initializing ? 'engineFailed' : 'failed', 'error', { detail: event.message });
    };
  }
  if (engine.state === 'idle' || engine.state === 'error') {
    engine = { state: 'loading', key: 'starting', detail: '' };
    worker.postMessage({ type: 'init', id: 'engine-init' });
    renderState();
  }
  return worker;
}
$('settings').onsubmit = async event => {
  event.preventDefault(); if (!file || busy || !defaults) return;
  if (!$('color-settings').reportValidity()) return;
  const id = ++generation;
  invalidate(); setBusy(true, 'process'); setStatus('reading', 'busy');
  try {
    const bytes = await file.arrayBuffer(); if (id !== generation) return;
    const preview = $('original-image');
    const preview_size = !previewUnavailable && !preview.hidden && preview.naturalWidth
      ? [preview.naturalWidth, preview.naturalHeight] : null;
    getWorker().postMessage({ type: 'process', id, bytes, request: { name: file.name, config: configuration(), debug: $('debug').checked, preview_size } }, [bytes]);
  } catch (error) { setBusy(false); setStatus('failed', 'error', { detail: error.message }); }
};
$('download').onclick = () => {
  if (!result || stale || busy || colorDirty) return;
  const bytes = result.native.slice(0), id = ++generation;
  setBusy(true, 'export'); setStatus('exporting', 'busy');
  getWorker().postMessage({ type: 'export', id, bytes, scale: Number($('scale').value) }, [bytes]);
};
$('cancel').onclick = () => {
  generation++; worker?.terminate(); worker = null;
  engine = { state: 'idle', key: 'starting', detail: '' };
  setBusy(false); setStatus('cancelled');
};
$('original-stage').onclick = () => { if (!busy) $('file-input').click(); };
$('upload').onclick = () => { if (!busy) $('file-input').click(); };
$('original-stage').onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!busy) $('file-input').click(); }
};
$('file-input').onchange = () => { useFile($('file-input').files[0]); $('file-input').value = ''; };
$('clear-file').onclick = () => {
  file = null; generation++; clearResult(); if (originalUrl) URL.revokeObjectURL(originalUrl); originalUrl = null; previewUnavailable = false;
  $('file-input').value = ''; $('clear-file').hidden = true; $('original-image').hidden = true; $('original-image').removeAttribute('src');
  $('original-placeholder').hidden = false; $('original-size').textContent = '—'; setStatus('selectImage');
  Object.assign(views.original, { factor: null, x: 0, y: 0 }); refreshZoom();
};
for (const name of ['dragenter', 'dragover']) $('original-stage').addEventListener(name, event => {
  event.preventDefault(); if (!busy) { $('original-stage').classList.add('dragover'); event.dataTransfer.dropEffect = 'copy'; }
});
$('original-stage').addEventListener('dragleave', event => { if (!$('original-stage').contains(event.relatedTarget)) $('original-stage').classList.remove('dragover'); });
$('original-stage').addEventListener('drop', event => { event.preventDefault(); $('original-stage').classList.remove('dragover'); if (!busy) useFile(event.dataTransfer.files[0]); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('sample').onclick = async () => {
  try { const response = await fetch('./assets/demo.png'); if (!response.ok) throw new Error(t('sampleError'));
    await useFile(new File([await response.blob()], 'lastTour.png', { type: 'image/png' }));
  } catch (error) { setStatus('failed', 'error', { detail: error.message }); }
};
translate(); renderState(); setBusy(false);
if (location.protocol === 'file:') setStatus('httpRequired', 'error');
else {
  try {
    getWorker(); // Start in the background while settings load and the user chooses an image.
    const response = await fetch('./core-manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(t('syncRequired'));
    const manifest = await response.json(); defaults = manifest.defaults; palettes = manifest.palettes;
    for (const item of palettes) { const option = document.createElement('option'); option.value = item.id; $('palette').append(option); }
    reset(); setBusy(false);
  } catch (error) { setStatus('failed', 'error', { detail: error.message }); }
}
