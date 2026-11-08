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
                      responders, images, mesh, events, heartbeats, map, system
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
- `responders` (username, password_hash, role, skills text[], available, lat, lng, org, location_updated_at, in_app, last_app_seen_at, available_manual, presence_pinned)
- `refresh_tokens` (responder_id, token_hash, expires_at, revoked)
- `sos` (id uuidv7 from client, event_id, device_id, sender_hash, channel, category, status, lat, lng, geohash7, approx_lat/lng, text, people_count, score, confidence, silent, silent_since, merged_into, version, last_heard_at, hop_count, max_hops, hop_path text[], gateway_device_id, original_created_at, received_at, has_voice_note, synthetic)
- `sos_reports` (every raw incoming copy incl. duplicates: sos_id, envelope jsonb, hop info) so merges are reversible
- `triage_results` (sos_id, score, confidence, reasons jsonb, extracted jsonb, llm_used, model, scored_at); latest row wins, history kept
- `sos_events` (audit trail / status trail)
- `checkins` (sos_id, channel, sent_at, deadline_at, responded_at, response, attempt, missed)
- `assignments` (sos_id, responder_id, status, eta_at, outcome); **partial unique index** on `sos_id` where status in (assigned, en_route, on_scene) = one active claim per case
- `case_images` (id = client uuid, sos_id cascade, device_id cascade, uploaded_by_kind/responder_id, content_type, bytes, width, height, caption, data bytea); index on `sos_id`
- `heartbeats` (device_id, event_id, sent_at, received_at, approx, battery, seq, hop info) + `silent_devices` (device_id, status, flagged_at, acknowledged, ...)
- `deadzones` (center, radius, status, detected_at)
- `mesh_outbox` (backend messages: kind, sos_id, body, signed envelope, expires_at)
- `rejections` (reason counters for mesh stats), `voice_notes` (path/blob ref, size, mime)
- `profiles` (device_id PK/FK cascade, full_name, name_norm, preferred_name, birth_year, vuln_flags[], `enc` bytea, consent_version/accepted_at, profile_version, synthetic); `sos.profile_summary jsonb` (mesh identity hint). See 6.10.
Indexes: `sos(event_id, status, score desc)`, `sos(geohash7)`, `sos(last_heard_at)`, `devices(heartbeat_status)`, `heartbeats(device_id, received_at desc)`, GIN on `sos` text search (`tsvector`).
Keep an in-memory ring of recent heartbeats if DB load matters; otherwise Postgres is fine at demo scale.

## 6. Core flows

### 6.1 Ingest (`POST /sos`, `/sos/batch`)
1. Auth, rate limit per device (token bucket; anomaly flag when one key makes > N cases/hour).
2. For each envelope: verify signature over the canonical signed part -> check `expires_at` -> `hop_count <= max_hops` and `max_hops`/ttl match the tier table in `hops.ts` -> decrypt `payload` -> validate `MeshPayload`.
3. Idempotency: `INSERT ... ON CONFLICT (id) DO NOTHING`; on conflict only append a `sos_reports` row and merge shorter `hop_path`/lower delay info.
4. Heartbeat envelopes branch to the heartbeat service (no `sos` row).
5. In one transaction: insert `sos` (rules score, `triage_status = provisional`) + report + rules `triage_results` row + audit event; create `mesh_outbox` `delivered` message. Respond with per-item results. Nothing here waits for the LLM.
6. After commit: broadcast `sos.created` (rules score), queue the AI triage job (6.2), then dedupe. The AI result arrives later as `sos.updated`.

### 6.2 Triage: rules now, AI later (`domain/triage/rules.ts`, `services/triage.ts`, `services/aiTriage.ts`, `llm/nemotron.ts`)
Every case, whatever its kind or tier (direct POST, mesh batch, `safe`, simulate/seed, promoted silent device), goes through both steps. The user-facing rule: it shows up instantly with a provisional rules score and is updated later from the AI.

**Step 1, rules (synchronous, deterministic).** trapped + water rising => floor 90; injured => 80; medical keywords => +; people_count adds; profile signals (section 6.9) add; category `safe` => low. Output score, `source: rule` reasons, tier. The case is inserted with `triage_status = provisional`, returned in the HTTP response and broadcast as `sos.created`. Nothing in the request path waits for the LLM (there is no inline LLM budget any more).

