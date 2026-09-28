/** Diagnostic drawing only. Canvas never supplies pixels to the algorithm. */
import { zipFiles, unzipStored } from './tools.js';
import { quantile, rfftMagnitude, mean, roundEven } from './numeric.js';

const decoder = new TextDecoder();
export const runtime = { engine: 'JavaScript', algorithm: 'RealPixelArt', numeric: 'Float32/Float64 typed arrays' };
const json = value => JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v, 2);
const max = values => { let m = 0; for (const v of values) if (v > m) m = v; return m; };
function canvas(width, height, title = '') {
  const element = new OffscreenCanvas(width, height), ctx = element.getContext('2d');
  ctx.fillStyle = '#131a22'; ctx.fillRect(0,0,width,height);
  if (title) { ctx.fillStyle = '#eaf2f5'; ctx.font = '16px sans-serif'; ctx.fillText(title, 16, 25); }
  return { element, ctx };
}
async function png(view) { return new Uint8Array(await (await view.element.convertToBlob({type: 'image/png'})).arrayBuffer()); }
function drawPixels(ctx, pixels, width, height, x, y, w, h) {
  const tile = new OffscreenCanvas(width, height);
  tile.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height),0,0);
  ctx.drawImage(tile, x,y,w,h);
}
function previewAxes(width, height, limit = 1024) {
  const factor = Math.min(1, limit / Math.max(width, height));
  const w = Math.max(1, roundEven(width * factor)), h = Math.max(1, roundEven(height * factor));
  return {
    width: w, height: h,
    x: Int32Array.from({ length: w }, (_, i) => Math.floor((i + .5) * width / w)),
    y: Int32Array.from({ length: h }, (_, i) => Math.floor((i + .5) * height / h)),
  };
}

// These bounded pixel previews are also testable without a browser/Canvas.
// Never materialize a full-size source or reflected FFT canvas just to display
// a thumbnail. Source gradients/spectra are sampled, never recomputed/resized.
export function sourcePreview(source) {
  const preview = previewAxes(source.width, source.height);
  const data = new Uint8Array(preview.width * preview.height * 4);
  for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) {
    const from = (preview.y[y] * source.width + preview.x[x]) * 4;
    const to = (y * preview.width + x) * 4;
    const alpha = source.data[from + 3];
    for (let channel = 0; channel < 3; channel++) {
      data[to + channel] = Math.floor((source.data[from + channel] * alpha + 190 * (255 - alpha) + 127) / 255);
    }
    data[to + 3] = 255;
  }
  return { width: preview.width, height: preview.height, data };
}

export function fftPreview(spectrum, sourceWidth) {
  const preview = previewAxes(sourceWidth, spectrum.height);
  const values = new Float32Array(preview.width * preview.height);
  let low = Infinity;
  for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) {
    let sx = (preview.x[x] - Math.floor(sourceWidth / 2) + sourceWidth) % sourceWidth;
    let sy = (preview.y[y] - Math.floor(spectrum.height / 2) + spectrum.height) % spectrum.height;
    if (sx > Math.floor(sourceWidth / 2)) {
      sx = sourceWidth - sx;
      sy = (spectrum.height - sy) % spectrum.height;
    }
    const value = spectrum.data[sy * spectrum.width + sx];
    values[y * preview.width + x] = value;
    low = Math.min(low, value);
  }
  // The stored spectrum already is log(1+abs(F)); applying another logarithm
  // would change the Python preview's contrast and obscure weak spectral peaks.
  const high = quantile(values, .995);
  const divisor = Math.fround(Math.max(high - low, 1e-8));
  const data = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const normalized = Math.fround(Math.fround(values[i] - low) / divisor);
    const value = roundEven(Math.fround(Math.max(0, Math.min(1, normalized)) * 255));
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = value;
    data[4 * i + 3] = 255;
  }
  return { width: preview.width, height: preview.height, data };
}

