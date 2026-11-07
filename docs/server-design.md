# Beacon server design

One Node process serves the REST API (`/v1`), the WebSocket hub (`/v1/ws`) and the built React dashboard (static, SPA fallback). The contract is `openapi.yaml`; this doc covers how to build it.

## 1. Stack
- TypeScript, Node 22, Express 5, `ws` for WebSockets, PostgreSQL 16 (with PostGIS optional; plain lat/lng + geohash is enough).
- Contract-first: validate every request/response against `openapi.yaml` (`express-openapi-validator`), generate TS types (`openapi-typescript`). The spec is the source of truth; do not hand-write DTOs.
- DB access: `pg` + `kysely` (typed SQL) and plain SQL migrations (`node-pg-migrate`). No heavy ORM.
- Jobs: in-process scheduler (`setInterval` + Postgres advisory lock), no Redis/queue. Single instance is fine for a hackathon; the lock keeps it safe if two start.
- LLM: Nemotron on Brev through an OpenAI-compatible client (`openai` SDK with `baseURL`).
- Crypto: Node `crypto` (ECDSA P-256 verify, HPKE/ECIES decrypt). Tink on Android must be configured to a scheme Node can decrypt. **Spike this first** (see risks).

## 2. Repo layout
```
server/
  src/
    app.ts            express app, middleware order, static dashboard
    config.ts         env parsing (zod)
    http/             routers per tag: auth, devices, sos, checkins, assignments,
                      responders, offers, mesh, events, heartbeats, map, system
    domain/           pure logic, no IO
      triage/rules.ts scoring rules
      dedupe.ts       similarity + merge decision
      hops.ts         tier -> max_hops/ttl table, validation
      silence.ts      heartbeat/check-in silence state machine
      deadzone.ts     grid-cell dead zone detection
      privacy.ts      redaction (exact vs approx location)
    services/         IO orchestration: ingest, triage, checkins, assignments, matching, purge
    crypto/           verify.ts, decrypt.ts, canonical.ts (canonical JSON), receipts.ts (sign)
    llm/nemotron.ts   client, prompt, JSON-schema output, timeout + fallback
    ws/hub.ts         connections, channels, broadcast with per-user redaction
    jobs/             silenceTick, checkinTick, deadzoneTick, meshStatsTick, purgeTick
    db/               pool, migrations/, queries
  test/               unit (domain), contract (spec), e2e (supertest + testcontainers)
web/                  React dashboard (built into server/public)
```

## 3. Request pipeline
`helmet` -> request id/logging (pino) -> body parser (1 MB; audio routes raw 2 MB) -> rate limit -> auth resolver (JWT or device signature) -> OpenAPI validator -> router -> error handler (maps to the `Error` schema). Dashboard static files and SPA fallback mounted after `/v1`.

## 4. Auth
- Responders: bcrypt/argon2 passwords, 15 min access JWT + rotating refresh token stored hashed (`refresh_tokens`). Roles: responder, volunteer, admin. Seed a hardcoded list at startup (README scope).
- Devices: `X-Device-Id`, `X-Timestamp` (reject skew > 5 min), `X-Device-Signature` = ECDSA over `METHOD\nPATH\nSHA256(body)\nTimestamp`. Look up the stored public key; cache keys in memory.
- WebSocket: JWT in query, checked on connect and on token expiry (client reconnects with refresh).
- Authorization is centralised in `privacy.ts` + route guards, never ad hoc in handlers.

## 5. Data model (Postgres)
Tables (all with `created_at`, `updated_at`; ids are uuid):
- `events` (name, status, region, retention_days, heartbeat_interval_s, silence_threshold_s, closed_at, purge_at)
- `devices` (public_key unique, sender_hash, push_token, flagged, last_seen_at, last_heartbeat_at, heartbeat_status)
- `responders` (username, password_hash, role, skills text[], available, lat, lng, org)
- `refresh_tokens` (responder_id, token_hash, expires_at, revoked)
- `sos` (id uuidv7 from client, event_id, device_id, sender_hash, channel, category, status, lat, lng, geohash7, approx_lat/lng, text, people_count, score, confidence, silent, silent_since, merged_into, version, last_heard_at, hop_count, max_hops, hop_path text[], gateway_device_id, original_created_at, received_at, has_voice_note, synthetic)
- `sos_reports` (every raw incoming copy incl. duplicates: sos_id, envelope jsonb, hop info) so merges are reversible
- `triage_results` (sos_id, score, confidence, reasons jsonb, extracted jsonb, llm_used, model, scored_at); latest row wins, history kept
- `sos_events` (audit trail / status trail)
- `checkins` (sos_id, channel, sent_at, deadline_at, responded_at, response, attempt, missed)
- `assignments` (sos_id, responder_id, status, eta_at, outcome); **partial unique index** on `sos_id` where status in (assigned, en_route, on_scene) = one active claim per case
- `offers`, `offer_matches`
- `heartbeats` (device_id, event_id, sent_at, received_at, approx, battery, seq, hop info) + `silent_devices` (device_id, status, flagged_at, acknowledged, ...)
- `deadzones` (center, radius, status, detected_at)
- `mesh_outbox` (backend messages: kind, sos_id, body, signed envelope, expires_at)
- `rejections` (reason counters for mesh stats), `voice_notes` (path/blob ref, size, mime)
Indexes: `sos(event_id, status, score desc)`, `sos(geohash7)`, `sos(last_heard_at)`, `devices(heartbeat_status)`, `heartbeats(device_id, received_at desc)`, GIN on `sos` text search (`tsvector`).
Keep an in-memory ring of recent heartbeats if DB load matters; otherwise Postgres is fine at demo scale.

