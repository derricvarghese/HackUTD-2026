# Beacon mesh protocol v2 (Android over Bluetooth LE, Beacon API contract)

Status: **v2 is the current wire format.** It carries the Beacon API contract (`/openapi.yaml`, crypto details in
`/server/docs/crypto.md`) over BLE. v1 (signed header, plaintext body, `POST /api/mesh/ingest`) is **deprecated**: the server has no
such endpoint and v1 messages cannot be uploaded. v1 is summarised in the appendix only for history. Android implements v2;
iOS still speaks v1 until it follows [`ios/CONTRACT-MIGRATION.md`](ios/CONTRACT-MIGRATION.md), so **Android and iOS do not
interoperate yet**.

Why the wire format moved: the sender's signature has to verify at the server, and a gateway cannot re-sign for someone else, so the
phone that creates a message must create it in the contract's `MeshEnvelope` format already.

## Transport (unchanged from v1)

Raw BLE GATT, every phone is peripheral and central at once.

| Item | UUID | Properties |
|------|------|-----------|
| Service | `B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC` | primary, advertised |
| RX characteristic | `B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC` | write, write-without-response |
| ID characteristic | `B5A10003-7E4C-4C3A-9D2F-6B8E1C0FBEAC` | read |

Data flows central to peripheral by write-with-response. One GATT write = one chunk:

```
offset size  field
0      1     frameType   0x01 = data chunk, 0x02 = HELLO (see "BLE identity")
1      4     transferId  u32 big-endian, random per message per send
5      2     index       u16 big-endian, 0-based
7      2     count       u16 big-endian, total chunks (1..64)
9      ...   data        slice of the UTF-8 JSON
```

Chunk data size = `min(negotiated MTU - 3, 512) - 9` (an ATT value is at most 512 bytes; Android requests MTU 517). Receivers reassemble by
`(peer, transferId)`, drop partials after 30 s and refuse `count > 64`. **Size check for v2:** an envelope is about 1.3 KB for a typical SOS
and at most about 2.8 KB (280 character note of 2-byte characters, 10 hops); at 503 byte chunks that is 3 to 6 frames, at the iOS
typical 173 bytes 8 to 17 frames, and 64 frames still carry the largest envelope down to a 100 byte write (MTU 103). `MAX_CHUNKS = 64`
therefore stays; no change is needed on either side. A send that does not fit is skipped and logged, never fatal.

The reassembled JSON is one of three objects, told apart by a field: `sender_key_id` = `MeshEnvelope`, `delivered_at` = `DeliveredReceipt`,
`sos_id` = `BackendMessage`.

## BLE identity

BLE addresses rotate and one phone shows up under several (central and peripheral side), which used to create "ghost peers". Every app
install therefore has a persistent random **instance UUID**, and peers are identified by it, never by address.

* **ID characteristic** `B5A10003-7E4C-4C3A-9D2F-6B8E1C0FBEAC` on the GATT server, read-only. Value: the instance UUID as **16 raw bytes,
  big-endian** (the same byte order as the canonical UUID text, no dashes). The central reads it right after service discovery.
* **HELLO frame**: after the link is accepted the central writes one frame to `RX`: `0x02` followed by its own 16 instance UUID bytes (17 bytes
  total, not chunked). It lets the peripheral side attribute inbound writes (which only show a BLE address) to the same phone id.
* **One link per id**: the first outbound link that identifies as a given id is kept; any later link that identifies as an already-linked id
  is dropped as a duplicate (cool-down 60 s before reconnecting to that address). A link whose id equals our own is dropped as "self"
  (cool-down 120 s). Dropped addresses are otherwise retried after 5 s.
* Peers without the ID characteristic (old builds) are identified as `addr:<mac>`; inbound writers that never said hello as `in:<mac>`.
* The router only sees these peer strings (it never forwards a message back to the peer it came from). The instance UUID is **not** the
  relay id in `hop_path` and is never sent in an envelope.

## `MeshEnvelope` (kinds `sos`, `checkin_reply`, `safe`, `offer`, `heartbeat`)

