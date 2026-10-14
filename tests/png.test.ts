import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { assertPngDimensions, inspectPngVisualSignal, readPngDimensions } from '../src/png.js';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number],
  filterRows = false, interlaced = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; header[12] = Number(interlaced);
  const starts = interlaced ? [[0, 0], [4, 0], [0, 4], [2, 0], [0, 2], [1, 0], [0, 1]] as const : [[0, 0]] as const;
  const steps = interlaced ? [[8, 8], [8, 8], [4, 8], [4, 4], [2, 4], [2, 2], [1, 2]] as const : [[1, 1]] as const;
  const rows: Buffer[] = [];
  for (const [passIndex, [startX, startY]] of starts.entries()) {
    const [stepX, stepY] = steps[passIndex]!;
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    let previous = Buffer.alloc(passWidth * 4);
    for (let row = 0; row < passHeight; row++) {
      const y = startY + row * stepY;
      const raw = Buffer.alloc(passWidth * 4);
      for (let x = 0; x < passWidth; x++) raw.set(pixel(startX + x * stepX, y), x * 4);
      const filter = filterRows && !interlaced ? row % 5 : 0;
      const encoded = Buffer.alloc(raw.length + 1); encoded[0] = filter;
      const paeth = (left: number, above: number, corner: number) => {
        const estimate = left + above - corner;
        const dl = Math.abs(estimate - left), da = Math.abs(estimate - above), dc = Math.abs(estimate - corner);
        return dl <= da && dl <= dc ? left : da <= dc ? above : corner;
      };
      for (let index = 0; index < raw.length; index++) {
        const left = index >= 4 ? raw[index - 4]! : 0;
        const above = previous[index]!;
        const corner = index >= 4 ? previous[index - 4]! : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, corner);
        encoded[index + 1] = (raw[index]! - predictor) & 0xff;
      }
      rows.push(encoded);
      previous = raw;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

function indexedPng(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 2; header[9] = 3;
  const palette = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const alpha = Buffer.from([0, 255, 255, 255]);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(Math.ceil(width / 4) + 1);
    for (let x = 0; x < width; x++) row[1 + Math.floor(x / 4)]! |= ((x + y) % 4) << (6 - (x % 4) * 2);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('PLTE', palette), pngChunk('tRNS', alpha), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

test('PNG evidence dimensions are read from the actual IHDR header', () => {
  assert.deepEqual(readPngDimensions(onePixelPng), { width: 1, height: 1 });
  assert.deepEqual(assertPngDimensions(onePixelPng, { width: 1, height: 1 }), { width: 1, height: 1 });
});

test('PNG pixel diagnostics flag only near-uniform or mostly transparent captures and never issue a quality verdict', () => {
  const solid = inspectPngVisualSignal(rgbaPng(8, 8, () => [8, 16, 24, 255]));
  assert.equal(solid.sampledPixelCount, 64);
  assert.equal(solid.dominantColorShare, 1);
  assert.deepEqual(solid.warnings, ['near_uniform_image']);

  const detailed = inspectPngVisualSignal(rgbaPng(8, 8, (x, y) => [x * 31, y * 31, (x + y) * 15, 255]));
  assert.ok(detailed.distinctColorBuckets > 3);
  assert.deepEqual(detailed.warnings, []);
  assert.ok(detailed.luminanceStandardDeviation > 0);

  const transparent = inspectPngVisualSignal(rgbaPng(8, 8, () => [0, 0, 0, 0]));
  assert.deepEqual(transparent.warnings, ['near_uniform_image', 'mostly_transparent']);
  assert.equal(transparent.transparentPixelShare, 1);
  assert.match(transparent.limitation, /do not establish correct framing.*pose quality/i);
});

test('PNG pixel diagnostics correctly decode row filters, Adam7 passes, and indexed transparency', () => {
  const varied = (x: number, y: number): readonly [number, number, number, number] => [x * 29, y * 29, (x * 7 + y * 13) % 256, 255];
  const filtered = inspectPngVisualSignal(rgbaPng(9, 9, varied, true));
  const interlaced = inspectPngVisualSignal(rgbaPng(9, 9, varied, false, true));
  assert.deepEqual(filtered, interlaced, 'all five row filters and Adam7 passes must reconstruct the same sampled pixels');
  assert.equal(filtered.sampledPixelCount, 81);
  assert.ok(filtered.distinctColorBuckets > 3);
  assert.deepEqual(filtered.warnings, []);

  const indexed = inspectPngVisualSignal(indexedPng(8, 8));
  assert.equal(indexed.sampledPixelCount, 64);
  assert.equal(indexed.transparentPixelShare, 0.25);
  assert.ok(indexed.distinctColorBuckets > 1);
  assert.deepEqual(indexed.warnings, []);
});

test('PNG evidence rejects malformed headers, unsafe dimensions, and mismatched capture metadata', () => {
  assert.throws(() => readPngDimensions(Buffer.alloc(32)), /complete PNG header/i);
  const invalidChunk = Buffer.from(onePixelPng);
  invalidChunk.writeUInt32BE(12, 8);
  assert.throws(() => readPngDimensions(invalidChunk), /valid IHDR/i);
  assert.throws(() => readPngDimensions(onePixelPng.subarray(0, onePixelPng.length - 12)), /missing its terminal IEND/i);
  assert.throws(() => readPngDimensions(onePixelPng.subarray(0, onePixelPng.length - 4)), /truncated chunk header/i);
  const unsafeDimensions = Buffer.from(onePixelPng);
  unsafeDimensions.writeUInt32BE(2049, 16);
  assert.throws(() => readPngDimensions(unsafeDimensions), /between 1 and 2048/i);
  assert.throws(() => assertPngDimensions(onePixelPng, { width: 960, height: 540 }), /do not match capture metadata/i);
});

test('PNG evidence rejects corrupted chunk data and corrupted chunk checksums', () => {
  const corruptedData = Buffer.from(onePixelPng);
  const idatOffset = corruptedData.indexOf(Buffer.from('IDAT'));
  assert.ok(idatOffset > 0);
  corruptedData[idatOffset + 5] = (corruptedData[idatOffset + 5] ?? 0) ^ 0x01;
  assert.throws(() => readPngDimensions(corruptedData), /IDAT chunk has an invalid CRC/i);

  const corruptedChecksum = Buffer.from(onePixelPng);
  const ihdrChecksumOffset = 8 + 12 + 13 - 4;
  corruptedChecksum[ihdrChecksumOffset] = (corruptedChecksum[ihdrChecksumOffset] ?? 0) ^ 0x01;
  assert.throws(() => readPngDimensions(corruptedChecksum), /IHDR chunk has an invalid CRC/i);
});

test('PNG evidence rejects CRC-valid but invalid compressed image data and scanline filters', () => {
  const damagedDeflate = Buffer.from(onePixelPng);
  const idatOffset = damagedDeflate.indexOf(Buffer.from('IDAT'));
  assert.ok(idatOffset > 0);
  const idatLength = damagedDeflate.readUInt32BE(idatOffset - 4);
  damagedDeflate[idatOffset + 4] = (damagedDeflate[idatOffset + 4] ?? 0) ^ 0xff;
  damagedDeflate.writeUInt32BE(crc32(damagedDeflate.subarray(idatOffset, idatOffset + 4 + idatLength)), idatOffset + 4 + idatLength);
  assert.throws(() => readPngDimensions(damagedDeflate), /bounded DEFLATE stream/i);

  const ihdr = onePixelPng.subarray(8, 33);
  const invalidFilter = Buffer.concat([
    onePixelPng.subarray(0, 8), ihdr,
    pngChunk('IDAT', deflateSync(Buffer.from([5, 0, 0, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => readPngDimensions(invalidFilter), /invalid filter type/i);
});
