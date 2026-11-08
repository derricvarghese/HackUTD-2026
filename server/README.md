# Beacon server

TypeScript / Node 22 / Express 5 backend for Beacon: REST API (`/v1`), WebSocket hub (`/v1/ws`) and the responder dashboard (static React build, SPA fallback).
Contract: `../openapi.yaml` (source of truth; every request and, in dev/test, every response is validated against it). Design: `../docs/server-design.md`. Crypto wire format for the Android app: `docs/crypto.md`.

## Run with Docker

```bash
cd server
cp .env.example .env && npm run keys -- --write   # JWT_SECRET + backend keys are required in production mode
docker compose up -d --build                      # db + server (built from server/Dockerfile) on :3000
```

The compose file builds the image from `server/Dockerfile` (context = repo root, since the build embeds `openapi.yaml` and builds `web/`). Migrations and seeding run on boot; the dashboard is served at `/` (log in with `admin` / `beacon-demo`; set `DEMO_MODE=true` to get the seed and simulate tools). Set `NEMOTRON_BASE_URL`, `NEMOTRON_API_KEY`, `NEMOTRON_MODEL` and `DEMO_MODE` in `.env` to configure triage and demo mode.

## Quick start

```bash
cd server
npm install
docker compose up -d db      # Postgres 16 on localhost:5432 (user/pass/db: beacon)
cp .env.example .env
npm run keys -- --write      # generate backend encryption + signing keys into .env (do this once)
npm run migrate              # apply SQL migrations (also run automatically on boot)
npm run dev                  # http://localhost:3000, hot reload
curl localhost:3000/v1/health
```

Seeded responders (password `beacon-demo`, override with `SEED_PASSWORD`): `admin` (admin), `alice` (responder, boat), `bob` (responder, medical), `carol` (volunteer).

| Script | What |
|---|---|
| `npm run dev` | tsx watch |
| `npm run build` / `npm start` | compile to `dist/` (copies migrations + openapi.yaml) and run it |
| `npm test` | unit + e2e (vitest + supertest) against the docker Postgres; creates DB `beacon_test` itself |
| `npm run migrate` / `npm run seed` | migrations / seed responders |
| `npm run keys [-- --write]` | generate backend P-256 key pairs (prints env lines and public halves) |
| `npm run typegen` | regenerate `src/generated/api.ts` from `../openapi.yaml` (needs TypeScript 5.x, so do not bump to 7) |
| `npx tsx scripts/make-envelope.ts http://localhost:3000` | print a valid signed + encrypted batch body (interop fixture / manual curl) |

Config is env based (`src/config.ts`, zod): `DATABASE_URL, JWT_SECRET, BACKEND_ENC_PRIVATE_KEY, BACKEND_SIGN_PRIVATE_KEY, NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_MODEL, DEMO_MODE, PORT, SEED_PASSWORD, ...`.
Without `BACKEND_*_PRIVATE_KEY` (non-production) the server uses ephemeral keys and warns: phones would have to refetch `/server-info` after each restart. Production refuses to start without secrets.
With `NEMOTRON_BASE_URL` empty a deterministic stub triage provider (`stub-nemotron`) is used; set it to the Brev/NIM OpenAI-compatible endpoint (e.g. `http://host:8000/v1`) for real extraction.
Dashboard: the React app in `../web` builds into `server/public` (`cd ../web && npm run build`; or set `PUBLIC_DIR`). `server/public` is gitignored build output, the Docker image builds it in a `web` stage. Without a build the server simply serves no UI. For development run `npm run dev` in `../web` (proxies `/v1` and the websocket to this server). See `../web/README.md`.

## What is implemented (build-order steps 1-7)