**Step 2, AI job (asynchronous).** After commit `ctx.aiTriage.enqueue(id)` queues one job per case:
- *Queue.* In-process, bounded concurrency (`AI_TRIAGE_CONCURRENCY`, default 4), one job per case at a time; re-triggers while a job runs coalesce into one follow-up run.
- *Claim.* A job takes its case with one conditional `UPDATE` (`provisional` and due, or `pending` with a stale claim) so two server instances never process the same case; `triage_claimed_at` older than about two LLM timeouts counts as a crashed claim and is taken over. All timestamps come from the database clock.
- *Call.* The LLM gets category, flags, people count, free text and the sanitised `profile_context` (age range, flags, conditions, medications, mobility needs): never name, phone, address or contacts. Strict JSON (`vulnerable[]`, `medical[]`, `hazards[]`, `urgency_delta` clamped to +/-15, reasons, confidence), schema-validated; user text is data, never instructions. Per-job timeout `NEMOTRON_TIMEOUT_MS`. `NemotronClient` keeps its circuit breaker, thinking-disabled `chat_template_kwargs` and `/v1` base-URL normalisation.
- *Success.* `applyLlm` merges the extraction into the rules result: score moves by at most +/-15 and never below the rule floor. Persisted in one transaction (new `triage_results` row with `llm_used=true`, model, reasons, extracted; `sos.score` = AI score + silence/heartbeat/contact/urgent boosts, and not below the highest merged duplicate), `triage_status = complete`, `triage_updated_at`, then `sos.updated` is broadcast (public fields only).
- *Failure* (null, timeout, invalid output): up to `AI_TRIAGE_MAX_ATTEMPTS` (3) attempts, back off `AI_TRIAGE_BACKOFF_MS` (2 s, 8 s, 30 s). While the breaker is open the job waits (`AI_TRIAGE_BREAKER_WAIT_MS`) and no attempt is burned. After the last attempt the case becomes `failed`: rules score stands, `llm_used=false`, confidence one notch down when free text went unanalysed, reason "AI unavailable; scored by rules only", `sos.updated` broadcast.
- *Recovery.* A 30 s sweep (`AI_TRIAGE_SWEEP_S`) and the same pass on boot re-enqueue any `provisional` case that is due and any `pending` case with a stale claim, and give `failed` cases a fresh round every `AI_TRIAGE_FAILED_RETRY_S` (300 s) up to `AI_TRIAGE_FAILED_MAX_SWEEPS` (6) times, so a case scored while Brev was down eventually gets its AI pass. Cases whose pass was requested more than `AI_TRIAGE_MAX_AGE_H` (24 h) ago are left alone.
- *Demo.* With the offline `StubLlm` (no `NEMOTRON_BASE_URL`) the job completes instantly; `AI_TRIAGE_DEMO_DELAY_MS` (default 1500 in `DEMO_MODE`, else 0) adds artificial latency so the provisional -> final transition is visible.

**State machine (`sos.triage_status`).** `provisional` (rules score shown, job queued or backing off) -> `pending` (job running) -> `complete` | back to `provisional` (retry) | `failed`. Any change to the triage inputs sets it back to `provisional` and bumps `triage_gen`: responder edit of text/category/people, profile written/changed/erased for the device, `POST /sos/{id}/retriage` (rules re-run at once, response is the provisional case, the AI result follows via `sos.updated`), and a merge (AI re-run for the primary). A result computed for an older `triage_gen` is discarded and the case goes round again. Heartbeat/check-in/silence boosts only touch `score` and the boost columns, never `triage_status`, and are re-added on every persist.

**Observability.** `GET /health` -> `triage.queue_depth` (cases `provisional`/`pending`) and `triage.oldest_pending_seconds`, next to the LLM `status`/`latency_ms`.

Reasoning is stored so the dashboard can show "Critical: 2 people trapped... Confidence: high".