Exactly the contract schema, JSON, UTF-8:

```json
{
  "id": "0192a7d4-1c2e-7000-8a00-0000000000a1",
  "sender_key_id": "<device id from POST /v1/devices, else the base64 SPKI public key>",
  "sender_public_key": "<base64 SPKI DER of the sender's P-256 key>",
  "kind": "sos", "tier": "critical", "max_hops": 10, "hop_count": 0, "hop_path": [],
  "expires_at": "2026-11-08T16:00:00.000Z", "created_at": "2026-11-07T16:00:00.000Z",
  "routing": { "approx": { "lat": 32.985, "lng": -96.755, "radius_m": 1000 }, "category": "trapped" },
  "payload": "<base64 ECIES ciphertext of the MeshPayload JSON>",
  "signature": "<base64 DER ECDSA P-256/SHA-256>"
}
```

* `id` is a UUIDv7 (RFC 9562). Times are RFC 3339 UTC with milliseconds; they are signed **as the exact strings carried**, never reformatted.
* `routing.approx` is the centre of a 0.01 degree (about 1 km) grid cell: `floor(x * 100) / 100 + 0.005`, rounded to 5 decimals, `radius_m` 1000.
  `routing.category` is the contract `Category` (`trapped`, `injured`, `need_water_meds`, `safe`, `other`); heartbeats omit it.
* `sender_public_key` is **always included by Android**, although the contract only requires it for unregistered devices: relays do not know the
  device-id to key mapping and need the key to verify the signature. The server ignores it for registered devices (it uses the registered key).
  An unregistered device also puts its public key in `sender_key_id`; the server auto-registers it on first sight.
* App categories map to the contract: `trapped`, `injured` as is; `medical` is sent as `injured`; `water_meds` as `need_water_meds` (tier high);
  `safe` is `kind=safe`, tier safe; the un-prompted "check-in" and `other` are `kind=sos`, tier normal, category `other`.
  A `checkin_reply` (tier normal) answers a backend check-in. `offer` is parsed and relayed but Android does not create it yet.

### Plaintext `MeshPayload` (inside the ciphertext, never visible to relays)

`{lat, lng, accuracy_m?, category, text? (<= 280 chars in the UI, 1000 server), people_count?, trapped?, water_rising?, injured?}`;
`checkin_reply`: `{checkin_id, response: ok|need_help|other, text?}`; `heartbeat`: `{heartbeat: {sent_at, approx{lat,lng,radius_m}, battery_pct?, charging?, moving?, seq?}}`.
`lat`/`lng` are required for `sos`, so a phone with no location fix refuses to create an SOS (clear error) instead of sending a bogus place.

## Signing

