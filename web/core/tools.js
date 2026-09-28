/** Lossless PNG pixels, browser image decoding, and small deterministic archives.
 * PNG filters/interlacing follow https://www.w3.org/TR/png-3/.
 * Compression uses browser/Node standard streams; no image runtime is bundled.
 */
import { validateScale } from './config.js';

const text = new TextEncoder(), decoder = new TextDecoder();
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function join(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > 89_478_485) throw new Error('Invalid image size or image exceeds the supported pixel budget.');
}
async function inflate(parts, expected) {
  // IDAT chunks are views into the uploaded file. Feed bounded slices directly
  // instead of concatenating and then copying the compressed image into a Blob.
  let part = 0, position = 0;
  const source = new ReadableStream({
    pull(controller) {
      while (part < parts.length && position === parts[part].length) { part++; position = 0; }
      if (part === parts.length) { controller.close(); return; }
      const end = Math.min(position + 65536, parts[part].length);
      controller.enqueue(parts[part].subarray(position, end)); position = end;
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader(), result = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > expected) throw new Error('Invalid decompressed PNG size.');
      result.set(value, offset); offset += value.length;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (offset !== expected) throw new Error('Truncated PNG pixel data.');
  return result;
}
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function tiffReader(bytes, start) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (start + 8 > bytes.length) throw new Error('Invalid TIFF metadata.');
  const little = bytes[start] === 73 && bytes[start + 1] === 73;
  if (!little && !(bytes[start] === 77 && bytes[start + 1] === 77)) throw new Error('Invalid TIFF byte order.');
  const u16 = offset => view.getUint16(start + offset, little);
  const u32 = offset => view.getUint32(start + offset, little);
  if (u16(2) !== 42) throw new Error('Invalid TIFF metadata header.');
  return { u16, u32, directory: u32(4) };
}
function exifOrientation(bytes, start = 0) {
  try {
    const { u16, u32, directory } = tiffReader(bytes, start);
    for (let i = 0; i < u16(directory); i++) {
      const entry = directory + 2 + 12 * i;
      if (u16(entry) === 0x112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
        const orientation = u16(entry + 8);
        return orientation >= 1 && orientation <= 8 ? orientation : 1;
      }
    }
  } catch { /* Malformed optional EXIF does not invalidate image pixels. */ }
  return 1;
}
function orientImage(image, orientation) {
  if (orientation === 1) return image;
  const { width: w, height: h, data } = image;
  const width = orientation >= 5 ? h : w, height = orientation >= 5 ? w : h;
  const output = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let xx = x, yy = y;
    if (orientation === 2) xx = w - 1 - x;
    if (orientation === 3) { xx = w - 1 - x; yy = h - 1 - y; }
    if (orientation === 4) yy = h - 1 - y;
    if (orientation === 5) { xx = y; yy = x; }
    if (orientation === 6) { xx = h - 1 - y; yy = x; }
    if (orientation === 7) { xx = h - 1 - y; yy = w - 1 - x; }
    if (orientation === 8) { xx = y; yy = w - 1 - x; }
    output.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (yy * width + xx) * 4);
  }
  return { ...image, width, height, data: output };
}

