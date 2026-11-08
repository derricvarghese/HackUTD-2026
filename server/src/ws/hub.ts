import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from '../logger';
import type { Viewer } from '../domain/privacy';

export type Channel = 'sos' | 'assignments' | 'mesh' | 'deadzones' | 'responders';
const ALL: Channel[] = ['sos', 'assignments', 'mesh', 'deadzones', 'responders'];
export const CHANNEL_OF: Record<string, Channel> = {
  'sos.created': 'sos', 'sos.updated': 'sos', 'sos.merged': 'sos', 'sos.silent': 'sos',
  'profile.updated': 'sos', 'checkin.sent': 'sos', 'checkin.responded': 'sos', 'heartbeat.silent': 'sos', 'heartbeat.resumed': 'sos',
  'agent.step': 'sos', 'agent.updated': 'sos',
  'assignment.created': 'assignments', 'assignment.updated': 'assignments',
  'deadzones.updated': 'deadzones', 'responder.updated': 'responders', 'mesh.stats': 'mesh',
};

type ResponderViewer = Extract<Viewer, { kind: 'responder' }>;
interface Conn { ws: WebSocket; viewer: ResponderViewer; channels: Set<Channel>; alive: boolean; client: 'app' | 'dashboard'; expTimer?: NodeJS.Timeout }

/** Domain services publish events; each connection gets its own redacted frame (never one shared payload). */
export interface Publisher {
  publish(event: string, render: (viewer: ResponderViewer) => unknown | undefined): void;
}

export class Hub implements Publisher {
  private wss = new WebSocketServer({ noServer: true });
  private conns = new Set<Conn>();
  private pingTimer?: NodeJS.Timeout;

  /** `onAppSeen` is called (with the responder ids) whenever a connection opened with `?client=app` shows life: connect, ping/pong, and every 30 s. */
  constructor(private log: Logger, private authenticate: (token: string) => { viewer: ResponderViewer; exp?: number } | null, private onAppSeen: (responderIds: string[]) => void = () => {}) {}

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
      const client = url.searchParams.get('client') === 'app' ? 'app' : 'dashboard';
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, auth, client));
    });
    this.pingTimer = setInterval(() => this.heartbeat(), 30_000);
    this.pingTimer.unref();
  }

  private onConnect(ws: WebSocket, auth: { viewer: ResponderViewer; exp?: number }, client: 'app' | 'dashboard') {
    const c: Conn = { ws, viewer: auth.viewer, channels: new Set(ALL), alive: true, client };
    this.conns.add(c);
    const seen = () => { if (c.client === 'app') this.onAppSeen([c.viewer.id]); };
    seen();
    if (auth.exp) {
      const ms = Math.max(0, auth.exp * 1000 - Date.now());
      c.expTimer = setTimeout(() => ws.close(4401, 'token expired'), Math.min(ms, 2 ** 31 - 1));
      c.expTimer.unref();
    }
    ws.on('pong', () => { c.alive = true; seen(); });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.action === 'subscribe' && Array.isArray(msg.channels)) {
        c.channels = new Set(msg.channels.filter((x: unknown): x is Channel => ALL.includes(x as Channel)));
      } else if (msg?.action === 'ping') {
        seen();
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
      try { const d = render(c.viewer); if (d !== undefined) this.send(c, event, d); } catch (e) { this.log.error({ err: (e as Error).message, event }, 'ws render failed'); }
    }
  }

  get size() { return this.conns.size; }

  private heartbeat() {
    const apps = new Set<string>();
    for (const c of this.conns) if (c.client === 'app' && c.alive) apps.add(c.viewer.id);
    if (apps.size) this.onAppSeen([...apps]);
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
