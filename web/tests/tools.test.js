import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { crc32, decodePng, encodePng, decodeImage, floatImage, byteImage, zipFiles, unzipStored } from '../core/tools.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(name, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(name, 4); bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function header(width, height, depth, type, interlace = 0) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width); bytes.writeUInt32BE(height, 4);
  bytes[8] = depth; bytes[9] = type; bytes[12] = interlace;
  return chunk('IHDR', bytes);
}
function png(width, height, depth, type, raw, extra = [], interlace = 0) {
  return Buffer.concat([signature, header(width, height, depth, type, interlace), ...extra,
    chunk('IDAT', deflateSync(raw)), chunk('IEND')]);
}
function pack(samples, depth) {
  if (depth === 8) return Buffer.from(samples);
  const bytes = Buffer.alloc(Math.ceil(samples.length * depth / 8));
  samples.forEach((value, i) => {
    if (depth === 16) bytes.writeUInt16BE(value, i * 2);
    else bytes[Math.floor(i * depth / 8)] |= value << (8 - depth - i * depth % 8);
  });
  return bytes;
}
function uint16(...values) { return pack(values, 16); }
function exif(orientation) {
  const bytes = Buffer.from([73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  return chunk('eXIf', bytes);
}

test('PNG export preserves translucent bytes and uses nearest-neighbor for all scales', async () => {
  const source = { width: 2, height: 2, has_alpha: true,
    data: new Uint8Array([1, 150, 253, 1, 130, 40, 20, 100, 80, 170, 210, 255, 20, 30, 40, 0]) };
  for (let scale = 1; scale <= 16; scale++) {
    const image = await decodePng(await encodePng(source, scale));
    assert.equal(image.width, 2 * scale); assert.equal(image.height, 2 * scale);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const first = (Math.floor(y / scale) * 2 + Math.floor(x / scale)) * 4;
      const expected = [...source.data.slice(first, first + 4)];
      if (!expected[3]) expected.fill(0);
      assert.deepEqual([...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)], expected);
    }
  }
  const rgb = { width: 1, height: 1, has_alpha: false, data: new Uint8Array([12, 34, 56, 255]) };
  assert.equal((await decodePng(await encodePng(rgb))).has_alpha, false);
  await assert.rejects(() => encodePng(source, 0), /scale/);
});

test('packed indexed PNG handles every palette depth and Adam7 empty passes', async () => {
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  for (const depth of [1, 2, 4, 8]) {
    const colors = Array.from({ length: 1 << depth }, (_, i) => [(i * 71) & 255, (i * 13 + 90) & 255, (i * 3 + 170) & 255]);
    const alpha = colors.map((_, i) => i === 0 ? 0 : i === 1 ? 51 : 255);
    const extra = [chunk('PLTE', Buffer.from(colors.flat())), chunk('tRNS', Buffer.from(alpha))];
    for (const [width, height] of [[1, 1], [1, 5], [5, 1], [11, 9]]) for (const interlace of [0, 1]) {
      const index = (x, y) => (x * 19 + y * 71) % colors.length;
      const rows = [];
      for (const [x0, y0, dx, dy] of interlace ? passes : [[0, 0, 1, 1]]) {
        if (x0 >= width || y0 >= height) continue;
        for (let y = y0; y < height; y += dy) {
          const samples = [];
          for (let x = x0; x < width; x += dx) samples.push(index(x, y));
          rows.push(Buffer.from([0]), pack(samples, depth));
        }
      }
      const image = await decodePng(png(width, height, depth, 3, Buffer.concat(rows), extra, interlace));
      const expected = [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const color = index(x, y); expected.push(...(alpha[color] ? colors[color] : [0, 0, 0]), alpha[color]);
      }
      assert.deepEqual([...image.data], expected);
      assert.equal(image.has_alpha, true);
    }
  }
});