### 6.3 Dedupe
Candidates: same event, within 150 m (geohash7 neighbours), within 30 min, status not resolved. Score = distance + token-set text similarity + same sender_hash (always merge) + category match. Above threshold => attach as a report to the primary (oldest/highest score), mark the other `merged`, bump `duplicate_count`, broadcast `sos.merged`. Below a lower threshold => leave separate. Manual merge/unmerge endpoints reuse the same code via `sos_reports`.

### 6.4 Liveness: automatic heartbeats + welfare check-ins (`domain/liveness.ts`, `domain/silence.ts`, `services/contact.ts`, `services/checkins.ts`, `services/heartbeats.ts`)
Two layers. **Nobody ever has to press a button to prove the phone is alive.**

**A. Automatic heartbeat (connectivity).** Every installed app heartbeats in the background every `heartbeat_interval_seconds` (default 300 s, exposed in `/server-info` with or without an event): `POST /heartbeats` online, a `heartbeat` mesh envelope offline. Receiving one IS the check-in: `devices.last_heartbeat_at` (+ `last_transport/network/battery/peers_nearby/gateway`) is updated, the device's open cases get `last_heard_at = greatest(.., hb)`, and silence ends. Heartbeats are accepted while an event is active OR the device has an open SOS (attached to the case's event). Optional payload fields: `transport`, `network`, `peers_nearby`, `gateway`, `open_sos_ids[<=20]`.
- *Absence of heartbeats = no connectivity*, not proof of distress. `connectivity = connected` (heard within 2 intervals) | `quiet` (later, under threshold) | `lost_contact` (>= `silence_threshold_seconds`) | `unknown`.
- Device list (`silenceTick`, event devices only): `quiet` (probably no connectivity) / `distress` (neighbours >= K still report, or open SOS; low-battery guard keeps `quiet` unless an SOS is open) rows in `silent_devices`, `heartbeat.silent` / `heartbeat.resumed` (payloads carry `connectivity`). This list never creates or escalates a case: a phone that is merely out of coverage with no SOS only shows as lost contact.
- Case silence (`caseSilenceTick`, any open non-`safe` case of a device, no event or the active event): no contact (heartbeat, SOS, reply) for the threshold => `silent=true`, `silent_since`, reason "Lost contact: no heartbeat for N min (device probably has no connectivity)", audit `silent_flagged {source: silence}`, `sos.silent`. `contact_boost` = +10 at the threshold, +10 per further heartbeat interval, cap +30. Next heartbeat => `silent=false`, audit `contact_restored`, `sos.updated`; the score is never lowered.

**B. Welfare check-ins (a person is asked; only open non-`safe` cases).** Interval since the last answer by tier: critical 10 min, high 15, normal 30 (`CHECKIN_INTERVAL_*_S`; DEMO 20/25/30 s). Each check-in: `choices` `still_here | no_longer_need_help | need_urgent_help`, `deadline_at = sent_at + CHECKIN_WINDOW_S` (5 min). Order: created -> delivery (mesh `checkin_request` BackendMessage with `title/message/choices/deadline_at`; push via `PushProvider` when the device has a `push_token`, failures only logged; REST via `pending_checkins` in the heartbeat 202 and `GET /checkins/pending`) -> `deadline_at` passes -> `checkinTick` marks it `missed` (= overdue); only now `silent=true`. The overdue check-in STAYS the single active one: no new check-in is created while one is unanswered (pending or overdue); the next one is created only after an answer, measured from that answer.
- Reminders: while overdue the SAME check-in (same `checkin_id`) is re-delivered every `CHECKIN_REMINDER_S` (default 300 s, DEMO 20), and every `CHECKIN_REMINDER_SLOW_S` (900 s, DEMO 60) after the 12th reminder: `reminder_count`++, `last_reminded_at` (both in the DB, so restarts are safe; at most one reminder per tick), a new mesh `checkin_request` (new message id, `body.reminder = n`, overdue title; older requests for that id are deleted so the outbox keeps only the newest), push (same collapse key, failures logged), `checkin.sent` WS event, and the check-in appears (`overdue=true`, listed first) in `pending_checkins` and `GET /checkins/pending`. Reminders stop on answer, resolved/closed/merged, `safe`, or event closed. Late answers are accepted.
- Missed + heartbeats still arriving => `unresponsive` (possible incapacitation): `silence_boost` +20 at the deadline; heartbeats also stopped => `lost_contact`: +10; then +5 per further 10 min overdue. Welfare boost cap +30, independent of the heartbeat-gap cap (+30), total clamped to 100, never lowered. `welfare_missed` is 0 or 1 (the active check-in is overdue); `Checkin.attempt` is the number of the check-in in the case's sequence; a heartbeat alone does not clear `unresponsive`, an answer does (`contact_restored`).
- Replies (PATCH `/checkins/{id}` or `checkin_reply` envelope; legacy `ok`=still_here, `need_help`=need_urgent_help, `other`=still_here): `still_here` confirms, restarts the timer; `no_longer_need_help` => case `resolved`, assignment `outcome=self_resolved`, audit `self_resolved`, `assignment.updated` + `sos.updated`, `status_update` "Marked as resolved. Stay safe." (responders may reopen by PATCH status); `need_urgent_help` => +15 (cap +30), reason source `checkin`. Every reply counts as a heartbeat.
- Closed/resolved/merged cases and closed events: pending check-ins are cancelled, none are created. Closing the event stops the device detector and check-ins.
- Config: `HEARTBEAT_INTERVAL_S`, `SILENCE_THRESHOLD_S`, `CHECKIN_INTERVAL_CRITICAL_S/HIGH_S/_S`, `CHECKIN_WINDOW_S`, `CHECKIN_REMINDER_S`, `CHECKIN_REMINDER_SLOW_S` (`CHECKIN_MAX_ATTEMPTS` is unused), `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON` (FCM HTTP v1; without them a logging no-op provider is used and apps still get local notifications from REST/mesh delivery).