## 6. Core flows

### 6.1 Ingest (`POST /sos`, `/sos/batch`)
1. Auth, rate limit per device (token bucket; anomaly flag when one key makes > N cases/hour).
2. For each envelope: verify signature over the canonical signed part -> check `expires_at` -> `hop_count <= max_hops` and `max_hops`/ttl match the tier table in `hops.ts` -> decrypt `payload` -> validate `MeshPayload`.
3. Idempotency: `INSERT ... ON CONFLICT (id) DO NOTHING`; on conflict only append a `sos_reports` row and merge shorter `hop_path`/lower delay info.
4. Heartbeat envelopes branch to the heartbeat service (no `sos` row).
5. In one transaction: insert `sos` + report + audit event; enqueue triage; create `mesh_outbox` `delivered` message. Respond with per-item results.
6. After commit: run triage (inline for single POST with 3 s budget, otherwise async), then dedupe, then broadcast `sos.created`/`sos.updated`.

### 6.2 Triage (`domain/triage/rules.ts` + `llm/nemotron.ts`)
- **Rules first** (deterministic, always run): trapped + water rising => score floor 90; injured => 80; medical keywords => +; people_count adds; category `safe` => low; silence boosts (section 6.4). Output score, reasons (`source: rule`), tier.
- **Nemotron second**: send free text + structured fields, request strict JSON (`vulnerable[]`, `medical[]`, `hazards[]`, `urgency_delta` clamped to +/-15, short reasons, confidence). Timeout 4 s, one retry, circuit breaker. Rules always bound the result: the LLM can raise or lower within a clamp but never below a rule floor. Failure => `llm_used=false`, confidence downgraded, health shows `degraded`.
- Prompt-injection hygiene: user text goes in a delimited data field, output is schema-validated, never executed or used as instructions.
- Store reasoning so the dashboard can show "Critical: 2 people trapped... Confidence: high".

### 6.3 Dedupe
Candidates: same event, within 150 m (geohash7 neighbours), within 30 min, status not resolved. Score = distance + token-set text similarity + same sender_hash (always merge) + category match. Above threshold => attach as a report to the primary (oldest/highest score), mark the other `merged`, bump `duplicate_count`, broadcast `sos.merged`. Below a lower threshold => leave separate. Manual merge/unmerge endpoints reuse the same code via `sos_reports`.

