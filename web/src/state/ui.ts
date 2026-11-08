import { create } from 'zustand';
import type { FeedItem } from '../lib/live';
import { pushFeed } from '../lib/live';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface Toast {
  id: number;
  tone: 'error' | 'success' | 'info';
  text: string;
}

interface UiState {
  selectedId: string | null;
  select: (id: string | null) => void;
  connection: ConnectionState;
  setConnection: (c: ConnectionState) => void;
  lastEventAt: number | null;
  touch: () => void;
  feed: FeedItem[];
  addFeed: (i: FeedItem) => void;
  toasts: Toast[];
  toast: (tone: Toast['tone'], text: string) => void;
  dismissToast: (id: number) => void;
  /** null = unknown yet, false = server is not in DEMO_MODE (404), true = available */
  demo: boolean | null;
  setDemo: (v: boolean) => void;
  layers: Record<LayerKey, boolean>;
  toggleLayer: (k: LayerKey) => void;
  navOpen: boolean;
  mapBounds: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
}

export type LayerKey = 'sos' | 'approx' | 'responders' | 'offers' | 'deadzones' | 'heat' | 'geofence';

let toastSeq = 1;

export const useUi = create<UiState>((set) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
  connection: 'connecting',
  setConnection: (connection) => set({ connection }),
  lastEventAt: null,
  touch: () => set({ lastEventAt: Date.now() }),
  feed: [],
  addFeed: (i) => set((s) => ({ feed: pushFeed(s.feed, i) })),
  toasts: [],
  toast: (tone, text) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  demo: null,
  setDemo: (demo) => set({ demo }),
  layers: { sos: true, approx: true, responders: true, offers: true, deadzones: true, heat: true, geofence: true },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  navOpen: false,
  mapBounds: null,
}));