- Auth: responder login/refresh (rotating, hashed)/logout/me (bcrypt, 15 min HS256 JWT); device registration and ECDSA request signatures; WS auth via `?token=`.
- Mesh ingest: `POST /sos/batch` and `POST /sos` with signature, expiry, hop-table checks, ECIES decrypt, idempotency, per-sender rate limit, rejection log, signed DELIVERED receipts. `heartbeat`, `checkin_reply` and `offer` envelopes are routed to their services. The batch response also carries pending `messages` (check-in requests, status updates).
- Cases: list (filters, `priority` sort, keyset cursors), detail, patch (optimistic version, score override, notes), delete (admin), events trail, retriage, merge/unmerge, victim `/status`.
- Triage: rules (`domain/triage/rules.ts`) always; Nemotron via the `openai` SDK (4 s timeout, one retry on non-timeout errors, circuit breaker, strict JSON validated with zod) bounded by the rule floor; rules-only fallback sets `llm_used=false`. `GET /health` pings the endpoint (cached 30 s) and reports `triage.status` ok/degraded/down.
- Dedupe: 150 m / 30 min / token similarity; serialised by a Postgres advisory lock (a local queue in front holds at most one pooled connection), so several server processes are safe.
- Assignments: atomic claim through a partial unique index, state machine, audit trail, WS events; every change also queues a signed `status_update` for the victim's phone.
- Check-ins: `GET /checkins/pending` (calling device's own cases only), get/respond/cancel. `checkinTick` sends the first check-in one interval after a case arrives, marks missed ones (`missed=true`, `silent=true`, score +10 per missed attempt capped at 100, never lowered, a `silence` reason), and sends the next attempt with a doubling window (capped at 8x). Replies (REST or `checkin_reply` envelope) reset silence; the boost stays.
- Heartbeats: `POST /heartbeats`, history, `silenceTick` (active -> quiet -> distress using neighbours >= K, an open SOS, safe-message and low-battery guards), silent devices (list/get/acknowledge/promote), `heartbeat.silent` / `heartbeat.resumed` / `sos.silent` WS events. A device that went silent with an open case flags and boosts that case once.
- Events: CRUD, `close` (stops detectors and check-ins, starts retention), `purge` (nulls lat/lng/text/voice/device links, deletes heartbeats, keeps counts, scores and hop stats; approx cells are coarsened to ~11 km), hourly `purgeTick`. One active event; SOS and heartbeats attach to it and detectors only run for it.
- Dead zones: `deadzoneTick` over a ~1 km grid (`domain/deadzone.ts`), `GET /map/deadzones`, `PATCH`, `GET /map/heat`, WS `deadzones.updated`.
- Offers: CRUD, matching (`domain/matching.ts`: boat<-trapped, water<-need_water_meds, medical<-injured, radius, capacity) on create/move and on every new case, matches CRUD, `offer.created` / `offer.matched`, `kind=offer` envelopes.
- Mesh: `mesh_outbox` of backend-signed `BackendMessage`s (`delivered`, `checkin_request`, `status_update`; signature format in `docs/crypto.md` section 5), `GET /mesh/outbox`, `GET /mesh/receipts`, `GET /mesh/stats` (+ `mesh.stats` pushed every 10 s), demo-only `POST /mesh/simulate`, `POST|DELETE /mesh/seed`.
- Voice notes: `PUT|GET|DELETE /sos/{id}/voice-note` (<= 2 MB, ogg/mp4/webm with content sniffing, stored in Postgres, GET only for the assignee/admin, purged with the event).
- Hardening: global per-IP rate limit (`IP_RATE_PER_MIN`), per-device heartbeat limit, abuse flag (`devices.flagged` + `flag_reason` when a device files `CASES_PER_HOUR_FLAG` cases within an hour; the cases are still accepted).
- Privacy: single choke point `toSosView` (`domain/privacy.ts`). Exact location only for admin or the ACTIVE assignee, in REST and in per-connection WS frames; bbox search runs on approximate coordinates; the outbox carries no coordinates or free text.

## Jobs

`src/jobs/index.ts` exports `checkinTick`, `silenceTick`, `deadzoneTick`, `meshStatsTick`, `purgeTick`, all `(ctx, now = new Date())`, so tests call them with a fake clock instead of sleeping. `startJobs` schedules them in-process (30 s / 30 s / 60 s / 10 s / 1 h; 10 s / 10 s / 20 s / 10 s / 60 s in demo mode) behind a per-job Postgres advisory lock. Jobs run when `NODE_ENV != test`, override with `JOBS_ENABLED=true|false`.

## Demo mode

`DEMO_MODE=true` enables `/mesh/simulate` and `/mesh/seed` (404 otherwise) and shrinks the timers (check-in 30 s, silence threshold 60 s, heartbeat 15 s, dead zone quiet window 120 s; each can still be set explicitly via env, and events created with explicit thresholds keep them). Seeding opens a synthetic event when none is active and creates one synthetic device (with heartbeats) per case so check-ins and silence can be shown live; `DELETE /mesh/seed` removes it all.

## Conventions worth knowing

- Device-signed requests: signed string and path rules are in `docs/crypto.md` section 4 (the query string is not signed).
- `GET /sos` hides `merged` cases unless `status=merged` is requested.
- The validator wants `%3A`/`%2C` for `:` and `,` in some query params; a small shim in `src/app.ts` accepts them raw.
- Silence boosts live on the case (`sos.silence_boost`, `sos.heartbeat_boost`) and are re-applied by every re-triage, so priority never drops because of a retriage.
- Not done: voice transcription, FCM push delivery (`push_token` is stored and logged only), notifying offerers through the mesh outbox (BackendMessage has no offer kind), a Schemathesis/Dredd run.
