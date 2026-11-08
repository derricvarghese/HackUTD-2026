import { vi } from 'vitest';
import { ImageError, ObjectUrlRegistry, PhotoStore, fitWithin, hasTransparency, orientationMatrix, orientedSize, processImage, readExifOrientation, type CanvasLike, type Decoded, type ImageEnv } from './images';

describe('size maths', () => {
  it('downscales the long edge to 1600 and never upscales', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(10000, 3)).toEqual({ width: 1600, height: 1 });
  });
  it('EXIF orientations 5-8 swap width and height', () => {
    expect(orientedSize(4000, 3000, 1)).toEqual({ width: 4000, height: 3000 });
    expect(orientedSize(4000, 3000, 3)).toEqual({ width: 4000, height: 3000 });
    expect(orientedSize(4000, 3000, 6)).toEqual({ width: 3000, height: 4000 });
    expect(orientedSize(4000, 3000, 8)).toEqual({ width: 3000, height: 4000 });
  });
  it('rotation matrices send the stored top-left corner where it belongs', () => {
    const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    // 6 = rotate 90 CW: the stored top-left (0,0) ends at the upright top-right (h,0)
    expect(apply(orientationMatrix(6, 400, 300), 0, 0)).toEqual([300, 0]);
    // 8 = rotate 270 CW: stored top-left goes to the upright bottom-left (0,w)
    expect(apply(orientationMatrix(8, 400, 300), 0, 0)).toEqual([0, 400]);
    // 3 = rotate 180
    expect(apply(orientationMatrix(3, 400, 300), 0, 0)).toEqual([400, 300]);
    expect(orientationMatrix(1, 4, 3)).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it('detects transparency', () => {
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 10]))).toBe(true);
  });
});

function jpegWithOrientation(o: number, little = false): ArrayBuffer {
  const b: number[] = [0xff, 0xd8, 0xff, 0xe1];
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(o), 0, 0, ...u32(0));
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = body.length + 2;
  b.push(len >> 8, len & 255, ...body, 0xff, 0xda);
  return new Uint8Array(b).buffer;
}

describe('readExifOrientation', () => {
  it('reads big and little endian values', () => {
    expect(readExifOrientation(jpegWithOrientation(6))).toBe(6);
    expect(readExifOrientation(jpegWithOrientation(8, true))).toBe(8);
  });
  it('falls back to 1 for non JPEG or tiny input', () => {
    expect(readExifOrientation(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBe(1);
    expect(readExifOrientation(new ArrayBuffer(1))).toBe(1);
  });
});

/** A mocked canvas that records what the pipeline asked for. */
function mockEnv(decoded: Partial<Decoded> & { width: number; height: number }, opts: { jpegBytes?: number[]; pngBytes?: number; alpha?: boolean } = {}) {
  const canvases: { w: number; h: number; types: { type: string; q?: number }[]; fills: number; draws: [number, number, number, number][]; transforms: number[][] }[] = [];
  const jpegSizes = [...(opts.jpegBytes ?? [1000])];
  const env: ImageEnv = {
    decode: async () => ({ source: 'bmp', close: vi.fn(), ...decoded }),
    canvas(w, h) {
      const rec = { w, h, types: [] as { type: string; q?: number }[], fills: 0, draws: [] as [number, number, number, number][], transforms: [] as number[][] };
      canvases.push(rec);
      const cv: CanvasLike = {
        width: w,
        height: h,
        getContext: () => ({
          fillStyle: '',
          fillRect: () => { rec.fills++; },
          setTransform: (...m: number[]) => { rec.transforms.push(m); },
          drawImage: (_i, dx, dy, dw, dh) => { rec.draws.push([dx, dy, dw, dh]); },
          getImageData: () => ({ data: new Uint8ClampedArray(opts.alpha ? [0, 0, 0, 0] : [0, 0, 0, 255]) }),
        }),
        toBlob: async (type, q) => {
          rec.types.push({ type, q });
          const size = type === 'image/png' ? (opts.pngBytes ?? 500) : (jpegSizes.length > 1 ? jpegSizes.shift()! : jpegSizes[0]);
          return Object.defineProperty(new Blob([''], { type }), 'size', { value: size });
        },
      };
      return cv;
    },
  };
  return { env, canvases };
}

describe('processImage (mocked canvas)', () => {
  it('downscales to 1600 px and encodes JPEG at quality 0.78 on a white background', async () => {
    const { env, canvases } = mockEnv({ width: 4000, height: 3000 });
    const out = await processImage(new Blob([''], { type: 'image/jpeg' }), env);
    expect(out).toMatchObject({ contentType: 'image/jpeg', width: 1600, height: 1200 });
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ w: 1600, h: 1200, fills: 1 });
    expect(canvases[0].types).toEqual([{ type: 'image/jpeg', q: 0.78 }]);
    expect(canvases[0].draws[0]).toEqual([0, 0, 1600, 1200]);
  });
  it('keeps portrait orientation as decoded (the decoder already applied EXIF)', async () => {
    const { env } = mockEnv({ width: 3000, height: 4000 });
    expect(await processImage(new Blob([''], { type: 'image/jpeg' }), env)).toMatchObject({ width: 1200, height: 1600 });
  });
  it('applies the fallback rotation matrix scaled to the output size', async () => {
    const { env, canvases } = mockEnv({ width: 300, height: 400, matrix: orientationMatrix(6, 400, 300), storedWidth: 400, storedHeight: 300 });
    await processImage(new Blob([''], { type: 'image/jpeg' }), env);
    expect(canvases[0]).toMatchObject({ w: 300, h: 400 });
    expect(canvases[0].transforms[0]).toEqual([0, 1, -1, 0, 300, 0]);
    expect(canvases[0].draws[0]).toEqual([0, 0, 400, 300]);
  });
  it('keeps a PNG only when it has transparency and fits in 3 MB', async () => {
    const png = new Blob([''], { type: 'image/png' });
    const keep = await processImage(png, mockEnv({ width: 100, height: 100 }, { alpha: true, pngBytes: 1000 }).env);
    expect(keep.contentType).toBe('image/png');
    const opaque = await processImage(png, mockEnv({ width: 100, height: 100 }, { alpha: false }).env);
    expect(opaque.contentType).toBe('image/jpeg');
    const huge = await processImage(png, mockEnv({ width: 100, height: 100 }, { alpha: true, pngBytes: 4 * 1024 * 1024 }).env);
    expect(huge.contentType).toBe('image/jpeg');
  });
  it('retries with lower quality when the first JPEG is over 3 MB, then gives up', async () => {
    const big = 4 * 1024 * 1024;
    const { env, canvases } = mockEnv({ width: 4000, height: 3000 }, { jpegBytes: [big, 1000] });
    const out = await processImage(new Blob([''], { type: 'image/jpeg' }), env);
    expect(out.blob.size).toBe(1000);
    expect(canvases.map((c) => c.types[0].q)).toEqual([0.78, 0.6]);
    await expect(processImage(new Blob([''], { type: 'image/jpeg' }), mockEnv({ width: 4000, height: 3000 }, { jpegBytes: [big] }).env)).rejects.toMatchObject({ kind: 'too_large' });
  });
  it('rejects non-images and undecodable files and always closes the bitmap', async () => {
    await expect(processImage(new Blob([''], { type: 'application/pdf' }), mockEnv({ width: 1, height: 1 }).env)).rejects.toBeInstanceOf(ImageError);
    const bad: ImageEnv = { decode: async () => { throw new Error('x'); }, canvas: () => { throw new Error('unused'); } };
    await expect(processImage(new Blob([''], { type: 'image/jpeg' }), bad)).rejects.toMatchObject({ kind: 'unreadable' });
    const close = vi.fn();
    const { env } = mockEnv({ width: 10, height: 10, close });
    await processImage(new Blob([''], { type: 'image/jpeg' }), env);
    expect(close).toHaveBeenCalled();
  });
});