### 6.5 Dead zones (`jobs/deadzoneTick`, every 60 s)
Grid of ~1 km cells over the event region. A cell is a dead zone when it has no report/check-in/heartbeat for N minutes while >= M adjacent cells have activity (or it historically had devices). Upsert `deadzones`, emit `deadzones.updated`.

### 6.6 Assignments
`POST /assignments` runs `INSERT` relying on the partial unique index; a unique violation => `409` with the current assignment. Status transitions validated by a state machine in the service (`assigned -> en_route -> on_scene -> resolved`, any -> `released|cancelled`). Each transition updates `sos.status`, writes a `sos_event`, queues a victim `status_update` (push + mesh), and broadcasts `assignment.updated`. Releasing returns the case to `reported`.

### 6.7 Mesh outbox and receipts
`mesh_outbox` rows are signed with the backend key at creation (`crypto/receipts.ts`), have their own `max_hops/expires_at`, and are served by `/mesh/outbox` and piggybacked on batch responses. Mark delivered when the target device next polls `/sos/{id}/status` or acks via later traffic; expired rows are pruned.

### 6.8 Events and purge
One active event at a time. `close` stops detectors and sets `purge_at = closed_at + retention_days`. `purgeTick` (hourly) and `/purge` null out lat/lng/text/voice, delete heartbeats and device links, keep aggregates (counts, hop stats) for the post-mortem. Demo events are `synthetic=true`.