test('PNG grayscale and 16-bit channels follow the Python byte-conversion contract', async () => {
  for (const depth of [1, 2, 4, 8]) {
    const max = (1 << depth) - 1;
    const values = [0, 1, Math.floor(max / 2), max];
    const raw = Buffer.concat([Buffer.from([0]), pack(values, depth)]);
    const image = await decodePng(png(4, 1, depth, 0, raw));
    assert.deepEqual([...image.data], values.flatMap(value => [Math.round(value * 255 / max), Math.round(value * 255 / max), Math.round(value * 255 / max), 255]));
  }
  const gray = await decodePng(png(4, 1, 16, 0, Buffer.concat([Buffer.from([0]), uint16(1, 255, 256, 65535)])));
  assert.deepEqual([...gray.data], [1, 1, 1, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  const rgba = await decodePng(png(2, 1, 16, 6, Buffer.concat([Buffer.from([0]), uint16(65535, 4096, 513, 32768, 65000, 500, 40, 255)])));
  assert.deepEqual([...rgba.data], [255, 16, 2, 128, 0, 0, 0, 0]);
  const grayAlpha = await decodePng(png(2, 1, 16, 4, Buffer.concat([Buffer.from([0]), uint16(32768, 65535, 513, 256)])));
  assert.deepEqual([...grayAlpha.data], [128, 128, 128, 255, 2, 2, 2, 1]);
  // Pillow uses the low byte of a transparency key after converting RGB/L/I;16.
  const transparentRgb = await decodePng(png(1, 1, 16, 2, Buffer.concat([Buffer.from([0]), uint16(256, 512, 768)]), [chunk('tRNS', uint16(257, 514, 771))]));
  assert.deepEqual([...transparentRgb.data], [0, 0, 0, 0]);
  const transparentGray = await decodePng(png(2, 1, 16, 0, Buffer.concat([Buffer.from([0]), uint16(256, 65535)]), [chunk('tRNS', uint16(65535))]));
  assert.deepEqual([...transparentGray.data], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('PNG reconstructs all five row filters and validates checksums', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const width = 7, rows = [];
  let previous = Buffer.alloc(width * 3);
  const expected = [];
  for (let filter = 0; filter < 5; filter++) {
    const row = Buffer.from(Array.from({ length: width * 3 }, (_, i) => (i * 17 + filter * 51) & 255));
    const filtered = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0, b = previous[i], c = i >= 3 ? previous[i - 3] : 0;
      const p = a + b - c, ds = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = [a, b, c][ds.indexOf(Math.min(...ds))];
      filtered[i] = row[i] - [0, a, b, Math.floor((a + b) / 2), paeth][filter];
    }
    rows.push(Buffer.from([filter]), filtered); previous = row;
    for (let i = 0; i < row.length; i += 3) expected.push(...row.subarray(i, i + 3), 255);
  }
  const encoded = png(width, 5, 8, 2, Buffer.concat(rows));
  assert.deepEqual([...(await decodePng(encoded)).data], expected);
  encoded[encoded.length - 5] ^= 1;
  await assert.rejects(() => decodePng(encoded), /checksum/);
});

test('PNG EXIF orientation uses all eight transforms exactly once', async () => {
  const orders = ['ABCDEF', 'CBAFED', 'FEDCBA', 'DEFABC', 'ADBECF', 'DAEBFC', 'FCEBDA', 'CFBEAD'];
  const raw = Buffer.from([0, 65, 66, 67, 0, 68, 69, 70]);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const image = await decodePng(png(3, 2, 8, 0, raw, [exif(orientation)]));
    assert.equal(image.width, orientation < 5 ? 3 : 2);
    assert.equal(image.height, orientation < 5 ? 2 : 3);
    assert.equal(String.fromCharCode(...image.data.filter((_, i) => i % 4 === 0)), orders[orientation - 1]);
  }
});

test('PNG rejects corruption, oversized data, and APNG including a separate default image', async () => {
  await assert.rejects(() => decodePng(Buffer.from('not an image')), /signature/);
  await assert.rejects(() => decodePng(png(1, 1, 8, 0, Buffer.from([0]))), /Truncated/);
  await assert.rejects(() => decodePng(png(1, 1, 8, 0, Buffer.from([0, 1, 2]))), /size/);
  await assert.rejects(() => decodePng(png(1, 1, 8, 0, Buffer.from([5, 1]))), /filter/);
  await assert.rejects(() => decodePng(png(1, 1, 8, 3, Buffer.from([0, 1]), [chunk('PLTE', Buffer.from([1, 2, 3]))])), /palette index/);
  const animation = count => { const b = Buffer.alloc(8); b.writeUInt32BE(count); return chunk('acTL', b); };
  const frame = chunk('fcTL', Buffer.alloc(26));
  await assert.rejects(() => decodePng(png(1, 1, 8, 0, Buffer.from([0, 1]), [animation(2), frame])), /single-frame/);
  const separateDefault = Buffer.concat([signature, header(1, 1, 8, 0), animation(1), chunk('IDAT', deflateSync(Buffer.from([0, 1]))), frame, chunk('IEND')]);
  await assert.rejects(() => decodePng(separateDefault), /single-frame/);
  const single = await decodePng(png(1, 1, 8, 0, Buffer.from([0, 1]), [animation(1), frame]));
  assert.deepEqual([...single.data], [1, 1, 1, 255]);
});

test('typed pixels and diagnostic ZIP round-trip without changing bytes', () => {
  const image = { width: 1, height: 1, data: new Uint8Array([1, 2, 253, 128]), has_alpha: true };
  const floats = floatImage(image);
  assert.deepEqual(byteImage({ width: 1, height: 1, rgba: floats.data }).data, image.data);
  const files = { 'grid.json': '{"x":1}', '处理过程.png': new Uint8Array([0, 1, 2, 255]) };
  const archive = zipFiles(files), restored = unzipStored(archive);
  assert.equal(new TextDecoder().decode(restored['grid.json']), files['grid.json']);
  assert.deepEqual(restored['处理过程.png'], files['处理过程.png']);
  assert.deepEqual(archive, zipFiles(files));
});

test('browser decoding requests EXIF orientation and releases the decoded bitmap', async () => {
  const previousBitmap = globalThis.createImageBitmap, previousCanvas = globalThis.OffscreenCanvas;
  let closed = false;
  globalThis.createImageBitmap = async (blob, options) => {
    assert.equal(blob.type, 'image/jpeg');
    assert.deepEqual(options, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { width: 1, height: 1, close() { closed = true; } };
  };
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([20, 40, 60, 255]) }; } }; }
  };
  try {
    const image = await decodeImage(new Uint8Array([255, 216, 255, 217]));
    assert.deepEqual([...image.data], [20, 40, 60, 255]);
    assert.equal(image.has_alpha, false);
    assert.equal(image.metadata.format, 'JPEG');
    assert.equal(closed, true);
  } finally {
    if (previousBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousBitmap;
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
  }
});

