// One dictionary for static labels, dynamic state and accessible names.
const messages = {
  githubRepo: ['访问 GitHub 仓库', 'Open GitHub repository'],
  previews: ['图片预览', 'Image previews'], background: ['预览背景', 'Background'],
  checker: ['透明棋盘', 'Checkerboard'], white: ['纯白', 'White'], darkBackground: ['深色', 'Dark'],
  zoom: ['缩放', 'Zoom'], fit: ['适应窗口', 'Fit'], original: ['原图', 'Original'], restored: ['恢复结果', 'Result'],
  zoomIn: ['放大', 'Zoom in'], zoomOut: ['缩小', 'Zoom out'], upload: ['上传图片', 'Upload'],
  fewerColors: ['减少颜色数量', 'Fewer colors'], moreColors: ['增加颜色数量', 'More colors'], keepColorsStop: ['不限制', 'All'],
  choose: ['点击或拖入图片', 'Click or drop an image'], replace: ['单击更换图片，按住拖动查看，或拖入新图片', 'Click to replace, drag to pan, or drop a new image'],
  sample: ['示例', 'Sample'], remove: ['移除', 'Remove'], waiting: ['等待生成', 'No result yet'],
  generate: ['生成', 'Generate'], generating: ['生成中…', 'Generating…'], cancel: ['取消', 'Cancel'],
  download: ['下载 PNG', 'Download PNG'], debugZip: ['处理过程 ZIP', 'Process ZIP'],
  nativeGrid: ['原生网格', 'Native grid'], spacing: ['源图格距', 'Source spacing'],
  confidence: ['启发式置信分数', 'Heuristic confidence'], confidenceHelp: ['启发式分数，不代表正确概率', 'Heuristic score, not a probability'],
  time: ['处理耗时', 'Processing time'], parameters: ['参数', 'Settings'], reset: ['重置', 'Reset'],
  colors: ['限定颜色数量', 'Maximum colors'], keepColors: ['不限制', 'Unlimited'], sampling: ['取色方式', 'Sampling'],
  colorPost: ['颜色处理（可选）', 'Color processing (optional)'], colorMode: ['颜色模式', 'Color mode'],
  natural: ['自然', 'Natural'], palette: ['色库', 'Palette'], usePalette: ['使用色库', 'Use palette'],
  paletteName: ['{brand}-{size}色', '{brand}-{size} colors'],
  paletteNote: ['该规格标称 {nominal} 色，当前色库实际包含 {actual} 色。', 'Named {nominal} colors; this library contains {actual} colors.'],
  colorHelp: ['在恢复结果上调整，无需重新识别网格。', 'Adjust the restored image without detecting the grid again.'],
  noSemitransparent: ['无半透明像素', 'No semi-transparent pixels'],
  noSemitransparentHelp: ['不透明度不足 75% 的像素变为全透明，其余变为全不透明；关闭可恢复。', 'Pixels below 75% opacity become transparent; the rest become opaque. Turn off to restore.'],
  colorCount: ['当前 {count} 色 · {seconds} s', '{count} colors · {seconds} s'],
  coloring: ['正在调整颜色…', 'Applying color settings…'], colorDone: ['颜色已更新。', 'Colors updated.'],
  colorInvalid: ['请检查颜色设置。', 'Check the color settings.'],
  robust: ['稳健取色 · 中心优先', 'Robust · center first'], center: ['中心采样', 'Center'], median: ['中值采样', 'Median'],
  alpha: ['透明度', 'Transparency'], alphaAuto: ['保留采样透明度', 'Preserve sampled alpha'],
  coverage: ['按区域覆盖率平均', 'Average coverage'], binary: ['二值透明度', 'Binary alpha'],
  warp: ['局部网格调整', 'Local grid adjustment'], auto: ['自动', 'Auto'], off: ['关闭', 'Off'],
  fixedPixels: ['固定像素', 'Fixed size'],
  targetWidth: ['输出宽度（X，像素）', 'Output width (X, pixels)'], targetHeight: ['输出高度（Y，像素）', 'Output height (Y, pixels)'],
  fixedPixelsHelp: ['按指定宽高自适应分割完整原图；宽高比改变时，画面比例也会改变。此模式不使用搜索间距或正方形限制。', 'Adapt the grid to the requested width and height, covering the full image. A different aspect ratio changes proportions. Search spacing and the square-grid constraint do not apply.'],
  square: ['强制正方形网格', 'Square grid'], debug: ['生成处理过程', 'Generate process details'],
  more: ['更多设置', 'More settings'], minSpacing: ['最小间距', 'Minimum spacing'], maxSpacing: ['最大间距', 'Maximum spacing'],
  exportScale: ['导出倍数', 'Export scale'], exportHelp: ['最近邻放大，无需重新生成。', 'Nearest-neighbor enlargement. No regeneration needed.'],
  diagnostics: ['处理过程', 'Process details'], grid: ['网格', 'Grid'], fft: ['FFT', 'FFT'], edges: ['边缘', 'Edges'], profiles: ['投影', 'Profiles'], curvature: ['曲率', 'Curvature'],
  night: ['切换夜间模式', 'Switch to dark mode'], day: ['切换白天模式', 'Switch to light mode'],
  noFile: ['未选择图片', 'No image selected'], selectImage: ['请选择图片。', 'Select an image.'],
  ready: ['图片已就绪。', 'Image ready.'], done: ['处理完成。', 'Done.'], cancelled: ['已取消。', 'Cancelled.'],
  nativePreserved: ['检测到一像素细节，已保留原始尺寸；颜色设置可继续调整。', 'One-pixel details detected; original dimensions preserved. Color settings remain available.'],
  estimatedGrid: ['已按方正边缘估算网格并生成像素画。', 'Pixel image generated using an edge-guided grid estimate.'],
  photoMode: ['未识别网格时自动像素化', 'Pixelize when no reliable grid is found'],
  stylized: ['已自动转换为像素画。', 'Image pixelized automatically.'],
  stale: ['参数已更改 · 待重新生成', 'Settings changed · regenerate'], staleStatus: ['参数已更改，请重新生成。', 'Settings changed. Generate again.'],
  exportSize: ['导出 {size}', 'Export {size}'], exporting: ['正在导出 PNG…', 'Exporting PNG…'], exported: ['PNG 已导出。', 'PNG exported.'],
  reading: ['正在读取图片…', 'Reading image…'], starting: ['正在启动处理引擎…', 'Starting processing engine…'],
  loading: ['正在载入图像处理组件…', 'Loading image processing components…'], processing: ['正在识别网格、恢复颜色…', 'Detecting grid and recovering colors…'],
  engineReady: ['处理引擎已就绪。', 'Processing engine ready.'],
  engineFailed: ['引擎准备失败，点击生成可重试：{detail}', 'Engine setup failed. Generate to retry: {detail}'],
  largeFile: ['文件超过 64 MB，请选择较小的静态图片。', 'File exceeds 64 MB. Choose a smaller static image.'],
  previewLater: ['图片将在处理后显示', 'Preview available after processing'], sampleError: ['无法载入示例。', 'Could not load sample.'],
  failed: ['处理失败：{detail}', 'Processing failed: {detail}'],
  memoryFailed: ['浏览器处理内存不足，已释放引擎内存。可以重新处理较小图片；超大原图建议使用本地 Python 版本。', 'Browser processing memory exhausted; engine memory released. Retry with a smaller image, or use desktop Python for very large originals.'],
  httpRequired: ['请通过 localhost 或 HTTPS 静态服务打开网页。', 'Open this page through a localhost or HTTPS static server.'],
  syncRequired: ['请运行 node web/build.mjs 更新网页资源清单。', 'Run node web/build.mjs to update the web resource manifest.'],
};
export function preference(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
}
export let language = preference('realpixelart-language') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
export function t(key, values = {}) {
  let text = messages[key]?.[language === 'zh' ? 0 : 1] || key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
export function setLanguage(value) { language = value; preference('realpixelart-language', value); translate(); }
export function translate() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  for (const [attribute, target] of [['data-i18n', null], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label'], ['data-i18n-alt', 'alt']]) {
    for (const node of document.querySelectorAll(`[${attribute}]`)) {
      const value = t(node.getAttribute(attribute));
      if (target) node.setAttribute(target, value); else node.textContent = value;
    }
  }
}
