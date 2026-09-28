/* Desktop-only adapter. The shared webpage and image algorithm stay unchanged. */
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

document.addEventListener('click', async event => {
  const link = event.target.closest?.('a[download]');
  if (!link || !link.href.startsWith('blob:')) return;
  event.preventDefault();
  if (link.dataset.saving) return;
  link.dataset.saving = 'true';
  try {
    const response = await fetch(link.href);
    const data = new Uint8Array(await response.arrayBuffer());
    await invoke('save_export', { name: link.download, bytes: Array.from(data) });
  } catch (error) { window.alert('无法保存 / Unable to save: ' + String(error)); }
  finally { delete link.dataset.saving; }
}, true);

window.addEventListener('DOMContentLoaded', () => {
  const missing = ['Worker', 'OffscreenCanvas', 'CompressionStream', 'DecompressionStream', 'createImageBitmap']
    .filter(name => typeof globalThis[name] !== 'function');
  if (missing.length) invoke('runtime_problem', { detail: missing.join(', ') }).catch(console.error);
});
