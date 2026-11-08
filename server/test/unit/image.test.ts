import { describe, expect, it } from 'vitest';
import { cleanImage, cleanJpeg, cleanPng, ImageError, sniffImageMime, syntheticImage } from '../../src/domain/image';
import { jpegWithMetadata, plainJpeg, plainPng, pngWithMetadata } from '../imageFixtures';

const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, 'latin1'));

describe('JPEG', () => {
  it('reads dimensions and strips APP1 (EXIF/XMP), APP13 (IPTC), COM and trailing bytes, keeping the rest', () => {
    const dirty = jpegWithMetadata(24, 16);
    expect(has(dirty, 'Exif')).toBe(true);
    const c = cleanJpeg(dirty);
    expect([c.width, c.height]).toEqual([24, 16]);
    for (const s of ['Exif', 'GPS', 'xmp', 'Photoshop', 'Elm St', 'TRAILING']) expect(has(c.data, s)).toBe(false);
    expect(c.data.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
    expect(has(c.data, 'JFIF')).toBe(true);                       // JFIF (APP0) is kept
    expect(c.data.subarray(c.data.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(cleanJpeg(c.data).data.equals(c.data)).toBe(true);     // idempotent
    expect(c.data.length).toBeLessThan(dirty.length);
  });
  it('a clean JPEG passes through unchanged', () => {
    const j = plainJpeg();
    expect(cleanJpeg(j).data.equals(j)).toBe(true);
  });
  it('rejects truncated, empty-scan and garbage files', () => {
    const j = plainJpeg();
    expect(() => cleanJpeg(j.subarray(0, j.length - 2))).toThrow(ImageError);       // no EOI
    expect(() => cleanJpeg(j.subarray(0, 30))).toThrow(ImageError);                 // cut inside the tables
    expect(() => cleanJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(ImageError);
    expect(() => cleanJpeg(Buffer.from('<html>not a jpeg</html>'))).toThrow(ImageError);
    expect(() => cleanJpeg(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(10)]))).toThrow(ImageError); // segment longer than file
  });
  it('rejects absurd dimensions', () => {
    const j = Buffer.from(plainJpeg());
    const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
    j.writeUInt16BE(60000, sof + 5);
    expect(() => cleanJpeg(j)).toThrow(/larger/);
  });
});

describe('PNG', () => {
  it('reads dimensions and drops eXIf/tEXt/iTXt/zTXt and bytes after IEND', () => {
    const dirty = pngWithMetadata(20, 10);
    const c = cleanPng(dirty);
    expect([c.width, c.height]).toEqual([20, 10]);
    for (const s of ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'Exif', 'GPS', 'lat 32', 'AFTER-IEND']) expect(has(c.data, s)).toBe(false);
    expect(has(c.data, 'IDAT')).toBe(true);
    expect(c.data.equals(plainPng(20, 10))).toBe(true);
  });
  it('rejects truncated, corrupt and garbage files', () => {
    const p = plainPng();
    expect(() => cleanPng(p.subarray(0, p.length - 12))).toThrow(ImageError);       // no IEND
    expect(() => cleanPng(p.subarray(0, 40))).toThrow(ImageError);
    const flipped = Buffer.from(p); flipped[flipped.length - 20] ^= 0xff;            // inside IDAT: CRC mismatch
    expect(() => cleanPng(flipped)).toThrow(/checksum/);
    expect(() => cleanPng(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]))).toThrow(ImageError);
    expect(() => cleanPng(Buffer.from('GIF89a......................................'))).toThrow(ImageError);
  });
});

describe('helpers', () => {
  it('sniffs types and refuses everything else', () => {
    expect(sniffImageMime(plainJpeg())).toBe('image/jpeg');
    expect(sniffImageMime(plainPng())).toBe('image/png');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageMime(Buffer.from('<svg xmlns=""/>'))).toBeNull();
    expect(() => cleanImage(plainPng(), 'image/gif')).toThrow(ImageError);
    expect(() => cleanImage(plainPng(), 'image/jpeg')).toThrow(ImageError); // content does not match the claimed type
  });
  it('synthetic demo images are valid', () => {
    for (const v of [0, 1, 2]) {
      const s = syntheticImage(v);
      const c = cleanImage(s.data, s.mime);
      expect([c.width, c.height]).toEqual([s.width, s.height]);
    }
  });
});
