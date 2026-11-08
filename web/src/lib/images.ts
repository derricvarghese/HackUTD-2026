// Client-side photo pipeline: decode (EXIF orientation honoured), downscale, re-encode. Re-encoding through a canvas also drops all metadata (GPS).
export const MAX_IMAGES = 6;
export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.78;
export const MAX_CAPTION = 200;
/** Lower-quality / smaller-edge passes when the first JPEG is still over the limit. */
const FALLBACKS: { quality: number; edge: number }[] = [
  { quality: JPEG_QUALITY, edge: MAX_EDGE },
  { quality: 0.6, edge: MAX_EDGE },
  { quality: 0.5, edge: 1280 },
  { quality: 0.4, edge: 1024 },
];

export interface Size {
  width: number;
  height: number;
}

/** Scale to fit `max` on the long edge; never upscales; both sides at least 1. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): Size {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** EXIF orientations 5-8 are rotated by 90 degrees: the displayed width/height are the stored ones swapped. */
export function orientedSize(width: number, height: number, orientation: number): Size {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** Canvas matrix [a,b,c,d,e,f] that draws a stored (w x h) bitmap upright for an EXIF orientation 1..8. */
export function orientationMatrix(orientation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, h, 0];
    case 7: return [0, -1, -1, 0, h, w];
    case 8: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/** Reads the EXIF orientation (1..8) from the start of a JPEG; 1 when absent or not a JPEG. */
export function readExifOrientation(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return 1;
    if (marker === 0xffda) return 1; // start of scan: no more headers
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      if (tiff + 8 > v.byteLength) return 1;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > v.byteLength) return 1;
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > v.byteLength) return 1;
        if (v.getUint16(e, little) === 0x0112) {
          const o = v.getUint16(e + 8, little);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

/** Any pixel with alpha < 255? `data` is RGBA. */
export function hasTransparency(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

export interface Processed {
  blob: Blob;
  contentType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

export class ImageError extends Error {
  constructor(message: string, readonly kind: 'unreadable' | 'too_large' | 'not_image') {
    super(message);
    this.name = 'ImageError';
  }
}

/** The bits of a 2D canvas the pipeline needs, so tests can mock it. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    fillStyle: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  } | null;
  toBlob(type: string, quality?: number): Promise<Blob | null>;
}

export interface Decoded {
  source: unknown;
  /** Upright size (EXIF orientation applied) */
  width: number;
  height: number;
  /** Matrix still to be applied when the decoder did not rotate (fallback path); identity otherwise */
  matrix?: [number, number, number, number, number, number];
  /** Stored (unrotated) size the matrix applies to */
  storedWidth?: number;
  storedHeight?: number;
  close?: () => void;
}

export interface ImageEnv {
  decode(file: Blob): Promise<Decoded>;
  canvas(width: number, height: number): CanvasLike;
}

export const browserEnv: ImageEnv = {
  async decode(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Older engines reject the options bag: decode plain and apply the EXIF rotation ourselves.
      const bmp = await createImageBitmap(file);
      const o = file.type === 'image/jpeg' ? readExifOrientation(await file.slice(0, 128 * 1024).arrayBuffer()) : 1;
      const up = orientedSize(bmp.width, bmp.height, o);
      return { source: bmp, width: up.width, height: up.height, matrix: orientationMatrix(o, bmp.width, bmp.height), storedWidth: bmp.width, storedHeight: bmp.height, close: () => bmp.close() };
    }
  },
  canvas(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return {
      get width() { return c.width; },
      set width(v: number) { c.width = v; },
      get height() { return c.height; },
      set height(v: number) { c.height = v; },
      getContext: (k) => c.getContext(k) as ReturnType<CanvasLike['getContext']>,
      toBlob: (type, quality) => new Promise((res) => c.toBlob(res, type, quality)),
    };
  },
};

function draw(env: ImageEnv, d: Decoded, size: Size, flatten: boolean): CanvasLike {
  const cv = env.canvas(size.width, size.height);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new ImageError('This browser cannot process images.', 'unreadable');
  if (flatten) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
  }
  if (d.matrix && d.storedWidth && d.storedHeight) {
    // scale (upright -> output), then rotate/flip, then draw the stored bitmap at output scale
    const k = size.width / d.width;
    const [a, b, c, dd, e, f] = d.matrix;
    ctx.setTransform(a * k, b * k, c * k, dd * k, e * k, f * k);
    ctx.drawImage(d.source, 0, 0, d.storedWidth, d.storedHeight);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(d.source, 0, 0, size.width, size.height);
  }
  return cv;
}

