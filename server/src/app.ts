import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Config } from './config';
import type { Ctx } from './ctx';
import { createDb, type Db } from './db';
import { migrate } from './db/migrate';
import { makeLogger, type Logger } from './logger';
import { loadBackendKeys, type BackendKeys } from './crypto/keys';
import { createLlm, type TriageLlm } from './llm/nemotron';
import { TokenBuckets } from './domain/rateLimit';
import { Hub } from './ws/hub';
import { buildRoutes } from './http/routes';
import { securityHandlers } from './http/security';
import { errorHandler, notImplemented } from './http/errorHandler';
import { startJobs } from './jobs';
import { tooMany } from './errors';
import { seedResponders } from './services/responders';
import { verifyAccess } from './services/auth';

export interface AppOverrides { db?: Db; llm?: TriageLlm; keys?: BackendKeys; logger?: Logger }
export interface BeaconApp {
  app: express.Express;
  server: http.Server;
  ctx: Ctx;
  hub: Hub;
  close(): Promise<void>;
}

function findSpec(cfg: Config): string {
  const candidates = [cfg.OPENAPI_PATH, path.join(__dirname, 'openapi.yaml'), path.join(__dirname, '..', '..', 'openapi.yaml')].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`openapi.yaml not found (looked in: ${candidates.join(', ')})`);
  return hit;
}

function findPublicDir(cfg: Config): string | null {
  const candidates = [cfg.PUBLIC_DIR, path.join(__dirname, '..', 'public')].filter(Boolean);
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null;
}

export async function createApp(cfg: Config, o: AppOverrides = {}): Promise<BeaconApp> {
  const log = o.logger ?? makeLogger(cfg);
  const dbh = o.db ?? createDb(cfg.DATABASE_URL);
  if (cfg.RUN_MIGRATIONS_ON_START) await migrate(dbh.pool, (m) => log.info(m));
  const keys = o.keys ?? loadBackendKeys(cfg.BACKEND_ENC_PRIVATE_KEY, cfg.BACKEND_SIGN_PRIVATE_KEY);
  if (keys.ephemeral) log.warn('BACKEND_*_PRIVATE_KEY not set: using ephemeral keys (run `npm run keys`); phones must refetch /server-info after every restart');

  const pending = new Set<Promise<unknown>>();
  let lockTail: Promise<unknown> = Promise.resolve();
  const DEDUPE_LOCK_KEY = 727002;
  const hubRef: { hub?: Hub } = {};
  const ctx: Ctx = {
    cfg, db: dbh.db, pool: dbh.pool, log, keys, llm: o.llm ?? createLlm(cfg),
    hub: { publish: (e, render) => hubRef.hub?.publish(e, render) },
    limiters: {
      login: new TokenBuckets(cfg.LOGIN_RATE_PER_MIN, cfg.LOGIN_RATE_PER_MIN / 60),
      register: new TokenBuckets(cfg.DEVICE_REGISTER_RATE_PER_MIN, cfg.DEVICE_REGISTER_RATE_PER_MIN / 60),
      sender: new TokenBuckets(cfg.SENDER_RATE_PER_HOUR, cfg.SENDER_RATE_PER_HOUR / 3600),
      heartbeat: new TokenBuckets(cfg.HEARTBEAT_RATE_PER_MIN, cfg.HEARTBEAT_RATE_PER_MIN / 60),
      ip: new TokenBuckets(cfg.IP_RATE_PER_MIN, cfg.IP_RATE_PER_MIN / 60),
    },
    cache: new Map(),
    deviceCache: new Map(),
    track(p) { const t = p.catch(() => {}).finally(() => pending.delete(t)); pending.add(t); },
    async idle() { while (pending.size) await Promise.all([...pending]); },
    // Local queue first (holds at most ONE pooled connection for the advisory lock, so a burst cannot exhaust the pool),
    // then a session-level Postgres advisory lock so a second server process serialises with us too.
    dedupeLock(fn) {
      const run = lockTail.then(async () => {
        const c = await dbh.pool.connect();
        try {
          await c.query('select pg_advisory_lock($1)', [DEDUPE_LOCK_KEY]);
          try { return await fn(); } finally { await c.query('select pg_advisory_unlock($1)', [DEDUPE_LOCK_KEY]).catch(() => {}); }
        } finally { c.release(); }
      });
      lockTail = run.catch(() => {});
      return run as Promise<never>;
    },
  };
  if (cfg.SEED_ON_START) await seedResponders(ctx);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false })); // CSP is left to the dashboard host config (map tiles, inline styles)
  app.use(pinoHttp({
    logger: log, genReqId: (req, res) => { const id = (req.headers['x-request-id'] as string) || crypto.randomUUID(); res.setHeader('x-request-id', id); return id; },
    serializers: { req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }), res: (r) => ({ status: r.statusCode }) },
    autoLogging: { ignore: (req) => req.url === '/v1/health' },
  }));
  app.use((req, _res, next) => { req.ctx = ctx; next(); });

  const v1 = express.Router();
  // global per-IP limit (before parsing and auth, so floods are cheap to refuse); health checks are exempt
  v1.use((req, _res, next) => {
    if (req.path === '/health') return next();
    const rl = ctx.limiters.ip.take(req.ip ?? 'unknown');
    next(rl.ok ? undefined : tooMany(rl.retryAfterS));
  });
  // The spec documents bbox/near as raw comma lists and timestamps contain ':'; the validator insists those be percent-encoded. Be liberal in what we accept.
  v1.use((req, _res, next) => {
    const enc = (u: string) => u.replace(/([?&])([^=&]+)=([^&]*)/g, (_m, sep: string, k: string, v: string) =>
      `${sep}${k}=${v.replace(/:/g, '%3A')}`.replace(/^([?&](?:bbox|near)=.*)$/, (x) => x.replace(/,/g, '%2C')));
    if (req.url.includes('?')) { req.url = enc(req.url); req.originalUrl = enc(req.originalUrl); } // only the query string changes; the signed path is untouched
    next();
  });
  v1.use('/sos/:sosId/voice-note', express.raw({ type: 'audio/*', limit: cfg.VOICE_MAX_BYTES, verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  v1.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  v1.use(OpenApiValidator.middleware({
    apiSpec: findSpec(cfg),
    validateRequests: { allowUnknownQueryParameters: true, coerceTypes: true },
    validateResponses: cfg.validateResponses,
    validateSecurity: { handlers: securityHandlers(ctx) },
  }));
  v1.use(buildRoutes(ctx));
  v1.use(notImplemented);
  app.use('/v1', v1);

  // Dashboard: static files + SPA fallback for any non-/v1 GET
  const pub = findPublicDir(cfg);
  if (pub) {
    app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/v1')) return next();
      res.sendFile(path.join(pub, 'index.html'));
    });
  }
  app.use((req, res, next) => next(Object.assign(new Error('Not found'), { status: 404 })));
  app.use(errorHandler(ctx));

  const server = http.createServer(app);
  const hub = new Hub(log, (token) => {
    const c = verifyAccess(ctx, token);
    return c ? { viewer: { kind: 'responder', id: c.sub, role: c.role }, exp: c.exp } : null;
  });
  hubRef.hub = hub;
  hub.attach(server);
  const jobs = cfg.jobsEnabled ? startJobs(ctx) : null;

  return {
    app, server, ctx, hub,
    async close() {
      jobs?.stop();
      await ctx.idle();
      await hub.close();
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
      if (!o.db) await dbh.close();
    },
  };
}
