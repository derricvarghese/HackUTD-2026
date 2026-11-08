import zlib from 'node:zlib';

/**
 * Pure helpers for case photos: validate a JPEG/PNG, read its size and strip metadata (GPS!) without decoding pixels.
 *
 * - JPEG: APP1 (EXIF/XMP), APP13 (IPTC/Photoshop) and COM segments are removed; everything else (JFIF, ICC, Adobe, quant/Huffman tables,
 *   scan data) is kept byte for byte. Bytes after the final EOI are dropped. NOTE: this also drops the EXIF orientation tag, so clients must
 *   bake the rotation into the pixels BEFORE uploading.
 * - PNG: eXIf, tEXt, iTXt and zTXt chunks are removed; every chunk CRC is verified; bytes after IEND are dropped.
 */

export const IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export class ImageError extends Error {}

export interface CleanImage { width: number; height: number; data: Buffer }

/** Largest accepted edge in pixels (apps downscale to ~1600; this only bounds what dashboards are asked to decode). */
export const MAX_EDGE_PX = 12000;

const bad = (msg: string): never => { throw new ImageError(msg); };

export function sniffImageMime(b: Buffer): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  return null;
}

/** Validates `buf` as the claimed type and returns it with metadata stripped, plus its dimensions. Throws ImageError. */
export function cleanImage(buf: Buffer, mime: string): CleanImage {
  if (mime === 'image/jpeg') return cleanJpeg(buf);
  if (mime === 'image/png') return cleanPng(buf);
  return bad('Unsupported image type');
}

function checkSize(width: number, height: number) {
  if (!(width > 0 && height > 0)) bad('Image has no size');
  if (width > MAX_EDGE_PX || height > MAX_EDGE_PX) bad(`Image larger than ${MAX_EDGE_PX}px on an edge`);
}

// ------------------------------------------------------------------------------------------ JPEG

const DROP_JPEG = new Set([0xe1, 0xed, 0xfe]); // APP1, APP13, COM
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export function cleanJpeg(b: Buffer): CleanImage {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) bad('Not a JPEG');
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let size: { w: number; h: number } | null = null;
  let scans = 0;
  for (;;) {
    // skip fill bytes: any number of 0xFF before the marker code
    if (i >= b.length) bad('Truncated JPEG (no scan data)');
    if (b[i] !== 0xff) bad('Corrupt JPEG segment structure');
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) bad('Truncated JPEG');
    const m = b[i++];
    if (m === 0xd8 || m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // not valid before SOS, ignore standalone markers
    if (m === 0xd9) bad('JPEG ended before any image data');
    if (i + 2 > b.length) bad('Truncated JPEG');
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) bad('Truncated JPEG segment');
    const seg = b.subarray(i - 2, i + len); // FF m LEN payload
    if (isSof(m)) {
      if (len < 8) bad('Corrupt JPEG frame header');
      if (size) bad('JPEG has two frame headers');
      size = { h: b.readUInt16BE(i + 3), w: b.readUInt16BE(i + 5) };
      checkSize(size.w, size.h);
    }
    if (!DROP_JPEG.has(m)) out.push(seg);
    i += len;
    if (m === 0xda) {
      if (!size) bad('JPEG scan before frame header');
      // entropy-coded data: FF is always followed by 00 (stuffing) or D0-D7 (restart) inside it; anything else is the next marker
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7) && b[j + 1] !== 0xff)) j++;
      if (j + 1 >= b.length) bad('Truncated JPEG (no end of image)');
      out.push(b.subarray(i, j));
      i = j;
      scans++;
      if (b[j + 1] === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); break; }
    }
  }
  if (!scans) bad('JPEG has no image data');
  return { width: size!.w, height: size!.h, data: Buffer.concat(out) };
}

// ------------------------------------------------------------------------------------------ PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DROP_PNG = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

export function cleanPng(b: Buffer): CleanImage {
  if (b.length < 8 + 25 || !b.subarray(0, 8).equals(PNG_SIG)) bad('Not a PNG');
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  let w = 0, h = 0, idat = false, iend = false, first = true;
  while (i < b.length && !iend) {
    if (i + 12 > b.length) bad('Truncated PNG chunk');
    const len = b.readUInt32BE(i);
    if (len > 0x7fffffff || i + 12 + len > b.length) bad('Truncated PNG chunk');
    const type = b.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) bad('Corrupt PNG chunk type');
    const crc = b.readUInt32BE(i + 8 + len);
    if (zlib.crc32(b.subarray(i + 4, i + 8 + len)) !== crc) bad('PNG chunk checksum mismatch');
    if (first) {
      if (type !== 'IHDR' || len !== 13) bad('PNG must start with IHDR');
      w = b.readUInt32BE(i + 8); h = b.readUInt32BE(i + 12);
      checkSize(w, h);
      first = false;
    } else if (type === 'IHDR') bad('Duplicate IHDR');
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') iend = true;
    if (!DROP_PNG.has(type)) out.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
  }
  if (!iend) bad('Truncated PNG (no IEND)');
  if (!idat) bad('PNG has no image data');
  return { width: w, height: h, data: Buffer.concat(out) };
}

// ------------------------------------------------------------------------------------------ synthetic images (demo seed, tests)

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Tiny 8-bit RGB PNG encoder: `pixel(x, y)` returns [r, g, b]. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], extra: Buffer[] = []): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const pngChunk = chunk;

/** Valid baseline grayscale JPEG of one flat mid-gray (custom 1-symbol Huffman tables: each 8x8 block is the 2 bits "00"). */
export function encodeGrayJpeg(width: number, height: number): Buffer {
  const seg = (m: number, payload: Buffer) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = Buffer.alloc(Math.ceil((blocks * 2) / 8), 0); // every block: DC symbol "0", AC end-of-block "0"; pad with 1s
  const padFrom = blocks * 2;
  for (let k = padFrom; k < bits.length * 8; k++) bits[k >> 3] |= 0x80 >> (k & 7);
  const dht = (cls: number) => seg(0xc4, Buffer.concat([Buffer.from([cls << 4]), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]));
  const sof = Buffer.alloc(9);
  sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = 1; sof[6] = 1; sof[7] = 0x11; sof[8] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), seg(0xc0, sof), dht(0), dht(1),
    seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])), bits, Buffer.from([0xff, 0xd9]),
  ]);
}

/** A small gradient PNG or gray JPEG for demo data; `variant` picks the colours. */
export function syntheticImage(variant: number): { mime: ImageMime; data: Buffer; width: number; height: number } {
  if (variant % 3 === 2) return { mime: 'image/jpeg', data: encodeGrayJpeg(64, 48), width: 64, height: 48 };
  const hue = [[40, 90, 160], [160, 80, 40], [50, 130, 70]][variant % 3];
  const width = 64, height = 48;
  return { mime: 'image/png', width, height, data: encodePng(width, height, (x, y) => [hue[0] + ((x * 60) >> 6), hue[1] + ((y * 60) / height | 0), hue[2]]) };
}