export function edgePreview(edgeX, edgeY, sourceWidth, sourceHeight) {
  const preview = previewAxes(sourceWidth, sourceHeight);
  const fullSize = edgeX.width === sourceWidth && edgeX.height === sourceHeight;
  const width = fullSize ? preview.width : edgeX.width;
  const height = fullSize ? preview.height : edgeX.height;
  const positives = new Float32Array(width * height);
  const index = (x, y) => fullSize ? preview.y[y] * edgeX.width + preview.x[x] : y * width + x;
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = index(x, y), strength = Math.max(edgeX.data[i], edgeY.data[i]);
    if (strength > 0) positives[count++] = strength;
  }
  const cap = Math.fround(count ? Math.max(quantile(positives.subarray(0, count), .95), .05) : 1);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = index(x, y), to = (y * width + x) * 4;
    const ex = edgeX.data[i], ey = edgeY.data[i];
    data[to] = roundEven(Math.fround(Math.max(0, Math.min(1, Math.fround(ex / cap))) * 255));
    data[to + 1] = roundEven(Math.fround(Math.max(0, Math.min(1, Math.fround(ey / cap))) * 255));
    data[to + 2] = Math.min(data[to], data[to + 1]);
    data[to + 3] = 255;
  }
  return { width, height, data };
}