### 6.9 Profiles (victim identity)
- **What:** at install the app syncs name and identifying characteristics (`PUT /devices/{id}/profile`, device signature, full replace, `If-Match` on `profile_version`, mandatory consent whose version must equal `PROFILE_CONSENT_VERSION`). No photo.
- **Storage:** `full_name`, `name_norm`, `preferred_name`, `birth_year` and the derived non-age `vuln_flags` are plain columns on purpose (display, age bucket, exact-name dedupe, coarse flags without decrypting). Everything else is one JSON blob sealed with AES-256-GCM (`crypto/profileCrypto.ts`; key = HKDF-SHA256 of `PROFILE_ENC_KEY` or, when unset, `JWT_SECRET`; device id as AAD). A database dump therefore exposes names and birth years but not medical data, addresses, contacts, phones.
- **Visibility (one choke point, `privacy.ts`):** `toProfileView(profile, viewer, activeAssignee)` returns `ProfileFull` only for the owning device, admins and the ACTIVE assignee of a non-closed case of that device (or of a case merged with one of its cases); everyone else gets `ProfilePublic` (name, preferred name, age bucket, coarse flags). `Sos.profile` is always public-only (built from clear columns, never from `enc`); `SosDetail.profile_full` is added only for admin/assignee. WS `profile.updated` frames are public-only.
- **Mesh:** an offline SOS may carry `profile_summary` in the encrypted payload. Ingest stores it on the case unless a synced profile exists; `PUT` clears it (reconcile). An invalid summary never rejects the SOS.
- **Triage:** `profileScore` adds a modest capped contribution with coarse `Vulnerability: ...` reasons (visible to all). Nemotron gets a sanitised `profile_context` (no identity). Profile writes/erasure re-triage open cases and broadcast `sos.updated` + `profile.updated`.
- **Dedupe:** +0.15 for identical normalised multi-word names across devices (same device is already always merged).
- **Lifecycle:** device delete (cascade); `DELETE /sos/{id}`, event purge and event delete remove profiles whose device has no case left; `purgeTick` deletes profiles with no case, not updated and whose device was not seen for `PROFILE_RETENTION_DAYS` (default 90); purge also clears mesh summaries. Demo seed/simulate create synthetic profiles.
- **Logging:** never. Pino redacts profile keys and no code path logs bodies; a test captures logs and asserts absence.

### 6.10 Case images (`services/images.ts`, `domain/image.ts`)
- **What:** photos of the scene attached by the case's device or by a responder on scene; JPEG/PNG only, 3 MB and 6 per case (`IMAGE_MAX_BYTES`, `IMAGE_MAX_PER_CASE`), rate limited per caller (`IMAGE_UPLOAD_RATE_PER_MIN`). Raw body parsed with `express.raw` on `/sos/:id/images/:imageId` only (the device signature covers the bytes via `rawBody`, as for voice notes).
- **Idempotency:** the client picks the image id; the same id on the same case returns `200` with the stored metadata, on another case `409`. The per-case limit is enforced under a row lock on the case, so parallel uploads cannot exceed it.
- **Validation and sanitising:** the declared type must match the magic bytes; the header is parsed for width/height and the whole segment/chunk structure is walked, so truncated or garbage files get `422`. Metadata is removed before storing (JPEG APP1/APP13/COM, PNG eXIf/tEXt/iTXt/zTXt, trailing bytes), so GPS never leaves the server. The EXIF orientation goes with it: clients bake rotation into the pixels.
- **Visibility:** same rule as exact location and `profile_full`: admin or the ACTIVE assignee (of the case or the primary it was merged into); the owning device sees its own photos. `Sos.image_count` is public, `SosDetail.images` (metadata) only for the entitled. Merged duplicates keep their rows; a primary lists the group's photos for responders, the owning device only its own.
- **Realtime and logs:** `sos.updated` (count only) on add/remove, version bumped so `updated_since` syncs pick it up. No bytes, ids or captions in WS frames or logs (a test captures both).
- **Lifecycle:** cascade on case delete, device delete; event purge deletes them (`purged_images`); `sos.image_hint` is the offline hint from `MeshPayload.image_count`/`has_images`, informational only. Photos never ride the mesh.

### 6.11 Dispatch Agent (`server/src/agent/`)

A Nemotron tool-calling agent that PLANS, gathers evidence from internal data and external services in a multi-step workflow, cross-checks it, assesses the case and PROPOSES a dispatch. A human approves or rejects; the agent has no write tools. It is not a chatbot and not a one-shot classifier: the unit of work is a run with a stored step trace.