export async function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!PNG_SIGNATURE.every((value, i) => bytes[i] === value)) throw new Error('Invalid PNG signature.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, depth, type, interlace, palette, transparent, orientation = 1, ended = false;
  let animationFrames = 0, frameControlSeen = false, defaultImage = false;
  const parts = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = view.getUint32(at), end = at + 12 + size;
    if (end > bytes.length) throw new Error('Truncated PNG chunk.');
    const name = decoder.decode(bytes.subarray(at + 4, at + 8));
    const chunk = bytes.subarray(at + 8, at + 8 + size);
    if (crc32(bytes.subarray(at + 4, at + 8 + size)) !== view.getUint32(at + 8 + size)) throw new Error('PNG checksum mismatch.');
    if (name === 'IHDR') {
      if (at !== 8 || size !== 13) throw new Error('Invalid PNG header.');
      width = view.getUint32(at + 8); height = view.getUint32(at + 12); dimensions(width, height);
      [depth, type] = chunk.subarray(8, 10); interlace = chunk[12];
      if (chunk[10] || chunk[11] || interlace > 1) throw new Error('Unsupported PNG encoding.');
    } else if (name === 'PLTE') palette = chunk;
    else if (name === 'tRNS') transparent = chunk;
    else if (name === 'eXIf') orientation = exifOrientation(chunk);
    else if (name === 'acTL') {
      if (size !== 8 || view.getUint32(at + 8) === 0) throw new Error('Invalid PNG animation header.');
      animationFrames = view.getUint32(at + 8);
    } else if (name === 'fcTL') {
      if (size !== 26) throw new Error('Invalid PNG frame header.');
      if (!frameControlSeen) defaultImage = parts.length > 0;
      frameControlSeen = true;
    } else if (name === 'IDAT') parts.push(chunk);
    else if (name === 'IEND') { ended = true; break; }
    at = end;
  }
  if (animationFrames + Number(defaultImage) > 1) {
    throw new Error('Only single-frame static images are supported (animated PNG).');
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!ended || !parts.length || !channels || !depths[type].includes(depth)
      || (type === 3 && (!palette || palette.length % 3))) throw new Error('Invalid PNG image data.');
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const layouts = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return { x, y, dx, dy, w, h, row: Math.ceil(w * channels * depth / 8) };
  });
  const expected = layouts.reduce((n, p) => n + (p.w && p.h ? (p.row + 1) * p.h : 0), 0);
  const raw = await inflate(parts, expected), data = new Uint8Array(width * height * 4);
  const bpp = Math.max(1, Math.ceil(channels * depth / 8));
  const tr = transparent ? new DataView(transparent.buffer, transparent.byteOffset, transparent.byteLength) : null;
  let cursor = 0;
  for (const p of layouts) {
    if (!p.w || !p.h) continue;
    let previous = new Uint8Array(p.row);
    for (let y = 0; y < p.h; y++) {
      const filter = raw[cursor++], row = raw.subarray(cursor, cursor + p.row); cursor += p.row;
      if (filter > 4) throw new Error('Invalid PNG filter.');
      for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0, above = previous[i], corner = i >= bpp ? previous[i - bpp] : 0;
        row[i] += filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : filter === 4 ? paeth(left, above, corner) : 0;
      }
      const sample = i => depth === 16 ? row[2 * i] * 256 + row[2 * i + 1]
        : depth === 8 ? row[i] : (row[(i * depth) >>> 3] >>> (8 - depth - (i * depth) % 8)) & ((1 << depth) - 1);
      const byte = v => depth === 16 ? v >>> 8 : Math.round(v * 255 / ((1 << depth) - 1));
      for (let x = 0; x < p.w; x++) {
        const offset = ((p.y + y * p.dy) * width + p.x + x * p.dx) * 4;
        const index = x * channels, first = sample(index);
        let r, g, b, a = 255;
        if (type === 3) {
          if (first * 3 + 2 >= palette.length) throw new Error('Invalid PNG palette index.');
          [r, g, b] = palette.subarray(first * 3, first * 3 + 3); a = transparent?.[first] ?? 255;
        } else if (type === 0 || type === 4) {
          // Pillow clips 16-bit grayscale integers during conversion to RGBA.
          r = g = b = type === 0 && depth === 16 ? Math.min(first, 255) : byte(first);
          if (type === 4) a = byte(sample(index + 1));
          // Match Pillow's conversion to RGBA: mode 1 compares its bit value;
          // L and I;16 compare converted bytes to the low byte of the tRNS key.
          else if (tr && tr.byteLength >= 2 && (depth === 1 ? first : r) === (tr.getUint16(0) & 255)) a = 0;
        } else {
          const second = sample(index + 1), third = sample(index + 2);
          r = byte(first); g = byte(second); b = byte(third);
          if (type === 6) a = byte(sample(index + 3));
          else if (tr && tr.byteLength >= 6 && r === (tr.getUint16(0) & 255)
            && g === (tr.getUint16(2) & 255) && b === (tr.getUint16(4) & 255)) a = 0;
        }
        data[offset] = a ? r : 0; data[offset + 1] = a ? g : 0; data[offset + 2] = a ? b : 0; data[offset + 3] = a;
      }
      previous = row;
    }
  }
  return orientImage({ width, height, data, has_alpha: type === 4 || type === 6 || !!transparent,
    metadata: { format: 'PNG', frames: 1, selected_frame: 0, selection: 'single image' } }, orientation);
}