Signed string = canonical JSON (below) of exactly `{id, sender_key_id, kind, tier, max_hops, expires_at, created_at, routing, payload}`.
`sender_public_key`, `hop_count`, `hop_path` and `signature` are not signed (relays change the hop fields). `payload` is signed as the base64
**string**, so sign after encrypting. Algorithm: ECDSA P-256, SHA-256, **ASN.1 DER** signature, standard base64 with padding (Android Keystore
`SHA256withECDSA` output as is; on iOS convert CryptoKit's raw r||s to DER).

**Canonical JSON** (server/src/crypto/canonical.ts): object keys sorted by UTF-16 code unit, recursively; no whitespace; strings escaped like
ECMAScript `JSON.stringify` (`\"`, `\\`, `\b \f \n \r \t`, other control characters as `\u00xx` lower-case hex, everything else raw UTF-8);
numbers printed like ECMAScript `Number#toString` (`1.0` is `1`, `0.00001`, `1e-7`, `1e+21`); arrays keep order; `null` is `null`.
Use integers where possible and round coordinates to 5 decimals before building `routing`.

## Encryption (ECIES, server/docs/crypto.md section 3)

Encrypt the UTF-8 `MeshPayload` JSON to the backend encryption key (base64 X.509 SPKI DER of a P-256 key):

```
wire = 0x01 || ephemeral public key (65 B, 0x04||X||Y) || nonce (12 B random) || AES-256-GCM ciphertext || tag (16 B)
shared = ECDH(ephemeralPrivate, backendPublic)            // 32-byte x coordinate
key    = HKDF-SHA256(ikm = shared, salt = empty (32 zero bytes), info = ASCII "beacon-ecies-v1", L = 32)
AAD    = wire[0..65]                                       // version byte + ephemeral public key
```

Fresh ephemeral key pair and nonce per message. There is no plaintext fallback: with no backend key a phone creates nothing.

### Where the backend keys come from

1. `GET /v1/server-info` (`encryption_public_key`, `signing_public_key`), cached in SharedPreferences whenever the phone is online (at startup,
   when it gains internet, every 5 min while a gateway).
2. Build-time fallback `BuildConfig.BACKEND_ENC_PUBLIC_KEY` / `BACKEND_SIGN_PUBLIC_KEY` (`-Pbeacon.encPublicKey=...`, `-Pbeacon.signPublicKey=...`,
   public halves only, default empty) for phones that were never online. The cached key wins over the baked one. Keys that do not parse as P-256 SPKI are ignored.

## Hop rules

| Tier | Kinds | max_hops | TTL |
|---|---|---|---|
| critical | sos (trapped, injured) | 10 | 24 h |
| high | sos (need_water_meds) | 7 | 12 h |
| normal | sos (other), checkin_reply | 5 | 6 h |
| safe | safe | 3 | 3 h |
| heartbeat | heartbeat | 2 | 30 min |

`/server-info.hop_limits` overrides this table once cached. `max_hops` and `expires_at` are signed. The demo hop cap (Settings, Debug) lowers
`max_hops` for non-critical, non-heartbeat messages at creation (never raises it; the server accepts any `1..table`).

`hop_count` = radio transmissions so far. A transmitter (origin included) sets `hop_count + 1` and appends its relay id **before** sending, so a
received envelope has `hop_count == hop_path.length`. Relay id = first 2 bytes of SHA-256(own SPKI DER) as 4 upper-case hex characters.

Relay algorithm (a relay cannot read the payload; it checks routing fields and the sender signature):

```
onEnvelope(env, fromPeer):
    drop if store has env.id                                   // dedupe
    drop if malformed, unknown tier/kind, (kind == heartbeat) != (tier == heartbeat)
    drop if max_hops not in 1..10 or expires_at - created_at > 24 h (+5 min) or created_at > now + 10 min
    key = sender_public_key, else sender_key_id when it is not a uuid, else a device key learned earlier
    drop if key exists and signature does not verify           // no key: keep and relay, mark unverified, the server checks
    drop if now > expires_at
    drop if hop_count < 1 or hop_count > max_hops or hop_count != hop_path.length
    store
    if gatewayOnline: upload; return                           // gateways upload instead of relaying
    if hop_count < max_hops: send (hop_count+1, path + myRelayId) to every peer except fromPeer
onPeerConnected(peer): send every stored, unexpired message with hop_count < max_hops (backend messages first, then by tier)
onInternetAvailable(): upload everything held that is not yet uploaded or terminally rejected
```

## Backend to phone: `BackendMessage` and `DeliveredReceipt`

`BackendMessage` (`delivered`, `checkin_request`, `status_update`) is signed by the backend: ECDSA P-256/SHA-256 DER base64 over the canonical JSON of
`{id, kind, sos_id, checkin_id (null when absent), body, max_hops, expires_at, created_at}`. `DeliveredReceipt` signs `{id, delivered_at, max_hops: 5}`.
`max_hops` is 5, TTL 6 h (receipts: 6 h from first sight). Gateways take them from `GET /v1/mesh/outbox?since=` (every 30 s) and from the
`receipts` / `messages` of `POST /v1/sos/batch`, and broadcast them as hop 1. Every phone relays them with the same hop and expiry rules
(also gateways: this is downlink traffic) and dedupes by id (`bm:<id>`, `rcpt:<id>`).

A phone **acts** on an item only after verifying the backend signature with the cached or baked `signing_public_key`; a relay without the key
forwards but does not act, and acts later when the key arrives. It acts only when `sos_id` (or the receipt `id`) is one of its own messages:
`delivered` shows "Reached responders"; `status_update` shows status plus ETA text; `checkin_request` (needs `checkin_id`) shows an "I'm OK /
I need help" prompt. The answer is `PATCH /v1/checkins/{id}` when online, else a `checkin_reply` envelope (tier normal). Older updates
(`created_at` before the current one) are ignored.

## Gateway and online behaviour

* `POST /v1/devices {public_key, platform:"android", app_version}` once when online (idempotent), the returned id is stored; registration is retried
  on every authenticated call, and redone once on `401 unauthorized`.
* Authenticated calls carry `X-Device-Id`, `X-Timestamp` (RFC 3339 UTC) and `X-Device-Signature` = base64 DER ECDSA over
  `METHOD \n PATH \n lowercase-hex SHA-256(body bytes) \n X-Timestamp` (path as sent including `/v1`, no query string; empty body hashes to `e3b0c442...b855`).
* `POST /v1/sos/batch` with at most `gateway_upload_max_batch` envelopes (default 500, from `/server-info`). Per item: `created` / `duplicate` mean
  uploaded; `rejected` with `bad_signature`, `expired`, `hop_limit_exceeded`, `invalid_limits`, `undecryptable`, `malformed` is final (stored with the
  reason, never retried); `rate_limited` is retried. `429` honours `Retry-After`.
* A phone that is online and the original sender sends once via `POST /v1/sos` (`channel: app`, plaintext inside TLS, as the contract defines it) and
  falls back to the mesh batch if that fails. It polls `GET /v1/sos/{id}/status` for real status (assigned, en route, ETA).

## Heartbeats

While `/server-info.event` is non-null (last known value kept offline) the foreground service ticks every 30 s and sends a heartbeat every
`heartbeat_interval_seconds` (default 300): `POST /v1/heartbeats` when online, otherwise a `kind=heartbeat`, tier heartbeat envelope (2 hops, 30 min).
Content: `sent_at`, `approx` (1 km grid), `battery_pct`, `charging`, `moving`, `seq`. Only the last known location is used (no GPS spin-up); with no fix
nothing is sent. `404` from `/heartbeats` means the event ended and stops heartbeats until `/server-info` says otherwise.

## Test vectors

`mesh/test-vectors/contract_v1/server_envelope.json` (made by `server/scripts/make-contract-fixtures.ts`: envelope signed and encrypted by the server helper,
backend keys incl. TEST private halves, backend message, check-in request, receipt, request-signature vector, canonical JSON cases) and
`android_envelope.json` (created by the Android router, ingested by `server/test/e2e/android-interop.test.ts`).

## Appendix: v1 (DEPRECATED, do not implement)

v1 used `{v, signed, sig, hop, path}` with a plaintext `body` and uploaded to `POST /api/mesh/ingest`. It is kept below for history only.

### Envelope (the reassembled JSON)

```json
{
  "v": 1,
  "signed": "<base64 of the signed header bytes>",
  "sig":    "<base64 DER ECDSA-P256-SHA256 signature over the signed bytes>",
  "hop":    2,
  "path":   ["A1F3", "B7C2"]
}
```

#### Signed header (`signed`, base64-decoded → UTF-8 JSON)

The sender serialises this JSON **once**, signs those exact bytes, and the bytes
travel verbatim as base64. Nobody re-serialises them, so there is no
canonicalisation problem between Swift's `JSONEncoder` and Android's `org.json`.

```json
{
  "v": 1,
  "id": "6f1c…uuid-lowercase",
  "pub": "<base64 SPKI DER of the sender's P-256 public key>",
  "kind": "sos",
  "pri": "critical",
  "maxHops": 10,
  "createdAt": 1762500000000,
  "expiresAt": 1762586400000,
  "body": { "category": "trapped", "text": "2 people, water rising",
            "lat": 32.98, "lng": -96.75, "acc": 12.0, "people": 2 }
}
```

* `kind`: `sos` | `checkin` | `safe`
* `pri`: `critical` | `high` | `normal` | `safe`
* `category`: `trapped` | `injured` | `medical` | `water_meds` | `checkin` | `safe` | `other`
* `body` is plaintext in v1. Encrypting it to the backend key will replace it
  with `"enc": "<base64>"` while the routing fields stay readable.
* Unknown keys must be ignored. Times are Unix epoch **milliseconds**.

#### Unsigned routing fields

`hop` and `path` must be changed by relays, so they live outside the
signature. A malicious relay could reset `hop` to 0, but:

1. `maxHops` and `expiresAt` are signed, so the limit and the death time can't move.
2. Every phone drops IDs it has already seen.
3. Every phone rejects `hop > maxHops`, `hop < 1`, or `hop != path.length`.

### Hop semantics

`hop` = number of radio transmissions the envelope has taken.
`path` = relay ID of each transmitter, in order (origin first), so `hop == path.length`.

A transmitter (origin included) sets `hop = hop + 1` and appends its own relay
ID **before** sending. Relay ID = first 2 bytes of `SHA-256(own SPKI DER)` as
4 uppercase hex chars: stable, anonymous, and computed the same on both platforms.

| Priority | Categories | Max hops | Expires after |
|----------|-----------|----------|---------------|
| critical | trapped, injured, medical | 10 | 24 h |
| high     | water_meds | 7 | 12 h |
| normal   | checkin, other | 5 | 6 h |
| safe     | safe | 3 | 3 h |

Hard validation limits (reject outright): `maxHops > 10`, `maxHops < 1`,
`expiresAt − createdAt > 24 h`, `createdAt > now + 10 min`.

**Demo hop cap**: a debug setting replaces `maxHops` for every *non-critical*
message at creation time (it's signed, so it sticks). With cap = 2 and 4 phones
in a line A–B–C–D, a `normal` SOS goes A→B (hop 1), B→C (hop 2), and C stores
it but does not forward. A `critical` SOS keeps its 10 hops and reaches D.

### Relay algorithm (identical on both platforms)

```
onEnvelope(env, fromPeer):
    header = parse(base64decode(env.signed))            else drop
    if store.contains(header.id)                         drop   // seen
    if !verify(header.pub, env.signed, env.sig)          drop
    if now > header.expiresAt                            drop
    if env.hop < 1 or env.hop > header.maxHops
       or env.hop != env.path.size                       drop
    if header violates hard limits                       drop
    store.save(env)                                             // always keep a copy
    if gatewayOnline: upload(env); return                       // gateway: upload, stop relaying
    if env.hop < header.maxHops:
        fwd = env with hop+1, path + myRelayId
        send fwd to every connected peer except fromPeer

onPeerConnected(peer):                                          // store-and-forward
    for each stored env not expired and hop < maxHops:
        send forwarded copy to peer

onInternetAvailable():
    upload every stored env not yet uploaded
```

Echoes back to the sender (for example, when the two directional links of a
pair aren't recognised as the same peer) are harmless: the seen-ID check drops them.

### Gateway upload

`POST {backendUrl}/api/mesh/ingest`, `Content-Type: application/json`:

```json
{ "envelope": { "v": 1, "signed": "…", "sig": "…", "hop": 2, "path": ["A1F3","B7C2"] },
  "gateway": "C3D4", "receivedAt": 1762500100000 }
```

The backend must base64-decode `signed`, verify `sig` with `pub`
(ECDSA P-256 / SHA-256, DER signature, SPKI public key), dedupe by `id`, and
check `hop == path.length <= maxHops`. Any 2xx response marks the message
uploaded. Dashboard text: "Arrived via `hop` hops: `path[0]` → … → `gateway` (gateway)".

`mesh/test-vectors/envelope_v1.json` contains a real signed envelope that both
platforms' unit tests verify, so the backend can use it too.
