// Reconnecting WebSocket with exponential backoff. Token is fetched fresh for every attempt.
import type { WsFrame } from '../api/models';

export interface SocketHandlers {
  onFrame: (f: WsFrame) => void;
  /** connected; `reconnected` is true for every open after the first */
  onOpen: (reconnected: boolean) => void;
  onDown: () => void;
}

export const backoffMs = (attempt: number, rand = Math.random): number => {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base / 2 + rand() * (base / 2));
};

export function wsUrl(token: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/v1/ws?token=${encodeURIComponent(token)}&client=dashboard`;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private opened = false;

  constructor(private getToken: () => Promise<string | null>, private h: SocketHandlers) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
  }

  private async connect() {
    if (this.stopped) return;
    const token = await this.getToken();
    if (!token || this.stopped) return this.schedule();
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(token));
    } catch {
      return this.schedule();
    }
    this.ws = ws;
    ws.onopen = () => {
      const re = this.opened;
      this.opened = true;
      this.attempt = 0;
      ws.send(JSON.stringify({ action: 'subscribe', channels: ['sos', 'assignments', 'mesh', 'deadzones'] }));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ action: 'ping' })), 25_000);
      this.h.onOpen(re);
    };
    ws.onmessage = (m) => {
      try {
        const f = JSON.parse(String(m.data)) as WsFrame;
        if (f && typeof f.event === 'string') this.h.onFrame(f);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ws = null;
      if (this.stopped) return;
      this.h.onDown();
      this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule() {
    if (this.stopped) return;
    const delay = backoffMs(this.attempt++);
    this.timer = setTimeout(() => void this.connect(), delay);
  }
}