function pngChunk(name, bytes) {
  const result = new Uint8Array(bytes.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, bytes.length); result.set(text.encode(name), 4); result.set(bytes, 8);
  view.setUint32(bytes.length + 8, crc32(result.subarray(4, bytes.length + 8)));
  return result;
}
export async function encodePng(image, scale = 1) {
  validateScale(scale);
  const width = image.width * scale, height = image.height * scale;
  dimensions(width, height);
  const rgba = image.data, channels = image.has_alpha === false ? 3 : 4;
  // Sub filtering is cheap and keeps repeated blocks compact, without Canvas
  // premultiplication changing translucent RGB on export. Respect compression
  // backpressure: only the current source row is retained, including at 16x.
  let sourceY = 0, repeat = 0, row;
  const source = new ReadableStream({
    pull(controller) {
      if (repeat === 0) {
        row = new Uint8Array(width * channels + 1); row[0] = 1;
        const previous = new Uint8Array(channels);
        for (let x = 0; x < width; x++) {
          const input = (sourceY * image.width + Math.floor(x / scale)) * 4;
          for (let c = 0; c < channels; c++) {
            const value = c < 3 && rgba[input + 3] === 0 ? 0 : rgba[input + c];
            row[1 + x * channels + c] = value - previous[c]; previous[c] = value;
          }
        }
      }
      controller.enqueue(row);
      if (++repeat === scale) { repeat = 0; sourceY++; row = null; }
      if (sourceY === image.height) controller.close();
    },
  });
  const compressed = new Uint8Array(await new Response(source.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  return join([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())]);
}

function selectJpeg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 4 < bytes.length;) {
    if (bytes[at++] !== 255) break;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(at), start = at + 2, end = at + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe2 && decoder.decode(bytes.subarray(start, start + 4)) === 'MPF\0') {
      const base = start + 4, { u16, u32, directory } = tiffReader(bytes, base);
      let count = 1, entries = null;
      for (let i = 0; i < u16(directory); i++) {
        const entry = directory + 2 + i * 12, tag = u16(entry);
        if (tag === 0xb001) count = u32(entry + 8);
        if (tag === 0xb002) entries = u32(entry + 8);
      }
      if (entries !== null && count > 1 && count < 4096) {
        const primary = [];
        for (let i = 0; i < count; i++) if ((u32(entries + i * 16) & 0xffffff) === 0x030000) primary.push(i);
        const selected = primary.length === 1 ? primary[0] : 0;
        const offset = u32(entries + selected * 16 + 8), size = u32(entries + selected * 16 + 4);
        const first = offset === 0 ? 0 : base + offset;
        if (!size || first + size > bytes.length) throw new Error('Invalid MPO primary image.');
        return { bytes: bytes.subarray(first, first + size), metadata: {
          format: 'MPO', frames: count, selected_frame: selected,
          selection: primary.length === 1 ? 'declared MP primary image' : 'first MPO image',
        } };
      }
    }
    at = end;
  }
  return { bytes, metadata: { format: 'JPEG', frames: 1, selected_frame: 0, selection: 'single image' } };
}
function gifFrames(bytes) {
  let at = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), count = 0;
  const blocks = () => { while (at < bytes.length) { const n = bytes[at++]; if (!n) return; at += n; } };
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) { at++; blocks(); }
    else if (kind === 0x2c) {
      count++; if (count > 1) return count;
      const flags = bytes[at + 8]; at += 9 + ((flags & 128) ? 3 * 2 ** ((flags & 7) + 1) : 0);
      at++; blocks();
    } else break;
  }
  return count;
}

async function decodeWebpAlpha(bytes, metadata) {
  if (typeof ImageDecoder !== 'function') return null;
  let codec, frame;
  try {
    codec = new ImageDecoder({ data: bytes, type: 'image/webp', colorSpaceConversion: 'none' });
    ({ image: frame } = await codec.decode({ frameIndex: 0, completeFramesOnly: true }));
    if (!['RGBA', 'BGRA'].includes(frame.format) || frame.rotation || frame.flip) return null;
    const { width, height } = frame.visibleRect;
    dimensions(width, height);
    const data = new Uint8Array(width * height * 4);
    // Keep the decoder's native channel format. Asking copyTo for RGBA triggers
    // color conversion on some browsers and rounds RGB of low-alpha pixels.
    await frame.copyTo(data, { layout: [{ offset: 0, stride: width * 4 }] });
    let hasAlpha = false;
    for (let i = 0; i < data.length; i += 4) {
      if (frame.format === 'BGRA') { const r = data[i + 2]; data[i + 2] = data[i]; data[i] = r; }
      if (data[i + 3] < 255) hasAlpha = true;
      if (!data[i + 3]) data[i] = data[i + 1] = data[i + 2] = 0;
    }
    return { width, height, data, has_alpha: hasAlpha, metadata };
  } catch { return null; } // The existing browser decoder remains the fallback.
  finally { frame?.close(); codec?.close(); }
}