```
POST /sos ──► rules score now (provisional) ──► AI extraction job (aiTriage) ──complete/failed──┐
                                                                                                 ▼
 re-run triggers ─────────────────────────────────────────────────────────────► runner.trigger(case)
 (contact_change, urgent check-in,                     skip safe tier, coalesce, throttle 1 per 2 min,
  nearby critical count, new NWS alert,                priority queue, AGENT_CONCURRENCY, conditional-UPDATE claim
  case/profile edit, manual)                                              │
                                                                          ▼
                       loop.ts  (<= AGENT_MAX_STEPS model turns, AGENT_TIMEOUT_MS total)
   system prompt ─► turn 1: plan + PARALLEL tool calls ─► tool results (wrapped, untrusted) ─► turn 2: routing ─► ... ─► submit_assessment
        │                   │ internal: case, nearby, responders, dead zones, event, facilities (2 s)
        │                   │ external (6 s, cached, coarse coords only): NWS, USGS+NWPS, FEMA, OSRM, Nominatim
        ▼                   ▼
   agent.step WS frames    every step stored in agent_runs.steps
                                              │ valid assessment
                                              ▼
        scoring.ts: urgency_delta through the SAME clamp as the extraction (combined +/-15, rule floors) ─► triage_results (+ reason tag `agent`)
        agent_proposals (status proposed, older open ones superseded) ─► agent.updated WS
                                              │
        human: POST .../approve  ─► createAssignment (normal rules) ─► optional victim status_update ─► assignment.created / sos.updated
               POST .../reject
```

**Tools** (zod-validated args, JSON results, `{ok:false,error}` instead of exceptions, TTL cache keyed by coordinates rounded to 3 decimals):

| Tool | Kind | Timeout | Cache | Source |
|---|---|---|---|---|
| `get_case_context` | internal | 2 s | - | case, score and reasons, tier, contact state, check-in state, sanitised profile context (age range, flags, conditions, medications, mobility; never name, phone, address, contacts) |
| `get_nearby_cases` | internal | 2 s | - | open cases within radius (exact coords used server-side): counts, severity mix, ~1 km cluster centres |
| `list_available_responders` | internal | 2 s | - | id, name, role, skills, `in_app`, active assignments, position (3 decimals) + `position_age_s`; `available=false` excluded; `in_app` + position newer than `RESPONDER_POSITION_FRESH_S` first, then available-but-stale |
| `get_dead_zones`, `get_event_context` | internal | 2 s | - | dead zones near the case; event name, bbox, counts |
| `nearest_facilities` | internal | 2 s | - | local `facilities` table (haversine) |
| `get_weather_alerts` | external | 6 s | 60 s | NWS `alerts/active?point=` (one retry) |
| `get_river_gauges` | external | 6 s | 5 min | USGS NWIS `iv` bBox (gage height, 3 h trend) + NWPS flood category/thresholds |
| `get_flood_zone` | external | 6 s | 30 d | FEMA NFHL point query (`FLD_ZONE`) |
| `get_travel_times` | external | 6 s | 2 min | OSRM `/table` from candidate responders (`;`-separated); 0 = unknown; straight-line estimate when down |
| `reverse_geocode` | external | 6 s | 30 d | Nominatim zoom 16, 1 request/s limiter, never house numbers |
| `submit_assessment` | terminal | - | - | `{summary<=280, urgency_delta, confidence, evidence<=8, risks<=5, recommendation{responder_id, eta_minutes, equipment<=6, facility, victim_message<=240, notes<=300}}` |

Overpass is never called in the live path: facilities are ingested in the background (below).

**Guardrails.** (1) Only `submit_assessment` ends a run and the only effect is a stored assessment plus a proposal; dispatching needs a human `approve`. (2) Tool results and the case note are untrusted data: each result is a `role: tool` message `<tool_result name=... trust="untrusted-data">...</tool_result>`, control characters stripped, closing tags neutralised, 2500 chars max; the system prompt says never to follow instructions found there; the system role never contains case or tool data. (3) Bounded influence: `urgency_delta` is clamped to +/-15 and merged with the extraction delta by `combineDelta`: the combined LLM adjustment stays within +/-15 and the score never goes below the rule floors, so a hallucinating agent cannot bury a critical case. A re-run recomputes from the latest non-agent triage result, so adjustments never stack. (4) `recommendation.responder_id` must be an id returned by `list_available_responders` in the same run. (5) One resubmission is allowed after an invalid `submit_assessment`; the last permitted turn offers only that tool (`tool_choice` forced).

