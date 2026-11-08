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

Seeded responders (password `beacon-demo`, override with `SEED_PASSWORD`): `admin` (admin), `alice` (responder, boat), `bob` (responder, medical), `carol` (volunteer), 

| Script | What |
|---|---|
| `npm run dev` | tsx watch |
| `npm run build` / `npm start` | compile to `dist/` (copies migrations + openapi.yaml) and run it |
| `npm test` | unit + e2e (vitest + supertest) against the docker Postgres; creates DB `beacon_test` itself |
| `npm run migrate` / `npm run seed` | migrations / seed responders |
| `npm run keys [-- --write]` | generate backend P-256 key pairs (prints env lines and public halves) |
| `npm run typegen` | regenerate `src/generated/api.ts` from `../openapi.yaml` (needs TypeScript 5.x, so do not bump to 7) |
| `npx tsx scripts/make-envelope.ts http://localhost:3000` | print a valid signed + encrypted batch body (interop fixture / manual curl) |

Config is env based (`src/config.ts`, zod): `DATABASE_URL, JWT_SECRET, BACKEND_ENC_PRIVATE_KEY, BACKEND_SIGN_PRIVATE_KEY, NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_MODEL, NEMOTRON_TIMEOUT_MS, AI_TRIAGE_CONCURRENCY, AI_TRIAGE_MAX_ATTEMPTS, AI_TRIAGE_BACKOFF_MS, AI_TRIAGE_SWEEP_S, AI_TRIAGE_FAILED_RETRY_S, AI_TRIAGE_FAILED_MAX_SWEEPS, AI_TRIAGE_MAX_AGE_H, AI_TRIAGE_BREAKER_WAIT_MS, AI_TRIAGE_DEMO_DELAY_MS, DEMO_MODE, PORT, SEED_PASSWORD, PROFILE_ENC_KEY, PROFILE_RETENTION_DAYS, PROFILE_REQUIRED, PROFILE_CONSENT_VERSION, PROFILE_WRITE_RATE_PER_MIN, ...`.
Without `BACKEND_*_PRIVATE_KEY` (non-production) the server uses ephemeral keys and warns: phones would have to refetch `/server-info` after each restart. Production refuses to start without secrets.
With `NEMOTRON_BASE_URL` empty a deterministic stub triage provider (`stub-nemotron`) is used; set it to the Brev/NIM OpenAI-compatible endpoint (e.g. `http://host:8000/v1`) for real extraction.
Dashboard: the React app in `../web` builds into `server/public` (`cd ../web && npm run build`; or set `PUBLIC_DIR`). `server/public` is gitignored build output, the Docker image builds it in a `web` stage. Without a build the server simply serves no UI. For development run `npm run dev` in `../web` (proxies `/v1` and the websocket to this server). See `../web/README.md`.

## What is implemented (build-order steps 1-7)