### 6.4 Silence and heartbeats (`domain/silence.ts`, `jobs/silenceTick`)
Runs every 30 s while an event is active.
- **Check-in silence:** after an SOS, schedule check-ins (`checkin_interval_s`, doubling attempts capped). Missed deadline => `missed=true`, set `silent=true`, add a `silence` reason, raise score (+10 per missed attempt, capped at 100). Priority goes up, never down. Delivery: push token if known, plus a `checkin_request` `BackendMessage` in `mesh_outbox` for offline phones.
- **Heartbeat silence:** per device `now - last_heartbeat_at`. States: active -> quiet (past threshold) -> distress (quiet and neighbours_active >= K in same+adjacent geohash cells, or an open SOS). Create/update `silent_devices`, emit `heartbeat.silent`; resume emits `heartbeat.resumed`. A heartbeat or a check-in reply clears silence. Guard against false alarms: ignore devices that sent a `safe` message or whose battery was <= 3% with charging false (lower, don't drop, priority).
- Closing the event stops this tick.

### 6.5 Dead zones (`jobs/deadzoneTick`, every 60 s)
Grid of ~1 km cells over the event region. A cell is a dead zone when it has no report/check-in/heartbeat for N minutes while >= M adjacent cells have activity (or it historically had devices). Upsert `deadzones`, emit `deadzones.updated`.

### 6.6 Assignments
`POST /assignments` runs `INSERT` relying on the partial unique index; a unique violation => `409` with the current assignment. Status transitions validated by a state machine in the service (`assigned -> en_route -> on_scene -> resolved`, any -> `released|cancelled`). Each transition updates `sos.status`, writes a `sos_event`, queues a victim `status_update` (push + mesh), and broadcasts `assignment.updated`. Releasing returns the case to `reported`.

### 6.7 Offers
On create/move of offers or new SOS in range: match by kind-to-need mapping (boat <- trapped, water <- need_water_meds, medical <- injured), distance <= `radius_km`, capacity. Create `suggested` matches, notify offerer (push + outbox), broadcast `offer.matched`.

### 6.8 Mesh outbox and receipts
`mesh_outbox` rows are signed with the backend key at creation (`crypto/receipts.ts`), have their own `max_hops/expires_at`, and are served by `/mesh/outbox` and piggybacked on batch responses. Mark delivered when the target device next polls `/sos/{id}/status` or acks via later traffic; expired rows are pruned.

### 6.9 Events and purge
One active event at a time. `close` stops detectors and sets `purge_at = closed_at + retention_days`. `purgeTick` (hourly) and `/purge` null out lat/lng/text/voice, delete heartbeats and device links, keep aggregates (counts, hop stats) for the post-mortem. Demo events are `synthetic=true`.

## 7. Privacy enforcement (single choke point)
`privacy.ts` exposes `toSosView(sos, viewer)`. It returns `approx_location` always, and `location` only if the viewer is admin or the active assignee. All routes, WebSocket frames and exports go through it. WebSocket broadcasts are built per connection (not one shared payload) so a frame never leaks exact GPS. Logs never contain text, coordinates or keys. Voice notes: assignee/admin only.

## 8. WebSocket hub
`ws/hub.ts` keeps connections with `{responder, channels}`. Services publish domain events to the hub; the hub redacts per viewer and fans out. Server ping every 30 s, drop dead sockets. `mesh.stats` pushed every 10 s from a cached aggregate. No replay; clients refetch with `updated_since`.

## 9. Demo mode
`DEMO_MODE=true` enables `/mesh/simulate` and `/mesh/seed` (cases with fabricated hop paths and heartbeats, `synthetic=true`) and accelerates timers (e.g. check-in interval 30 s, silence threshold 60 s) so silence and dead zones can be shown live in a 3 minute demo. A seed script can also replay a canned timeline.

## 10. Config (env)
`DATABASE_URL, JWT_SECRET, BACKEND_ENC_PRIVATE_KEY, BACKEND_SIGN_PRIVATE_KEY, NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_MODEL, DEMO_MODE, PORT, PUSH_ENABLED (FCM optional), RETENTION_DEFAULT_DAYS`. Keys generated by `npm run keys`; public halves exposed via `/server-info`.

## 11. Testing
- Domain unit tests (rules, hops, dedupe, silence state machine, privacy redaction) with table-driven cases.
- Crypto interop test with fixtures produced by the Android side (signature + ciphertext) early.
- Contract tests: run Schemathesis or Dredd against the running server using `openapi.yaml`.
- E2E (supertest + a throwaway Postgres): batch upload -> triage -> WS event; claim race (two parallel claims => one 409); heartbeat gap -> distress.

## 12. Build order
1. Skeleton: config, Postgres + migrations, OpenAPI validator, auth, `/health`, `/server-info`, seed responders. Static dashboard mount.
2. `POST /sos` + `/sos/batch` with signature/decrypt/hops, `GET /sos`, WebSocket `sos.created` (dashboard map lights up). **Crypto interop spike runs in parallel.**
3. Rules triage, then Nemotron; dedupe.
4. Assignments + status trail + victim `status_update` via outbox.
5. Check-ins, heartbeats, silence tick, dead zones.
6. Events + purge, offers, mesh stats, demo mode/seed.
7. Hardening: rate limits, anomaly flags, logging, contract tests, backup demo script.

## 13. Risks and calls
- **Crypto compatibility** (Tink HPKE on Android vs Node decrypt) is the top risk. Fallback: agree on ECIES with P-256 ECDH + HKDF + AES-256-GCM, implement both sides with raw primitives, and drop Tink for payloads if needed.
- **Brev/Nemotron latency or downtime:** rules-only fallback is mandatory and tested; never block ingest on the LLM.
- **Clock skew on phones:** trust `received_at` for ordering/silence, `created_at` only for display and expiry sanity (allow +/- 5 min).
- **Heartbeat volume:** devices x interval is small at demo scale; batch inserts and prune old heartbeats beyond the last N per device.
- **False silence alarms** in the demo: use the accelerated timers and the acknowledge/dismiss flow.