test('transparent WebP copies native BGRA without low-alpha color conversion', async () => {
  const original = globalThis.ImageDecoder;
  let frameClosed = false, decoderClosed = false;
  globalThis.ImageDecoder = class {
    constructor(options) {
      assert.equal(options.type, 'image/webp');
      assert.equal(options.colorSpaceConversion, 'none');
    }
    async decode(options) {
      assert.deepEqual(options, { frameIndex: 0, completeFramesOnly: true });
      return { image: { format: 'BGRA', rotation: 0, flip: false, visibleRect: { width: 2, height: 1 },
        async copyTo(data, options) {
          assert.deepEqual(options, { layout: [{ offset: 0, stride: 8 }] });
          data.set([253, 150, 1, 1, 30, 40, 50, 0]);
        }, close() { frameClosed = true; } } };
    }
    close() { decoderClosed = true; }
  };
  try {
    const encoded = Buffer.alloc(25); encoded.write('RIFF', 0); encoded.write('WEBP', 8); encoded.write('VP8L', 12); encoded[24] = 16;
    const image = await decodeImage(encoded);
    assert.deepEqual([...image.data], [1, 150, 253, 1, 0, 0, 0, 0]);
    assert.equal(image.has_alpha, true);
    assert.equal(frameClosed, true); assert.equal(decoderClosed, true);
  } finally {
    if (original === undefined) delete globalThis.ImageDecoder; else globalThis.ImageDecoder = original;
  }
});