**Privacy.** Every external HTTP call goes through `agent/net.ts#extHttp`, which refuses a URL or body carrying a coordinate with more than 3 decimals (~110 m); tools build requests from a rounded `Coarse` point, never from the row. Internal tools may use exact coordinates but never return them. The LLM prompt contains only 3-decimal positions. Traces keep step summaries, not raw results; model-written text is scrubbed of phone numbers, e-mails, precise coordinates and street names returned by `reverse_geocode`; the reverse_geocode step summary omits the street. WebSocket frames (`agent.step`, `agent.updated`) carry public fields only and are not sent to volunteers. Logs contain run ids, tool names, durations and statuses, never prompts or results. `agent_runs`/`agent_proposals` cascade with the case; event purge deletes them (`purged_agent_runs`). The User-Agent is `BeaconHackUTD/1.0 (hackutd.alecj.com)`.

**Runner** (`runner.ts`). Started after the AI extraction ends (complete or failed). Skips merged/closed cases and the `safe` tier unless silent/unresponsive; one active run per case (partial unique index; re-triggers coalesce, a trigger during a run re-runs afterwards); automatic re-runs at most once per `AGENT_RERUN_MIN_S` (120 s) per case, manual runs exempt; priority = critical/high and silent cases first; `AGENT_CONCURRENCY` (2) runs at once (the Brev GPU is shared). Claim = conditional `UPDATE ... WHERE status = 'queued'` (no SKIP LOCKED, same reasoning as aiTriage). A sweep every `AGENT_SWEEP_S` re-queues orphaned queued runs and runs stuck in `running` (3 tries), re-triggers on a changed count of critical neighbours or a changed NWS alert set, and retries recent failed runs. `/health` shows `agent: {status, queue_depth, running}`.

**Facilities** (`facilities.ts`). Creating an event or changing its geofence starts a background job: Overpass QL for hospitals and fire stations in the (3-decimal) bbox, endpoints from `OVERPASS_URLS` with mirror fallback, one retry on 429/504, backoff rounds up to `FACILITIES_MAX_ATTEMPTS`, 24 h in-memory cache per bbox, never blocks the request. On boot an active event without facilities gets its job. With `DEMO_MODE` and Overpass unavailable (or external tools off) a synthetic set is seeded (`source: synthetic_demo`). `GET /events/{id}/facilities`.

**Failure modes.** LLM down or breaker open: runs wait (breaker) or fail with the partial trace; rules score and extraction stand. Tool failure/timeout: error result, the model continues with less evidence and says so. Total timeout / step cap / never submits / invalid twice: run `failed` with trace and reason; the sweep retries critical/high cases later. Overpass flaky: facilities arrive late or are synthetic in demo. Restart: sweep resumes queued and stuck runs. Demo: `AGENT_DEMO_WEATHER=flash_flood` (DEMO_MODE only) injects a recorded flash flood warning and a rising gauge into the weather/river tools, labelled `synthetic: true` in results and steps.

## 7. Privacy enforcement (single choke point)
`privacy.ts` exposes `toSosView(sos, viewer)`. It returns `approx_location` always, and `location` only if the viewer is admin or the active assignee. All routes, WebSocket frames and exports go through it. WebSocket broadcasts are built per connection (not one shared payload) so a frame never leaks exact GPS. Logs never contain text, coordinates or keys. Voice notes: assignee/admin only. Profiles: name + coarse flags for all dashboard users, details only for assignee/admin (6.10).

## 8. WebSocket hub
### Responder presence (011_responder_presence.sql)
Only the mobile app puts a responder "in the field". `PUT /auth/me/presence {state, client=app}`: `online` => `in_app=true`, `last_app_seen_at=now`, `available=true` unless `available_manual=false` (set when the app PATCHes `available=false` while `in_app`, header `X-Beacon-Client: app`; cleared by `available=true` or `offline`); `offline` => `in_app=false, available=false, available_manual=null` (position kept; the app clears sharing with `location:null`). `client=dashboard` changes nothing. Keepalive: the app repeats `online` every 60 s; an app WebSocket (`/v1/ws?client=app`) refreshes `last_app_seen_at` on connect, ping/pong and every 30 s (closing it does not set offline: grace period). Job `presenceTick` (30 s, advisory lock 727015) sets `in_app=false, available=false` for `last_app_seen_at` older than `RESPONDER_PRESENCE_TIMEOUT_S` (180; demo 30). Demo seeding (`POST /mesh/seed|simulate`) sets a pinned mix (alice+dave in app and fresh, bob available but not in app with a 2 h old position, carol offline); `presence_pinned` exempts them from the sweep until real app activity.
`responder.updated` (channel `responders`): full `Responder`, published on position / available / in_app / active-assignment changes, at most one frame per responder per second (coalesced trailing frame reads the latest row), to admin and responder connections only. Responders and admins see exact stored positions; volunteers get no frames and `location: null` for other responders on REST.