/**
 * Prepares a picked file for upload: decodes it upright, downsizes to at most 1600 px, and encodes JPEG q0.78
 * (smaller passes if it is still over 3 MB). A PNG stays PNG only when it really has transparency and fits in 3 MB.
 */
export async function processImage(file: Blob, env: ImageEnv = browserEnv): Promise<Processed> {
  if (file.type && !file.type.startsWith('image/')) throw new ImageError('That file is not an image.', 'not_image');
  let d: Decoded;
  try {
    d = await env.decode(file);
  } catch {
    throw new ImageError('This image could not be read. Try a JPEG or PNG.', 'unreadable');
  }
  try {
    if (d.width < 1 || d.height < 1) throw new ImageError('This image could not be read. Try a JPEG or PNG.', 'unreadable');
    const first = fitWithin(d.width, d.height, MAX_EDGE);
    if (file.type === 'image/png') {
      const cv = draw(env, d, first, false);
      const px = cv.getContext('2d')?.getImageData(0, 0, first.width, first.height).data;
      if (px && hasTransparency(px)) {
        const png = await cv.toBlob('image/png');
        if (png && png.size <= MAX_BYTES) return { blob: png, contentType: 'image/png', ...first };
      }
    }
    for (const pass of FALLBACKS) {
      const size = fitWithin(d.width, d.height, pass.edge);
      const jpg = await draw(env, d, size, true).toBlob('image/jpeg', pass.quality);
      if (!jpg) throw new ImageError('This image could not be encoded.', 'unreadable');
      if (jpg.size <= MAX_BYTES) return { blob: jpg, contentType: 'image/jpeg', ...size };
    }
    throw new ImageError('This photo is still larger than 3 MB after compression.', 'too_large');
  } finally {
    d.close?.();
  }
}

export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Files from a drop / paste / picker that look like images (the pipeline converts them; non-images are ignored). */
export const pickImageFiles = (files: Iterable<File> | ArrayLike<File> | null | undefined): File[] => (files ? Array.from(files as ArrayLike<File>).filter((f) => f.type.startsWith('image/')) : []);

// ---- object URLs
/** Tracks object URLs so they are always revoked: individually, or all at once when the panel goes away. */
export class ObjectUrlRegistry {
  private urls = new Set<string>();
  create(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    this.urls.add(u);
    return u;
  }
  revoke(url: string | null | undefined) {
    if (url && this.urls.delete(url)) URL.revokeObjectURL(url);
  }
  revokeAll() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
  }
  get size() {
    return this.urls.size;
  }
}

export interface LoadedPhoto {
  url: string;
  blob: Blob;
}

/**
 * Per-panel store of downloaded photos. The bytes need the Authorization header, so they are fetched into blobs and shown through object
 * URLs. Lives inside the Photos section only; `dispose()` revokes everything (nothing ends up in the global query cache).
 */
export class PhotoStore {
  private reg = new ObjectUrlRegistry();
  private loaded = new Map<string, LoadedPhoto>();
  private inflight = new Map<string, Promise<LoadedPhoto>>();
  private disposed = false;
  constructor(private fetchBlob: (imageId: string) => Promise<Blob>) {}

  get(imageId: string): Promise<LoadedPhoto> {
    const done = this.loaded.get(imageId);
    if (done) return Promise.resolve(done);
    const running = this.inflight.get(imageId);
    if (running) return running;
    const p = this.fetchBlob(imageId)
      .then((blob) => {
        if (this.disposed) throw new Error('disposed');
        const photo = { url: this.reg.create(blob), blob };
        this.loaded.set(imageId, photo);
        return photo;
      })
      .finally(() => this.inflight.delete(imageId));
    this.inflight.set(imageId, p);
    return p;
  }
  peek(imageId: string) {
    return this.loaded.get(imageId);
  }
  /** Forget one photo (deleted, or a retry wants fresh bytes). */
  drop(imageId: string) {
    const p = this.loaded.get(imageId);
    if (p) this.reg.revoke(p.url);
    this.loaded.delete(imageId);
  }
  dispose() {
    this.disposed = true;
    this.reg.revokeAll();
    this.loaded.clear();
  }
  get liveUrls() {
    return this.reg.size;
  }
}
