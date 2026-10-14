import { inflateSync } from 'node:zlib';

export type PngDimensions = { width: number; height: number };
export type PngVisualSignal = {
  sampledPixelCount: number;
  distinctColorBuckets: number;
  dominantColorShare: number;
  luminanceStandardDeviation: number;
  transparentPixelShare: number;
  warnings: ('near_uniform_image' | 'mostly_transparent')[];
  limitation: string;
};

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Reads the bounded IHDR dimensions used to bind capture metadata to PNG bytes. */
export function readPngDimensions(bytes: Buffer): PngDimensions {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('Image is not a complete PNG header.');
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG does not begin with a valid IHDR chunk.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('PNG dimensions must be between 1 and 2048 pixels per side.');
  let offset = 8, sawData = false, sawEnd = false, dataEnded = false, sawPalette = false;
  const dataChunks: Buffer[] = [];
  let bitDepth = 0, colorType = 0, interlaceMethod = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG contains a truncated chunk header.');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error('PNG contains a truncated chunk payload.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG contains an invalid chunk type.');
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = pngCrc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk has an invalid CRC checksum.`);
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG does not begin with a valid IHDR chunk.');
    if (offset > 8 && type === 'IHDR') throw new Error('PNG contains more than one IHDR chunk.');
    if (sawData && type !== 'IDAT' && type !== 'IEND') dataEnded = true;
    if (type === 'IHDR') {
      bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0) throw new Error('PNG uses an unsupported compression or filter method.');
      interlaceMethod = bytes[offset + 20]!;
      const allowedDepths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowedDepths[colorType]?.includes(bitDepth) || interlaceMethod > 1) throw new Error('PNG has an unsupported color type, bit depth, or interlace method.');
    }
    if (type === 'PLTE') {
      if (sawPalette || sawData || length === 0 || length > 768 || length % 3 !== 0) throw new Error('PNG contains an invalid palette chunk.');
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded) throw new Error('PNG IDAT chunks must be consecutive.');
      sawData = true;
      dataChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawData || offset + 12 !== bytes.length || (colorType === 3 && !sawPalette)) throw new Error('PNG has an invalid or incomplete IEND chunk.');
      sawEnd = true;
      break;
    }
    offset += length + 12;
  }
  if (!sawEnd) throw new Error('PNG is missing its terminal IEND chunk.');
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType]!;
  const passStarts = interlaceMethod === 1 ? [[0, 0], [4, 0], [0, 4], [2, 0], [0, 2], [1, 0], [0, 1]] as const : [[0, 0]] as const;
  const passSteps = interlaceMethod === 1 ? [[8, 8], [8, 8], [4, 8], [4, 4], [2, 4], [2, 2], [1, 2]] as const : [[1, 1]] as const;
  const passes = passStarts.map(([startX, startY], index) => {
    const [stepX, stepY] = passSteps[index]!;
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    const rowBytes = Math.ceil(passWidth * channels * bitDepth / 8);
    return { passHeight, rowBytes };
  }).filter(pass => pass.passHeight > 0);
  const expectedInflatedBytes = passes.reduce((total, pass) => total + pass.passHeight * (pass.rowBytes + 1), 0);
  if (!Number.isSafeInteger(expectedInflatedBytes) || expectedInflatedBytes < 1 || expectedInflatedBytes > 64 * 1024 * 1024) {
    throw new Error('PNG decompressed image exceeds the 64 MiB safety limit.');
  }
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(dataChunks), { maxOutputLength: expectedInflatedBytes + 1 }); }
  catch { throw new Error('PNG image data is not a valid bounded DEFLATE stream.'); }
  if (decoded.length !== expectedInflatedBytes) throw new Error('PNG decompressed scanline length does not match its dimensions.');
  let scanlineOffset = 0;
  for (const pass of passes) for (let row = 0; row < pass.passHeight; row++) {
    if (decoded[scanlineOffset]! > 4) throw new Error('PNG scanline uses an invalid filter type.');
    scanlineOffset += pass.rowBytes + 1;
  }
  return { width, height };
}

/**
 * Computes conservative pixel-level warnings for an already valid PNG. This is
 * a transport/visibility diagnostic only; it cannot judge framing or motion.
 */
export function inspectPngVisualSignal(bytes: Buffer): PngVisualSignal {
  const { width, height } = readPngDimensions(bytes);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const interlace = bytes[28]!;
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType]!;
  const palette = new Map<number, [number, number, number]>();
  let paletteAlpha: Buffer | undefined;
  let grayTransparency: number | undefined;
  let rgbTransparency: [number, number, number] | undefined;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') for (let index = 0; index < length / 3; index++) {
      palette.set(index, [data[index * 3]!, data[index * 3 + 1]!, data[index * 3 + 2]!]);
    }
    else if (type === 'tRNS') {
      if (colorType === 0 && length >= 2) grayTransparency = data.readUInt16BE(0);
      else if (colorType === 2 && length >= 6) rgbTransparency = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
      else if (colorType === 3) paletteAlpha = data;
    }
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const compressed = Buffer.concat(idat);
  const channelsPerPixel = channels;
  const bytesPerPixel = Math.max(1, Math.ceil(channelsPerPixel * bitDepth / 8));
  const starts = interlace === 1 ? [[0, 0], [4, 0], [0, 4], [2, 0], [0, 2], [1, 0], [0, 1]] as const : [[0, 0]] as const;
  const steps = interlace === 1 ? [[8, 8], [8, 8], [4, 8], [4, 4], [2, 4], [2, 2], [1, 2]] as const : [[1, 1]] as const;
  const passes = starts.map(([startX, startY], index) => {
    const [stepX, stepY] = steps[index]!;
    return { startX, startY, stepX, stepY,
      passWidth: width <= startX ? 0 : Math.ceil((width - startX) / stepX),
      passHeight: height <= startY ? 0 : Math.ceil((height - startY) / stepY) };
  }).filter(pass => pass.passWidth > 0 && pass.passHeight > 0);
  const expectedLength = passes.reduce((total, pass) => total + pass.passHeight * (Math.ceil(pass.passWidth * channels * bitDepth / 8) + 1), 0);
  const decoded = inflateSync(compressed, { maxOutputLength: expectedLength + 1 });
  let offset = 0;
  const colors = new Map<number, number>();
  const sampleStride = Math.max(1, Math.ceil(width * height / 100_000));
  let sampledPixelCount = 0, transparentPixelCount = 0;
  let meanLuminance = 0, squaredDeviation = 0;
  const rawSample = (row: Uint8Array, sampleIndex: number) => {
    if (bitDepth === 16) return row[sampleIndex * 2]! * 256 + row[sampleIndex * 2 + 1]!;
    if (bitDepth === 8) return row[sampleIndex]!;
    const bitOffset = sampleIndex * bitDepth;
    return row[Math.floor(bitOffset / 8)]! >>> (8 - bitDepth - bitOffset % 8) & ((1 << bitDepth) - 1);
  };
  const scaleSample = (sample: number) => bitDepth === 16 ? Math.round(sample / 257)
    : bitDepth === 8 ? sample : Math.round(sample * 255 / ((1 << bitDepth) - 1));
  const paeth = (left: number, above: number, upperLeft: number) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left), aboveDistance = Math.abs(estimate - above), cornerDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= cornerDistance ? left : aboveDistance <= cornerDistance ? above : upperLeft;
  };
  for (const pass of passes) {
    const rowBytes = Math.ceil(pass.passWidth * channels * bitDepth / 8);
    let previous = new Uint8Array(rowBytes);
    for (let rowIndex = 0; rowIndex < pass.passHeight; rowIndex++) {
      const filter = decoded[offset++]!;
      const row = new Uint8Array(rowBytes);
      for (let byteIndex = 0; byteIndex < rowBytes; byteIndex++) {
        const raw = decoded[offset + byteIndex]!;
        const left = byteIndex >= bytesPerPixel ? row[byteIndex - bytesPerPixel]! : 0;
        const above = previous[byteIndex]!;
        const upperLeft = byteIndex >= bytesPerPixel ? previous[byteIndex - bytesPerPixel]! : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
        row[byteIndex] = (raw + predictor) & 0xff;
      }
      offset += rowBytes;
      previous = row;
      for (let pixelIndex = 0; pixelIndex < pass.passWidth; pixelIndex++) {
        const x = pass.startX + pixelIndex * pass.stepX;
        const y = pass.startY + rowIndex * pass.stepY;
        if ((y * width + x) % sampleStride !== 0) continue;
        const firstSample = pixelIndex * channels;
        let red: number, green: number, blue: number, alpha = 255;
        if (colorType === 0 || colorType === 4) {
          const rawGray = rawSample(row, firstSample);
          red = green = blue = scaleSample(rawGray);
          if (colorType === 4) alpha = scaleSample(rawSample(row, firstSample + 1));
          else if (grayTransparency === rawGray) alpha = 0;
        } else if (colorType === 2 || colorType === 6) {
          const rawRed = rawSample(row, firstSample), rawGreen = rawSample(row, firstSample + 1), rawBlue = rawSample(row, firstSample + 2);
          red = scaleSample(rawRed); green = scaleSample(rawGreen); blue = scaleSample(rawBlue);
          if (colorType === 6) alpha = scaleSample(rawSample(row, firstSample + 3));
          else if (rgbTransparency && rawRed === rgbTransparency[0] && rawGreen === rgbTransparency[1] && rawBlue === rgbTransparency[2]) alpha = 0;
        } else {
          const paletteIndex = rawSample(row, firstSample);
          const entry = palette.get(paletteIndex) ?? [0, 0, 0];
          [red, green, blue] = entry;
          alpha = paletteAlpha?.[paletteIndex] ?? 255;
        }
        sampledPixelCount++;
        if (alpha < 128) transparentPixelCount++;
        const color = alpha < 128 ? 0 : 1 + ((red! >>> 3) << 10) + ((green! >>> 3) << 5) + (blue! >>> 3);
        if (colors.has(color)) colors.set(color, colors.get(color)! + 1);
        else if (colors.size < 257) colors.set(color, 1);
        const luminance = (0.2126 * red! + 0.7152 * green! + 0.0722 * blue!) / 255;
        const delta = luminance - meanLuminance;
        meanLuminance += delta / sampledPixelCount;
        squaredDeviation += delta * (luminance - meanLuminance);
      }
    }
  }
  const dominantColorShare = sampledPixelCount ? Math.max(...colors.values()) / sampledPixelCount : 0;
  const transparentPixelShare = sampledPixelCount ? transparentPixelCount / sampledPixelCount : 0;
  const luminanceStandardDeviation = sampledPixelCount ? Math.sqrt(squaredDeviation / sampledPixelCount) : 0;
  const warnings: PngVisualSignal['warnings'] = [];
  if (sampledPixelCount >= 16 && colors.size <= 3 && dominantColorShare >= 0.995) warnings.push('near_uniform_image');
  if (sampledPixelCount >= 16 && transparentPixelShare >= 0.98) warnings.push('mostly_transparent');
  return { sampledPixelCount, distinctColorBuckets: colors.size, dominantColorShare: Math.round(dominantColorShare * 10_000) / 10_000,
    luminanceStandardDeviation: Math.round(luminanceStandardDeviation * 10_000) / 10_000,
    transparentPixelShare: Math.round(transparentPixelShare * 10_000) / 10_000, warnings,
    limitation: 'Pixel statistics flag only extreme uniformity/transparency. They do not establish correct framing, visible anatomy, pose quality, contact, deformation, or animation intent; inspect the actual PNG.' };
}

/** Fails closed when transport metadata disagrees with the actual PNG header. */
export function assertPngDimensions(bytes: Buffer, expected: PngDimensions): PngDimensions {
  const actual = readPngDimensions(bytes);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`PNG dimensions ${actual.width}x${actual.height} do not match capture metadata ${expected.width}x${expected.height}.`);
  }
  return actual;
}