`ws/hub.ts` keeps connections with `{responder, channels}`. Services publish domain events to the hub; the hub redacts per viewer and fans out. Server ping every 30 s, drop dead sockets. `mesh.stats` pushed every 10 s from a cached aggregate. No replay; clients refetch with `updated_since`.

## 9. Demo mode
`DEMO_MODE=true` enables `/mesh/simulate` and `/mesh/seed` (cases with fabricated hop paths and heartbeats, `synthetic=true`) and accelerates timers (e.g. check-in interval 30 s, silence threshold 60 s) so silence and dead zones can be shown live in a 3 minute demo. A seed script can also replay a canned timeline.

## 10. Config (env)
`DATABASE_URL, JWT_SECRET, BACKEND_ENC_PRIVATE_KEY, BACKEND_SIGN_PRIVATE_KEY, NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_MODEL, DEMO_MODE, PORT, FCM_PROJECT_ID + FCM_SERVICE_ACCOUNT_JSON (optional push), RETENTION_DEFAULT_DAYS`, and for the dispatch agent `AGENT_ENABLED, AGENT_MAX_STEPS, AGENT_TIMEOUT_MS, AGENT_LLM_TIMEOUT_MS, AGENT_CONCURRENCY, AGENT_THINKING, AGENT_EXTERNAL_TOOLS, AGENT_TOOL_TIMEOUT_EXTERNAL_MS, AGENT_TOOL_TIMEOUT_INTERNAL_MS, AGENT_RERUN_MIN_S, AGENT_SWEEP_S, AGENT_DEMO_WEATHER, OVERPASS_URLS, OVERPASS_TIMEOUT_MS, FACILITIES_MAX_ATTEMPTS, FACILITIES_BACKOFF_MS`. Keys generated by `npm run keys`; public halves exposed via `/server-info`.

## 11. Testing
- Domain unit tests (rules, hops, dedupe, silence state machine, privacy redaction) with table-driven cases.
- Crypto interop test with fixtures produced by the Android side (signature + ciphertext) early.
- Contract tests: run Schemathesis or Dredd against the running server using `openapi.yaml`.
- E2E (supertest + a throwaway Postgres): batch upload -> triage -> WS event; claim race (two parallel claims => one 409); heartbeat gap -> distress.

## 12. Build order
1. Skeleton: config, Postgres + migrations, OpenAPI validator, auth, `/health`, `/server-info`, seed responders. Static dashboard mount.
2. `POST /sos` + `/sos/batch` with signature/decrypt/hops, `GET /sos`, WebSocket `sos.created` (dashboard map lights up). **Crypto interop spike runs in parallel.**
3. Rules triage at ingest, asynchronous Nemotron job queue; dedupe.
4. Assignments + status trail + victim `status_update` via outbox.
5. Check-ins, heartbeats, silence tick, dead zones.
6. Events + purge, mesh stats, demo mode/seed.
7. Hardening: rate limits, anomaly flags, logging, contract tests, backup demo script.

## 13. Risks and calls
- **Crypto compatibility** (Tink HPKE on Android vs Node decrypt) is the top risk. Fallback: agree on ECIES with P-256 ECDH + HKDF + AES-256-GCM, implement both sides with raw primitives, and drop Tink for payloads if needed.
- **Brev/Nemotron latency or downtime:** rules-only fallback is mandatory and tested; ingest and every response are rules-only and never wait for the LLM, the AI pass is an async job with retries and a recovery sweep.
- **Clock skew on phones:** trust `received_at` for ordering/silence, `created_at` only for display and expiry sanity (allow +/- 5 min).
- **Heartbeat volume:** devices x interval is small at demo scale; batch inserts and prune old heartbeats beyond the last N per device.
- **False silence flags** in the demo: use the accelerated timers and the acknowledge/dismiss flow.
