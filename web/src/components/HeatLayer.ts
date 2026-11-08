import L from 'leaflet';
import { buildLut, kernelSigmaPx, normalise, type HeatPoint, type HeatRadius } from '../lib/heat';

const GRID_PX = 4;
const PAD = 0.2;
const LUT = buildLut();

/**
 * Smooth density surface on a canvas: every point splats a Gaussian (kernel peak = weight) into a coarse
 * float grid, contributions add, the sum is soft-normalised and coloured through the ramp, then the small
 * image is upscaled with bilinear smoothing. Sits in its own pane above the tiles and below vectors/pins.
 * leaflet.heat was not used: its radius is in pixels (not metres), it blends with source-over instead of
 * summing, it is unmaintained since 2019 and it has no types.
 */
export class HeatLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private small = document.createElement('canvas');
  private points: HeatPoint[] = [];
  private cellKm = 1;
  private size: HeatRadius = 'medium';
  private op = 0.85;
  private raf = 0;

  constructor(private paneName = 'heatPane') {
    super();
  }

  onAdd(map: L.Map): this {
    let pane = map.getPane(this.paneName);
    if (!pane) {
      pane = map.createPane(this.paneName);
      pane.style.zIndex = '350';
      pane.style.pointerEvents = 'none';
    }
    const c = L.DomUtil.create('canvas', 'heat-canvas', pane);
    c.setAttribute('aria-hidden', 'true');
    c.style.pointerEvents = 'none';
    c.style.opacity = String(this.op);
    this.canvas = c;
    map.on('move moveend zoomend resize viewreset', this.schedule, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map): this {
    map.off('move moveend zoomend resize viewreset', this.schedule, this);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas?.remove();
    this.canvas = null;
    return this;
  }

  setData(points: HeatPoint[], cellKm: number): this {
    this.points = points;
    this.cellKm = cellKm;
    this.schedule();
    return this;
  }
  setRadius(size: HeatRadius): this {
    if (size !== this.size) {
      this.size = size;
      this.schedule();
    }
    return this;
  }
  setOpacity(o: number): this {
    this.op = o;
    if (this.canvas) this.canvas.style.opacity = String(o);
    return this;
  }

  private schedule(): void {
    if (!this._map || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.redraw();
    });
  }

  /** Splat points into the field. Exposed through redraw only; separable Gaussian keeps it O(points * r). */
  private redraw(): void {
    const map = this._map as L.Map | undefined;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const s = map.getSize();
    if (!s.x || !s.y) return;
    const padX = Math.round(s.x * PAD);
    const padY = Math.round(s.y * PAD);
    const W = s.x + padX * 2 + GRID_PX;
    const H = s.y + padY * 2 + GRID_PX;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    // anchor the grid to layer space so a point rounds to the same cell on every pan (no shimmer)
    const raw = map.containerPointToLayerPoint([-padX, -padY]);
    const origin = L.point(Math.floor(raw.x / GRID_PX) * GRID_PX, Math.floor(raw.y / GRID_PX) * GRID_PX);
    L.DomUtil.setPosition(canvas, origin);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, bw, bh);
    if (!this.points.length) return;

    const zoom = map.getZoom();
    const sigmaPx = kernelSigmaPx(zoom, map.getCenter().lat, this.cellKm, this.size);
    const sg = sigmaPx / GRID_PX;
    const r = Math.ceil(sg * 3);
    const gw = Math.ceil(W / GRID_PX) + 1;
    const gh = Math.ceil(H / GRID_PX) + 1;
    const field = new Float32Array(gw * gh);
    const k = new Float32Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sg * sg));
    for (const p of this.points) {
      const lp = map.latLngToLayerPoint([p.lat, p.lng]);
      const gx = (lp.x - origin.x) / GRID_PX;
      const gy = (lp.y - origin.y) / GRID_PX;
      if (gx < -r || gy < -r || gx > gw + r || gy > gh + r) continue;
      const cx = Math.round(gx);
      const cy = Math.round(gy);
      for (let j = Math.max(0, cy - r); j <= Math.min(gh - 1, cy + r); j++) {
        const wy = p.w * k[j - cy + r];
        const row = j * gw;
        for (let i = Math.max(0, cx - r); i <= Math.min(gw - 1, cx + r); i++) field[row + i] += wy * k[i - cx + r];
      }
    }
    const img = new ImageData(gw, gh);
    const d = img.data;
    for (let i = 0; i < field.length; i++) {
      const t = normalise(field[i]);
      if (t <= 0.004) continue;
      const li = Math.round(t * 255) * 4;
      const o = i * 4;
      d[o] = LUT[li];
      d[o + 1] = LUT[li + 1];
      d[o + 2] = LUT[li + 2];
      d[o + 3] = LUT[li + 3];
    }
    this.small.width = gw;
    this.small.height = gh;
    this.small.getContext('2d')?.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.small, 0, 0, gw, gh, 0, 0, gw * GRID_PX * dpr, gh * GRID_PX * dpr);
  }
}