describe('object URL lifecycle', () => {
  let n = 0;
  const create = vi.fn(() => `blob:fake/${++n}`);
  const revoke = vi.fn();
  beforeEach(() => {
    n = 0;
    create.mockClear();
    revoke.mockClear();
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revoke;
  });

  it('registry revokes once, and revokeAll clears everything', () => {
    const r = new ObjectUrlRegistry();
    const a = r.create(new Blob(['a']));
    const b = r.create(new Blob(['b']));
    r.revoke(a);
    r.revoke(a);
    expect(revoke).toHaveBeenCalledTimes(1);
    r.revokeAll();
    expect(revoke).toHaveBeenCalledWith(b);
    expect(r.size).toBe(0);
  });
  it('store fetches each photo once, shares it, and revokes everything on dispose', async () => {
    const fetchBlob = vi.fn(async () => new Blob(['x']));
    const store = new PhotoStore(fetchBlob);
    const [p1, p2] = await Promise.all([store.get('i1'), store.get('i1')]);
    expect(p1.url).toBe(p2.url);
    await store.get('i2');
    await store.get('i1');
    expect(fetchBlob).toHaveBeenCalledTimes(2);
    expect(store.liveUrls).toBe(2);
    store.dispose();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(store.liveUrls).toBe(0);
  });
  it('drop revokes one photo and a later get refetches', async () => {
    const fetchBlob = vi.fn(async () => new Blob(['x']));
    const store = new PhotoStore(fetchBlob);
    const first = await store.get('i1');
    store.drop('i1');
    expect(revoke).toHaveBeenCalledWith(first.url);
    await store.get('i1');
    expect(fetchBlob).toHaveBeenCalledTimes(2);
  });
  it('a fetch that finishes after dispose never leaks an object URL', async () => {
    let done!: (b: Blob) => void;
    const store = new PhotoStore(() => new Promise<Blob>((r) => { done = r; }));
    const p = store.get('late').catch((e: Error) => e.message);
    store.dispose();
    done(new Blob(['x']));
    expect(await p).toBe('disposed');
    expect(create).not.toHaveBeenCalled();
  });
});