function display(preview, title, lines = null, sourceSize = [preview.width, preview.height]) {
  const view = canvas(Math.max(520, preview.width), preview.height + 42, title);
  const left = Math.floor((view.element.width - preview.width) / 2);
  view.ctx.imageSmoothingEnabled = false;
  drawPixels(view.ctx, preview.data, preview.width, preview.height, left, 42, preview.width, preview.height);
  if (lines) {
    view.ctx.strokeStyle = '#ff657c'; view.ctx.lineWidth = 1; view.ctx.beginPath();
    for (const x of lines[0]) {
      const px = left + Math.min(preview.width - 1, Math.max(0, x * preview.width / sourceSize[0]));
      view.ctx.moveTo(px, 42); view.ctx.lineTo(px, preview.height + 42);
    }
    for (const y of lines[1]) {
      const py = 42 + Math.min(preview.height - 1, Math.max(0, y * preview.height / sourceSize[1]));
      view.ctx.moveTo(left, py); view.ctx.lineTo(left + preview.width, py);
    }
    view.ctx.stroke();
  }
  return view;
}
function plot(ctx, values, rect, color, label, markers = []) {
  const [x,y,w,h] = rect, top = max(values) || 1;
  ctx.strokeStyle = '#394551'; ctx.strokeRect(x,y,w,h);
  ctx.fillStyle = '#dce7ed'; ctx.font = '13px sans-serif'; ctx.fillText(label,x,y-8);
  ctx.strokeStyle = '#785842';
  for (const marker of markers) {
    const px = x+marker/Math.max(1,values.length-1)*w;
    if (px >= x && px <= x+w) { ctx.beginPath(); ctx.moveTo(px,y); ctx.lineTo(px,y+h); ctx.stroke(); }
  }
  ctx.beginPath(); ctx.strokeStyle = color;
  for (let i=0;i<values.length;i++) { const px=x+i/Math.max(1,values.length-1)*w, py=y+h-values[i]/top*h; if (!i) ctx.moveTo(px,py); else ctx.lineTo(px,py); }
  ctx.stroke();
}
export async function drawDiagnostics(result) {
  const data = result.debug_data, {grid} = result, images = {};
  const drawGrid = !grid.fallback && !grid.native_preserved;
  const gridLines = drawGrid ? [grid.x_lines, grid.y_lines] : null;
  let view = display(sourcePreview(data.source),
    `Grid ${grid.output_size.join(' x ')} | spacing ${grid.sx.toFixed(3)} x ${grid.sy.toFixed(3)} | confidence ${result.confidence.toFixed(3)}`,
    gridLines, grid.input_size);
  images['grid.png'] = await png(view);
  view = display(edgePreview(data.edge_x, data.edge_y, ...grid.input_size),
    'Colour + alpha edges: X = red, Y = green; source derivative preview');
  images['edges.png'] = await png(view);
  const [sw, sh] = data.spectrum_size;
  const fftLines = drawGrid && !grid.stylized ? [
    [-1, 1].map(sign => Math.floor(sw / 2) + sign * sw / grid.sx),
    [-1, 1].map(sign => Math.floor(sh / 2) + sign * sh / grid.sy),
  ] : null;
  let fftTitle = grid.stylized ? 'Image FFT: generated rendering grid; no detected reciprocal spacing'
    : 'Image FFT: log(1+|F|); red = selected reciprocal spacing';
  if (grid.estimated) fftTitle = 'Image FFT: red = edge-estimated spacing, NOT a confirmed FFT period';
  if (sw !== grid.input_size[0] || sh !== grid.input_size[1]) {
    fftTitle = `FFT: ${sw}x${sh} source patch (display); detector uses full-length scanlines`;
  }
  view = display(fftPreview(data.spectrum, sw), fftTitle, fftLines, [sw, sh]);
  images['fft.png'] = await png(view);
  view=canvas(1000,660,'Directional evidence (FFT proposes; edges select the grid)');
  plot(view.ctx,data.profile_x,[50,70,900,105],'#e8aa58','X edge projection',drawGrid ? grid.x_lines : []);
  plot(view.ctx,data.profile_y,[50,225,900,105],'#67cadb','Y edge projection',drawGrid ? grid.y_lines : []);
  const centeredPower = profile => {
    const average = mean(profile);
    return rfftMagnitude(Float64Array.from(profile, value => value - average));
  };
  plot(view.ctx,centeredPower(data.profile_x),[50,380,900,105],'#e8aa58','X projection FFT',
    fftLines ? [data.profile_x.length / grid.sx] : []);
  plot(view.ctx,centeredPower(data.profile_y),[50,535,900,105],'#67cadb','Y projection FFT',
    fftLines ? [data.profile_y.length / grid.sy] : []);
  images['profiles.png']=await png(view);
  view=canvas(1000,370,'Second-difference evidence; markers = recovered cell centers');
  const centers=lines=>lines.slice(1).map((v,i)=>(v+lines[i])/2-.5);
  plot(view.ctx,data.curvature_x,[50,70,900,105],'#e8aa58','X curvature',drawGrid ? centers(grid.x_lines) : []);
  plot(view.ctx,data.curvature_y,[50,225,900,105],'#67cadb','Y curvature',drawGrid ? centers(grid.y_lines) : []);
  images['curvature.png']=await png(view);
  return images;
}
export function diagnosticFiles(result, images, scale=1) {
  return { ...images,
    'info.json': json({ grid:result.grid, heuristic_confidence:result.confidence, timings_seconds:result.timings,
      diagnostics:result.diagnostics, export:{path:null,scale,size:result.grid.output_size.map(value=>value*scale)},runtime }),
    'info.txt': `RealPixelArt processing\nInput: ${result.grid.input_size.join(' x ')}\nGrid: ${result.grid.output_size.join(' x ')}\nSpacing: ${result.grid.sx} x ${result.grid.sy}\nSource: ${result.grid.source}\nHeuristic confidence: ${result.confidence}\nProcessing: ${result.timings.total.toFixed(4)}s\nColor postprocessing: ${json(result.diagnostics.color_processing)}\n`,
  };
}
export function diagnosticZip(files,stem) { return zipFiles(Object.fromEntries(Object.entries(files).map(([name,data])=>[`output/debug/${stem}/${name}`,data]))); }
export function recolorDiagnostics(archive, colored) {
  const files=unzipStored(archive);
  for(const [name,data] of Object.entries(files)) {
    if(name.endsWith('/info.json')) {
      const info=JSON.parse(decoder.decode(data)), times=info.timings_seconds, difference=colored.seconds-(times.palette||0);
      info.diagnostics.color_processing=colored.diagnostics;
      for(const key of ['total','total_with_export']) if(key in times) times[key]+=difference;
      times.palette=colored.seconds; files[name]=json(info);
    } else if(name.endsWith('/info.txt')) files[name]=decoder.decode(data).split('\n').filter(line=>!line.startsWith('Processing:')&&!line.startsWith('Color postprocessing:')).join('\n')+`\nColor postprocessing: ${JSON.stringify(colored.diagnostics)}; ${colored.seconds.toFixed(4)}s\n`;
  }
  return zipFiles(files);
}
