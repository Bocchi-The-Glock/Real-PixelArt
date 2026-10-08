/* Runs inside the actual system WebView, never in production builds. */
const earlyErrors = [];
window.addEventListener('error', event => earlyErrors.push(event.message));
window.addEventListener('securitypolicyviolation', event => earlyErrors.push('CSP: ' + event.violatedDirective + ' ' + event.blockedURI));
window.addEventListener('DOMContentLoaded', async () => {
  const started = performance.now(), errors = earlyErrors, outputs = [];
  const invoke = (...args) => window.__TAURI__.core.invoke(...args);
  const progress = stage => invoke('smoke_progress', {stage});
  const waitFor = async predicate => {
    const deadline = performance.now() + 90000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Timed out: ' + predicate + '; status=' + document.querySelector('#status')?.textContent + '; errors=' + errors.join('|'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const bytes = encoded => Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  window.alert = message => errors.push('Alert: ' + message);
  try {
    await progress('DOM loaded; waiting for engine');
    await waitFor(() => ['ready', 'error'].includes(document.querySelector('#status')?.dataset.engineState));
    assert(document.querySelector('#status').dataset.engineState === 'ready', document.querySelector('#status').textContent);
    const readyMs = performance.now() - started;
    const launchMs = Date.now() - window.__SMOKE_STARTED__;
    await progress('engine ready; processing fixtures');
    const worker = new Worker('./worker.js', { type: 'module' });
    const request = data => new Promise((resolve, reject) => {
      worker.onmessage = ({data: result}) => {
        if (result.type === 'error') reject(new Error(result.message));
        else if (result.type !== 'progress') resolve(result);
      };
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage(data);
    });
    for (const [index, item] of window.__SMOKE_CASES__.entries()) {
      const result = await request({type: 'process', id: index, bytes: bytes(item.input).buffer,
        request: {name: item.name, config: item.config, debug: index === 0}});
      assert(result.type === 'result', 'Worker did not return an image');
      await invoke('save_export', {name: 'case-' + index + '.png', bytes: Array.from(new Uint8Array(result.output))});
      await progress('processed ' + item.name);
      outputs.push({name: item.name, config: item.config, grid: result.meta.grid});
    }
    worker.terminate();

    // Real upload, generation, export multiplier and both native download paths.
    await progress('testing upload and exports');
    const item = window.__SMOKE_CASES__[0], transfer = new DataTransfer();
    transfer.items.add(new File([bytes(item.input)], item.name, {type: 'image/png'}));
    const input = document.querySelector('#file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await waitFor(() => !document.querySelector('#run').disabled);
    document.querySelector('#run').click();
    await waitFor(() => !document.querySelector('#download').disabled);
    assert(document.querySelector('#metric-grid').textContent === '331 × 219', 'Unexpected lastTour grid');
    const scale = document.querySelector('#scale');
    scale.value = '3'; scale.dispatchEvent(new Event('input', {bubbles: true}));
    assert(document.querySelector('#result-size').textContent === '331 × 219 (993 × 657)', 'Export size did not update');

    const links = [], downloads = [];
    window.addEventListener('click', event => {
      const link = event.target.closest?.('a[download]');
      if (link?.href.startsWith('blob:')) { links.push(link); downloads.push(link.download); }
    }, true);
    document.querySelector('#download').click();
    await waitFor(() => downloads.includes('lastTour.png') && !links[0].dataset.saving);
    document.querySelector('#download-debug').click();
    await waitFor(() => downloads.includes('lastTour_debug.zip') && !links.at(-1).dataset.saving);

    // Fixed dimensions are a grid setting; generate through the same upload/UI path.
    await progress('testing fixed-size generation and export');
    const fixed = document.querySelector('#target-size-enabled');
    const width = document.querySelector('#target-width'), height = document.querySelector('#target-height');
    const change = element => element.dispatchEvent(new Event('input', {bubbles: true}));
    assert(!fixed.checked && width.disabled && height.disabled, 'Fixed size must start disabled');
    document.querySelector('#square').checked = true;
    fixed.checked = true; change(fixed);
    assert(!width.disabled && !height.disabled, 'Fixed-size inputs did not enable');
    assert(['square', 'min-size', 'max-size'].every(id => document.getElementById(id).disabled), 'Conflicting grid settings must be disabled');
    assert(document.querySelector('#download').disabled, 'Changing grid settings must invalidate the previous result');
    width.value = '96'; change(width); height.value = '64'; change(height);
    document.querySelector('#debug').checked = false;
    const fixedTransfer = new DataTransfer();
    fixedTransfer.items.add(new File([bytes(item.input)], 'lastTour_fixed.png', {type: 'image/png'}));
    input.files = fixedTransfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await waitFor(() => !document.querySelector('#run').disabled);
    document.querySelector('#run').click();
    await waitFor(() => !document.querySelector('#download').disabled);
    assert(document.querySelector('#metric-grid').textContent === '96 × 64', 'Fixed grid dimensions were not applied');
    scale.value = '2'; change(scale);
    assert(document.querySelector('#result-size').textContent === '96 × 64 (192 × 128)', 'Fixed-grid export size did not update');
    document.querySelector('#download').click();
    await waitFor(() => downloads.includes('lastTour_fixed.png') && !links.at(-1).dataset.saving);
    fixed.checked = false; change(fixed);
    assert(width.disabled && height.disabled && !document.querySelector('#square').disabled, 'Turning fixed size off did not restore automatic controls');
    fixed.checked = true; change(fixed);
    document.querySelector('#reset').click();
    assert(!fixed.checked && width.disabled && height.disabled && width.value === '128' && height.value === '128', 'Reset did not restore fixed-size defaults');
    assert(errors.length === 0, errors.join('\n'));
    await progress('exports complete');
    await invoke('finish_smoke', {report: {ok: true, outputs, downloads, ready_ms: readyMs,
      launch_to_ready_ms: launchMs, total_ms: performance.now() - started, user_agent: navigator.userAgent}});
  } catch (error) {
    await invoke('finish_smoke', {report: {ok: false, error: String(error.stack || error), errors, outputs}});
  }
});
