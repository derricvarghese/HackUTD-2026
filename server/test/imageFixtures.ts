import { encodeGrayJpeg, encodePng, pngChunk } from '../src/domain/image';

/** Minimal TIFF/EXIF block with an orientation tag and a GPS IFD (lat/lng text refs + a tiny rational), as a phone camera writes it. */
export function exifWithGps(): Buffer {
  const le = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); b.writeUIntLE(n, 0, bytes); return b; };
  // TIFF header (II, 42, IFD0 at 8); IFD0: Orientation + GPSInfo pointer; GPS IFD: GPSLatitudeRef 'N', GPSLongitudeRef 'W'
  const ifd0 = Buffer.concat([le(2, 2), le(0x0112, 2), le(3, 2), le(1, 4), le(6, 4), le(0x8825, 2), le(4, 2), le(1, 4), le(8 + 2 + 24 + 4, 4), le(0, 4)]);
  const gps = Buffer.concat([le(2, 2), le(1, 2), le(2, 2), le(2, 4), Buffer.from('N\0\0\0'), le(3, 2), le(2, 2), le(2, 4), Buffer.from('W\0\0\0'), le(0, 4)]);
  const tiff = Buffer.concat([Buffer.from('II'), le(42, 2), le(8, 4), ifd0, gps, Buffer.from('GPSLatitude 32.7767 GPSLongitude -96.7970')]);
  return Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
}

const seg = (marker: number, payload: Buffer) => { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };

/** A valid JPEG carrying EXIF (GPS), XMP, IPTC and a comment, plus trailing junk after EOI. */
export function jpegWithMetadata(w = 24, h = 16): Buffer {
  const base = encodeGrayJpeg(w, h);
  return Buffer.concat([
    base.subarray(0, 2), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')), seg(0xe1, exifWithGps()),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta GPSLatitude="32.7"/>')), seg(0xed, Buffer.from('Photoshop 3.0\x008BIM secret')),
    seg(0xfe, Buffer.from('shot at home, 12 Elm St')), base.subarray(2), Buffer.from('TRAILING-GPS-JUNK'),
  ]);
}

export function pngWithMetadata(w = 20, h = 10): Buffer {
  const exif = pngChunk('eXIf', exifWithGps());
  const text = pngChunk('tEXt', Buffer.from('Comment\0lat 32.7767 lng -96.7970'));
  const itxt = pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<GPSLatitude>32.7</GPSLatitude>'));
  const ztxt = pngChunk('zTXt', Buffer.from('Software\0\0x'));
  return Buffer.concat([encodePng(w, h, (x, y) => [x * 10, y * 20, 90], [exif, text, itxt, ztxt]), Buffer.from('AFTER-IEND')]);
}

export const plainJpeg = (w = 24, h = 16) => encodeGrayJpeg(w, h);
export const plainPng = (w = 20, h = 10) => encodePng(w, h, (x, y) => [x * 10, y * 20, 90]);