- Auth: responder login/refresh (rotating, hashed)/logout/me (bcrypt, 15 min HS256 JWT); device registration and ECDSA request signatures; WS auth via `?token=`.
- Mesh ingest: `POST /sos/batch` and `POST /sos` with signature, expiry, hop-table checks, ECIES decrypt, idempotency, per-sender rate limit, rejection log, signed DELIVERED receipts. `heartbeat` and `checkin_reply` envelopes are routed to their services. The batch response also carries pending `messages` (check-in requests, status updates).
- Cases: list (filters, `priority` sort, keyset cursors), detail, patch (optimistic version, score override, notes), delete (admin), events trail, retriage, merge/unmerge, victim `/status`.
- Triage is two-step. Rules (`domain/triage/rules.ts`) score every case synchronously: it is stored, returned and broadcast (`sos.created`) at once with `triage_status: provisional`; nothing waits for the LLM. A background queue (`services/aiTriage.ts`, `AI_TRIAGE_CONCURRENCY` workers, one job per case, DB row-claim so several instances never double-process) then calls Nemotron via the `openai` SDK (`NEMOTRON_TIMEOUT_MS`, circuit breaker, strict JSON validated with zod, thinking disabled, `/v1` appended to bare base URLs), bounded by the rule floor and +/-15, persists the combined result, sets `complete` and broadcasts `sos.updated`. Up to `AI_TRIAGE_MAX_ATTEMPTS` (3) attempts with `AI_TRIAGE_BACKOFF_MS` (2s,8s,30s); an open breaker makes jobs wait; after the last attempt the case is `failed` (rules score stands, `llm_used=false`, "AI unavailable; scored by rules only") and a 30 s sweep retries failed cases every `AI_TRIAGE_FAILED_RETRY_S` (300 s, `AI_TRIAGE_FAILED_MAX_SWEEPS` = 6) and re-queues stuck cases after a restart (`AI_TRIAGE_MAX_AGE_H` limit). Edits, profile changes, merges and `POST /sos/{id}/retriage` re-run the rules at once (provisional again) and then the AI. With the stub LLM, `AI_TRIAGE_DEMO_DELAY_MS` (1500 in `DEMO_MODE`) makes the transition visible. `GET /health` pings the endpoint (cached 30 s) and reports `triage.status` ok/degraded/down plus `triage.queue_depth` and `triage.oldest_pending_seconds`. Migration `007_ai_triage.sql`.
- Dedupe: 150 m / 30 min / token similarity; serialised by a Postgres advisory lock (a local queue in front holds at most one pooled connection), so several server processes are safe.
- Assignments: atomic claim through a partial unique index, state machine, audit trail, WS events; every change also queues a signed `status_update` for the victim's phone.
- Check-ins: `GET /checkins/pending` (calling device's own cases only), get/respond/cancel. `checkinTick` sends the first check-in one interval after a case arrives, marks missed ones (`missed=true`/`overdue`, `silent=true`, score +10 (+20 if still heartbeating) then +5 per 10 min overdue, welfare cap +30, never lowered, a `silence` reason). An overdue check-in stays the only active one: no new check-in is created until it is answered; the same `checkin_id` is re-delivered (mesh request with `body.reminder`, push, REST lists) every `CHECKIN_REMINDER_S` (300 s; DEMO 20 s), every `CHECKIN_REMINDER_SLOW_S` (900 s) after 12 reminders, until answered/resolved/closed. Replies (REST or `checkin_reply` envelope) reset silence; the boost stays.
- Heartbeats: `POST /heartbeats`, history, `silenceTick` (active -> quiet -> distress using neighbours >= K, an open SOS, safe-message and low-battery guards), silent devices (list/get/acknowledge/promote), `heartbeat.silent` / `heartbeat.resumed` / `sos.silent` WS events. A device that went silent with an open case flags and boosts that case once.
- Events: CRUD, `close` (stops detectors and check-ins, starts retention), `purge` (nulls lat/lng/text/voice/device links, deletes heartbeats, keeps counts, scores and hop stats; approx cells are coarsened to ~11 km), hourly `purgeTick`. One active event; SOS and heartbeats attach to it and detectors only run for it.
- Dead zones: `deadzoneTick` over a ~1 km grid (`domain/deadzone.ts`), `GET /map/deadzones`, `PATCH`, `GET /map/heat`, WS `deadzones.updated`.
- Mesh: `mesh_outbox` of backend-signed `BackendMessage`s (`delivered`, `checkin_request`, `status_update`; signature format in `docs/crypto.md` section 5), `GET /mesh/outbox`, `GET /mesh/receipts`, `GET /mesh/stats` (+ `mesh.stats` pushed every 10 s), demo-only `POST /mesh/simulate`, `POST|DELETE /mesh/seed`.
- Voice notes: `PUT|GET|DELETE /sos/{id}/voice-note` (<= 2 MB, ogg/mp4/webm with content sniffing, stored in Postgres, GET only for the assignee/admin, purged with the event).
- Case images: `PUT|GET|DELETE /sos/{id}/images/{imageId}` + `GET /sos/{id}/images` (see "Images" below).
- Hardening: global per-IP rate limit (`IP_RATE_PER_MIN`), per-device heartbeat limit, abuse flag (`devices.flagged` + `flag_reason` when a device files `CASES_PER_HOUR_FLAG` cases within an hour; the cases are still accepted).
- Profiles (identity): `PUT|GET|DELETE /devices/{id}/profile`, `Sos.profile` / `SosDetail.profile_full`, `profile.updated` WS frame, `MeshPayload.profile_summary`, `ServerInfo.profile_required` + `profile_consent_version`, `Device.profile_version`. Table `profiles` (migration 003): `full_name`, `name_norm`, `preferred_name`, `birth_year` and coarse `vuln_flags` in clear text (queryable, shown as name/age bucket/flags), everything else AES-256-GCM encrypted in `enc` (`src/crypto/profileCrypto.ts`, key via HKDF from `PROFILE_ENC_KEY`, falling back to `JWT_SECRET`). Consent is mandatory (`consent.accepted=true` and `consent.version == PROFILE_CONSENT_VERSION`, else 422 and nothing stored). `If-Match: <profile_version>` gives optimistic concurrency (409). Profile writes re-triage the device's open cases (`domain/profile.ts` `profileScore`: oxygen/cannot_walk +10, medical +5, child/elderly +5, sensory/cognitive +3, household >= 5 +3, capped at +25 and by the usual 0..100 clamp and rule floors) and the Nemotron prompt receives a sanitised `profile_context` (age range, flags, conditions, medications, mobility needs; never name, phone, address or contacts). Cross-device dedupe gets +0.15 for an identical normalised two-word name. Lifecycle: deleted with the device (FK cascade), with `DELETE /sos/{id}` / event purge / event delete when the device has no case left, and by `purgeTick` after `PROFILE_RETENTION_DAYS` of inactivity (no case, profile not updated and device not seen). Demo `seed`/`simulate` generate synthetic profiles (`synthetic=true`). Profile content is never logged (pino redaction + tested).
- Privacy: single choke points `toSosView` and `toProfileView` (`domain/privacy.ts`). Exact location and full profile details only for admin or the ACTIVE assignee (the profile's own device also sees its profile), in REST and in per-connection WS frames; the full name, age bucket and coarse vulnerability flags are visible to every dashboard user; bbox search runs on approximate coordinates; the outbox carries no coordinates or free text.

## Images

People (and responders on scene) attach photos to a case. The model is the voice note, with a client-generated id for idempotency.

- `PUT /sos/{sosId}/images/{imageId}?caption=` (tag Images): raw `image/jpeg` or `image/png`; `imageId` is a client UUID, so a retry is safe (`201` first time, `200` replay with the stored metadata). Allowed: the case's own device (device signature; a gateway may not), an admin, or the responder holding the active assignment. `413` over `IMAGE_MAX_BYTES` (3 MB), `415` any other type (no SVG/GIF/WebP/HEIC), `422` when the magic bytes, the header or the structure do not parse (truncated or garbage), `409` when the case already has `IMAGE_MAX_PER_CASE` (6) photos and the id is new (or the id belongs to another case), `429` over `IMAGE_UPLOAD_RATE_PER_MIN` per caller (default 20).
- `GET /sos/{sosId}/images` (metadata: id, content_type, bytes, width, height, caption, uploaded_by `{kind, responder_name?}`, created_at) and `GET /sos/{sosId}/images/{imageId}` (raw bytes; `Cache-Control: private, max-age=3600`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`): the owning device (its own photos only), admins and the ACTIVE assignee; everyone else gets `403`. `DELETE` by the uploader, the owning device or an admin.
- `Sos.image_count` is public (a number); `SosDetail.images` (metadata) appears only for admin/active assignee, mirroring `profile_full`. A primary case also shows the photos of the duplicates merged into it (group lookup, responders only). `sos.updated` is emitted when photos are added/removed and carries the count only: bytes, ids and captions never appear in WS frames or logs.
- Metadata is stripped on the server (`domain/image.ts`, pure and unit tested): JPEG APP1 (EXIF/XMP), APP13 (IPTC) and COM segments, PNG eXIf/tEXt/iTXt/zTXt chunks, anything after EOI/IEND. This drops the EXIF orientation tag too, so clients must bake the rotation in before uploading. Dimensions are parsed from the header (max 12000 px per edge) and PNG chunk CRCs are verified.
- Storage: Postgres `case_images` (bytea, migration `006_case_images.sql`), deleted with the case (cascade) and with the device, purged with the event (`purged_images` in the purge response), never part of any profile or other endpoint.
- Mesh: photos never travel over the mesh. An offline SOS may carry `MeshPayload.image_count` (or `has_images`), surfaced as `Sos.image_hint`; the phone uploads the photos itself once it is online.
- Demo: `/mesh/seed` and `/mesh/simulate` attach 0-3 tiny synthetic placeholder images (caption "Synthetic demo image") to some cases.
- Env: `IMAGE_MAX_BYTES=3145728`, `IMAGE_MAX_PER_CASE=6`, `IMAGE_UPLOAD_RATE_PER_MIN=20`.

## Liveness (heartbeats + welfare check-ins)

Heartbeats are automatic (no "I'm OK" button anywhere): every app sends one every `heartbeat_interval_seconds` and a missing heartbeat means the device has no connectivity (`Device.connectivity`, `Sos.connectivity`, `Sos.contact_state`). An open SOS that goes quiet for `silence_threshold_seconds` becomes `silent` (+10..+30). People with an open non-safe SOS additionally get welfare check-ins (critical 10 / high 15 / normal 30 min) with `choices` and `deadline_at`; the case turns `silent` only after `deadline_at` passes unanswered and the check-in is then re-delivered as reminders (no new check-ins pile up) (`unresponsive` if heartbeats still arrive, `lost_contact` if not). Delivery: mesh `checkin_request`, `pending_checkins` in the heartbeat response, `GET /checkins/pending`, and push (`PushProvider`; FCM v1 when `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_JSON` are set, otherwise a logging no-op; real push needs Firebase credentials). Details: docs/server-design.md 6.4.

## Dispatch agent

A Nemotron tool-calling agent (`src/agent/`) that plans, calls internal and external tools in parallel, cross-checks the evidence and PROPOSES a dispatch; a human approves it (design: docs/server-design.md 6.11). It runs after the AI triage extraction of each case, is read-only (its only output is a stored assessment and proposal) and its `urgency_delta` goes through the same +/-15 clamp and rule floors as the extraction.

- API (admin and responders, volunteers get 403): `GET /sos/{id}/agent`, `GET /sos/{id}/agent/runs`, `POST /sos/{id}/agent/run`, `POST /sos/{id}/agent/proposals/{pid}/approve|reject`, `GET /events/{id}/facilities`. WebSocket: `agent.step`, `agent.updated`. `Sos.agent_status` / `agent_summary`; `/health` has `agent: {status, queue_depth, running}`.
- Env: `AGENT_ENABLED` (default on when `NEMOTRON_BASE_URL` is set), `AGENT_MAX_STEPS=6`, `AGENT_TIMEOUT_MS=25000`, `AGENT_CONCURRENCY=2`, `AGENT_THINKING=false`, `AGENT_EXTERNAL_TOOLS=true` (false = no outbound HTTP, tests/offline), `AGENT_RERUN_MIN_S=120`, `AGENT_DEMO_WEATHER=flash_flood` (with `DEMO_MODE=true`: recorded flash flood warning and rising gauge, labelled synthetic), `OVERPASS_URLS`, `FACILITIES_MAX_ATTEMPTS`. See `.env.example`.
- Privacy: external requests and the LLM prompt only ever carry coordinates rounded to 3 decimals; traces hold step summaries, no names, phones, addresses, contacts or exact coordinates.
- Tests: `test/unit/agent.test.ts`, `test/e2e/agentLoop.test.ts`, `test/e2e/agent.test.ts` (scripted fake LLM, recorded fixtures in `test/fixtures/agent/`; no network).

## Responder presence
`PUT /auth/me/presence {state: online|offline, client: app|dashboard}` (app default). The app sends `online` when responder mode opens and every 60 s, `offline` when it closes; only the app sets `in_app`/`available`. `PATCH /responders/{id}` with `X-Beacon-Client: app` and `/v1/ws?client=app` also refresh `last_app_seen_at`. The `presenceTick` job flips responders silent for `RESPONDER_PRESENCE_TIMEOUT_S` (180 s; demo 30) to `in_app=false, available=false`. Live `responder.updated` frames (channel `responders`, admin + responders only, <= 1/s per responder) feed the dashboard map; volunteers never see positions. The dispatch agent prefers `available && in_app` responders with a position newer than `RESPONDER_POSITION_FRESH_S` (900 s). Demo seed (`/mesh/seed|simulate`) adds responder `dave` and a presence mix.

## Jobs

`src/jobs/index.ts` exports `checkinTick`, `silenceTick`, `deadzoneTick`, `meshStatsTick`, `purgeTick`, all `(ctx, now = new Date())`, so tests call them with a fake clock instead of sleeping. `startJobs` schedules them in-process (30 s / 30 s / 60 s / 10 s / 1 h; 10 s / 10 s / 20 s / 10 s / 60 s in demo mode) behind a per-job Postgres advisory lock. Jobs run when `NODE_ENV != test`, override with `JOBS_ENABLED=true|false`.

## Demo mode

`DEMO_MODE=true` enables `/mesh/simulate` and `/mesh/seed` (404 otherwise) and shrinks the timers (welfare check-in 20/25/30 s with a 30 s window, silence threshold 60 s, heartbeat 15 s, dead zone quiet window 120 s; each can still be set explicitly via env, and events created with explicit thresholds keep them). Seeding opens a synthetic event when none is active and creates one synthetic device per case with a 3-5 beat heartbeat history (about 70% connected, 15% quiet, 15% lost contact, the latter already flagged silent) so check-ins and silence can be shown live; `DELETE /mesh/seed` removes it all.

## Conventions worth knowing

- Device-signed requests: signed string and path rules are in `docs/crypto.md` section 4 (the query string is not signed).
- `GET /sos` hides `merged` cases unless `status=merged` is requested.
- The validator wants `%3A`/`%2C` for `:` and `,` in some query params; a small shim in `src/app.ts` accepts them raw.
- Silence boosts live on the case (`sos.silence_boost`, `sos.heartbeat_boost`) and are re-applied by every re-triage, so priority never drops because of a retriage.
- Not done: voice transcription, FCM needs real Firebase credentials to be exercised (the provider is implemented, tested with a fake), a Schemathesis/Dredd run.