export async function decodeImage(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return decodePng(bytes);
  let metadata = { frames: 1, selected_frame: 0, selection: 'single image' }, mime;
  const header = decoder.decode(bytes.subarray(0, 12));
  if (bytes[0] === 255 && bytes[1] === 216) { ({ bytes, metadata } = selectJpeg(bytes)); mime = 'image/jpeg'; }
  else if (header.startsWith('GIF8')) {
    if (gifFrames(bytes) !== 1) throw new Error('Only single-frame static images are supported (GIF).');
    metadata.format = 'GIF'; mime = 'image/gif';
  } else if (header.startsWith('RIFF') && header.endsWith('WEBP')) {
    const kind = decoder.decode(bytes.subarray(12, 16));
    if (kind === 'VP8X' && (bytes[20] & 2)) throw new Error('Only single-frame static images are supported (animated WebP).');
    metadata.format = 'WEBP'; mime = 'image/webp';
    // Keep EXIF-bearing WebP on the browser's existing orientation path.
    const alpha = kind === 'VP8X' ? (bytes[20] & 16) && !(bytes[20] & 8) : kind === 'VP8L' && (bytes[24] & 16);
    if (alpha) { const image = await decodeWebpAlpha(bytes, metadata); if (image) return image; }
  } else if (bytes[0] === 66 && bytes[1] === 77) { metadata.format = 'BMP'; mime = 'image/bmp'; }
  else throw new Error('Unsupported or damaged image. Use a static PNG, JPEG, WebP, GIF or BMP.');
  if (typeof createImageBitmap !== 'function') throw new Error('This image format needs a browser decoder.');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
    imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  try {
    dimensions(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let hasAlpha = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) hasAlpha = true;
      if (!data[i + 3]) data[i] = data[i + 1] = data[i + 2] = 0;
    }
    return { width: bitmap.width, height: bitmap.height, data, has_alpha: hasAlpha, metadata };
  } finally { bitmap.close(); }
}

export function floatImage(image) {
  const data = new Float32Array(image.data.length);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i] / 255;
  return { ...image, data };
}
export function byteImage(cells, hasAlpha = true) {
  const data = new Uint8Array(cells.rgba.length);
  for (let i = 0; i < data.length; i++) {
    const value = Math.fround(Math.max(0, Math.min(1, cells.rgba[i])) * 255);
    const floor = Math.floor(value), fraction = value - floor;
    data[i] = fraction === .5 ? floor + (floor & 1) : Math.round(value);
  }
  for (let i = 0; i < data.length; i += 4) if (!data[i + 3]) data[i] = data[i + 1] = data[i + 2] = 0;
  return { width: cells.width, height: cells.height, data, has_alpha: hasAlpha };
}

/** PNG files are already compressed; store ZIP entries without recompressing. */
export function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const filename = text.encode(name), bytes = typeof contents === 'string' ? text.encode(contents) : contents;
    const header = new Uint8Array(30 + filename.length), v = new DataView(header.buffer), crc = crc32(bytes);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
    v.setUint16(12, 0x5021, true); v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true); v.setUint32(22, bytes.length, true); v.setUint16(26, filename.length, true); header.set(filename, 30);
    const dir = new Uint8Array(46 + filename.length), d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true); d.setUint16(14, 0x5021, true); d.setUint32(16, crc, true);
    d.setUint32(20, bytes.length, true); d.setUint32(24, bytes.length, true); d.setUint16(28, filename.length, true);
    d.setUint32(42, offset, true); dir.set(filename, 46);
    local.push(header, bytes); central.push(dir); offset += header.length + bytes.length;
  }
  const end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true);
  v.setUint32(12, central.reduce((size, part) => size + part.length, 0), true); v.setUint32(16, offset, true);
  return join([...local, ...central, end]);
}
export function unzipStored(input) {
  const bytes = new Uint8Array(input), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    if (view.getUint16(at + 8, true) !== 0) throw new Error('Unsupported diagnostic archive.');
    const length = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true);
    const start = at + 30 + nameLength + extra, end = start + length;
    if (end > bytes.length) throw new Error('Invalid diagnostic archive.');
    files[decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength))] = bytes.subarray(start, end);
    at = end;
  }
  return files;
}
