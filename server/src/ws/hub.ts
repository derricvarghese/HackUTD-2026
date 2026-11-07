import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from '../logger';
import type { Viewer } from '../domain/privacy';

export type Channel = 'sos' | 'assignments' | 'mesh' | 'deadzones' | 'offers';
const ALL: Channel[] = ['sos', 'assignments', 'mesh', 'deadzones', 'offers'];
export const CHANNEL_OF: Record<string, Channel> = {
  'sos.created': 'sos', 'sos.updated': 'sos', 'sos.merged': 'sos', 'sos.silent': 'sos',
  'checkin.sent': 'sos', 'checkin.responded': 'sos', 'heartbeat.silent': 'sos', 'heartbeat.resumed': 'sos',
  'assignment.created': 'assignments', 'assignment.updated': 'assignments',
  'offer.created': 'offers', 'offer.matched': 'offers',
  'deadzones.updated': 'deadzones', 'mesh.stats': 'mesh',
};

type ResponderViewer = Extract<Viewer, { kind: 'responder' }>;
interface Conn { ws: WebSocket; viewer: ResponderViewer; channels: Set<Channel>; alive: boolean; expTimer?: NodeJS.Timeout }

/** Domain services publish events; each connection gets its own redacted frame (never one shared payload). */
export interface Publisher {
  publish(event: string, render: (viewer: ResponderViewer) => unknown): void;
}

export class Hub implements Publisher {
  private wss = new WebSocketServer({ noServer: true });
  private conns = new Set<Conn>();
  private pingTimer?: NodeJS.Timeout;

  constructor(private log: Logger, private authenticate: (token: string) => { viewer: ResponderViewer; exp?: number } | null) {}

  attach(server: http.Server, path = '/v1/ws') {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) { socket.destroy(); return; }
      const auth = this.authenticate(url.searchParams.get('token') ?? '');
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, auth));
    });
    this.pingTimer = setInterval(() => this.heartbeat(), 30_000);
    this.pingTimer.unref();
  }

  private onConnect(ws: WebSocket, auth: { viewer: ResponderViewer; exp?: number }) {
    const c: Conn = { ws, viewer: auth.viewer, channels: new Set(ALL), alive: true };
    this.conns.add(c);
    if (auth.exp) {
      const ms = Math.max(0, auth.exp * 1000 - Date.now());
      c.expTimer = setTimeout(() => ws.close(4401, 'token expired'), Math.min(ms, 2 ** 31 - 1));
      c.expTimer.unref();
    }
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.action === 'subscribe' && Array.isArray(msg.channels)) {
        c.channels = new Set(msg.channels.filter((x: unknown): x is Channel => ALL.includes(x as Channel)));
      } else if (msg?.action === 'ping') {
        this.send(c, 'pong', {});
      }
    });
    ws.on('close', () => { this.conns.delete(c); if (c.expTimer) clearTimeout(c.expTimer); });
    ws.on('error', () => ws.terminate());
  }

  private send(c: Conn, event: string, data: unknown) {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    c.ws.send(JSON.stringify({ event, data, ts: new Date().toISOString() }));
  }

  publish(event: string, render: (viewer: ResponderViewer) => unknown) {
    const channel = CHANNEL_OF[event];
    for (const c of this.conns) {
      if (channel && !c.channels.has(channel)) continue;
      try { this.send(c, event, render(c.viewer)); } catch (e) { this.log.error({ err: (e as Error).message, event }, 'ws render failed'); }
    }
  }

  get size() { return this.conns.size; }

  private heartbeat() {
    for (const c of this.conns) {
      if (!c.alive) { c.ws.terminate(); this.conns.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }

  async close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.conns) { if (c.expTimer) clearTimeout(c.expTimer); c.ws.terminate(); }
    this.conns.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
