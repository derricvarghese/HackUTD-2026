# iOS migration to the Beacon API contract (PROTOCOL v2)

Android now speaks the contract's `MeshEnvelope` over BLE ([`../PROTOCOL.md`](../PROTOCOL.md) v2). The iOS app still speaks the deprecated v1
(`{v, signed, sig, hop, path}`, plaintext body, `POST /api/mesh/ingest`), so **the two do not interoperate until iOS does everything below**.
No Swift code was changed. The server accepts only v2 (`POST /v1/sos/batch`).

## 1. Replace the envelope (field mapping)

| v1 (`signed` header / outer) | v2 `MeshEnvelope` field |
|---|---|
| `signed.id` (uuid, random) | `id`: **UUIDv7** (RFC 9562: 48-bit unix ms, version 7, variant 10) |
| `signed.pub` | `sender_public_key` (always include it) and, if the phone has no device id, also `sender_key_id` |
| (none) | `sender_key_id`: device id from `POST /v1/devices`, else the base64 SPKI key |
| `signed.kind` sos / checkin / safe | `kind`: `sos` / `checkin_reply` / `safe` / `offer` / `heartbeat`. Unprompted check-in becomes `kind=sos`, tier `normal`, category `other` |
| `signed.pri` | `tier`: critical / high / normal / safe / **heartbeat** (new) |
| `signed.maxHops` | `max_hops` |
| `hop` (outer) | `hop_count` |
| `path` (outer) | `hop_path` |
| `signed.expiresAt` (epoch ms) | `expires_at`: RFC 3339 UTC string, `2026-11-07T16:00:00.000Z` |
| `signed.createdAt` (epoch ms) | `created_at`: same format |
| `signed.body.category` | `routing.category`: contract `Category`: `trapped`, `injured`, `need_water_meds`, `safe`, `other` (`medical` -> `injured`, `water_meds` -> `need_water_meds`) |
| `signed.body.lat/lng` | inside the encrypted payload; `routing.approx` carries only the 1 km cell centre |
| `signed.body.text/people/acc` | encrypted payload `text`, `people_count`, `accuracy_m` |
| `sig` | `signature` |
| `v` | removed (no version field) |

`routing.approx` = `{lat: floor(lat*100)/100 + 0.005, lng: same, radius_m: 1000}`, each rounded to 5 decimals (so the JSON number is short and identical in every language).

Tier / hop table (same as v1 plus heartbeat, and `/v1/server-info.hop_limits` overrides it): critical 10 hops / 24 h, high 7 / 12 h, normal 5 / 6 h, safe 3 / 3 h, heartbeat 2 / 30 min.
Server rules: `kind=heartbeat` iff `tier=heartbeat`; `max_hops` in `1..table`; `expires_at - created_at <= TTL + 5 min`.
Hop semantics are unchanged: the transmitter (origin included) increments `hop_count` and appends its 4-hex relay id before sending; `hop_count == hop_path.length` on receipt.

Plaintext payload (`MeshPayload`): `{lat, lng, accuracy_m?, category, text?, people_count?, trapped?, water_rising?, injured?}` (UTF-8 JSON, any key order).
Heartbeat: `{heartbeat: {sent_at, approx{lat,lng,radius_m}, battery_pct?, charging?, moving?, seq?}}`. Check-in reply: `{checkin_id, response: "ok"|"need_help"|"other", text?}`.
`lat`/`lng` are required for `sos`; do not send an SOS without a location.

## 2. Canonical JSON and the signature

Signed string = canonical JSON of exactly `{id, sender_key_id, kind, tier, max_hops, expires_at, created_at, routing, payload}`
(not `hop_count`, `hop_path`, `sender_public_key`, `signature`). `payload` is the base64 **string** (sign after encrypting). `expires_at`/`created_at` are signed as the exact strings sent.

Canonical JSON rules (implement your own writer, do not rely on `JSONEncoder`):
* object keys sorted by UTF-16 code unit (Swift: compare `Array(key.utf16)`, not `String <`), recursively;
* no whitespace anywhere;
* strings escaped like ECMAScript `JSON.stringify`: `\"` `\\` `\b` `\f` `\n` `\r` `\t`, other characters below U+0020 as `\u00xx` (lower-case hex), **everything else raw UTF-8** (no `\/`, no `\uXXXX` for non-ASCII);
* numbers printed like ECMAScript `Number#toString`: integers without `.0`, `0.00001`, `1e-7`, `1e+21`; never `1.0E-5`;
* `true`/`false`/`null` as is, arrays keep order.

Signature: ECDSA P-256 / SHA-256 over the UTF-8 bytes, **ASN.1 DER** encoded (CryptoKit: `signature.derRepresentation`, not `rawRepresentation`), standard base64 with padding.
Public key: base64 X.509 SPKI DER (CryptoKit `derRepresentation` of `P256.Signing.PublicKey` is exactly that).

## 3. Payload encryption (ECIES)

Recipient = backend encryption key (`encryption_public_key` from `GET /v1/server-info`, base64 SPKI P-256, or a baked-in build setting).

1. Fresh ephemeral P-256 key pair per message.
2. `shared` = ECDH(ephemeral private, backend public), the raw 32-byte x coordinate (CryptoKit `sharedSecretFromKeyAgreement`, use its raw bytes: `withUnsafeBytes`).
3. `key = HKDF-SHA256(ikm = shared, salt = empty, info = ASCII "beacon-ecies-v1", L = 32)` (CryptoKit `hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data("beacon-ecies-v1".utf8), outputByteCount: 32)`; empty salt = 32 zero bytes per RFC 5869).
4. Random 12-byte nonce. AES-256-GCM, 128-bit tag, **AAD = `0x01 || ephemeral public key (65 bytes, 0x04||X||Y = x963Representation)`**.
5. `payload` = base64( `0x01 || ephemeralPublic(65) || nonce(12) || ciphertext || tag(16)` ), i.e. `AES.GCM.SealedBox.ciphertext + tag` (not CryptoKit's `combined`, which is nonce-first).

If there is no backend key (never online and none baked in), do not create the message and tell the user. Never fall back to plaintext.

## 4. Other messages and endpoints

* `BackendMessage` / `DeliveredReceipt` objects arrive as separate top-level JSON objects (told apart by `sos_id` / `delivered_at` / `sender_key_id`); relay them (max_hops 5, same hop rules, dedupe by `bm:<id>` / `rcpt:<id>`), and act only after verifying the backend signature (`signing_public_key`; canonical JSON of `{id, kind, sos_id, checkin_id|null, body, max_hops, expires_at, created_at}`; receipts `{id, delivered_at, max_hops: 5}`).
* Gateway: `POST /v1/devices`, signed requests (`X-Device-Id`, `X-Timestamp` RFC 3339, `X-Device-Signature` over `METHOD\nPATH\nhex(SHA256(body))\nX-Timestamp`, DER, base64), `POST /v1/sos/batch` (<= `gateway_upload_max_batch`), per-item results, `GET /v1/mesh/outbox`, `GET /v1/server-info`, `GET /v1/sos/{id}/status`, `PATCH /v1/checkins/{id}`, `POST /v1/heartbeats`. See PROTOCOL.md.
* Heartbeats while `server-info.event != null`, every `heartbeat_interval_seconds`.
* Relays verify with `sender_public_key` (or a key-as-`sender_key_id`); if neither is present they relay the message unverified.
* Remove `POST /api/mesh/ingest` and the v1 envelope.

## 5. BLE identity (new on Android, required for clean peer handling)

* New read-only characteristic `B5A10003-7E4C-4C3A-9D2F-6B8E1C0FBEAC` on the Beacon service. Value: the phone's persistent **instance UUID as 16 raw big-endian bytes** (generate once, store in UserDefaults/Keychain).
* After connecting and discovering services, read it, and identify the peer by that UUID instead of the CoreBluetooth peripheral identifier / address.
* **HELLO frame**: once the link is accepted, write to `RX` one 17-byte frame: `0x02` + your own 16 instance UUID bytes (not chunked; type `0x01` stays the data chunk). Android uses it to attribute inbound writes to a phone id.
* **One link per id**: keep the first link that identifies as an id; drop later links with the same id (cool-down 60 s before reconnecting to that peripheral). Drop a link whose id equals your own (cool-down 120 s). Other failed links retry after about 5 s.
* Peers that do not expose the characteristic are treated as `addr:<id>`; inbound writers without a HELLO as `in:<id>`.
* Frame type `0x02` therefore means HELLO, no longer "reserved for DELIVERED receipt". Framing otherwise unchanged (9-byte header, `MAX_CHUNKS = 64`; the largest v2 envelope is about 2.8 KB and fits).

## 6. Test fixtures to use

`mesh/test-vectors/contract_v1/server_envelope.json` (generated by the server's own helpers, test keys included):
* `envelope` + `envelope_signed_part`: build the same canonical string and verify `envelope.signature` with `envelope.sender_public_key`; byte-for-byte equal.
* `envelope.payload` + `backend.encryption_private_key_pkcs8`: decrypt and compare with `expected_payload`.
* `backend_message`, `backend_message_checkin`, `delivered_receipt` + `backend.signing_public_key`: verify.
* `request_signature`: rebuild `signed_string` and verify `signature` with `device.public_key`.
* `canonical_json_cases`: `input_json` parsed and re-serialised must equal `output` exactly.
* `android_envelope.json`: four envelopes made by Android; they must verify (use `requireHop=false` for the unsigned hop fields) and decrypt with the same private key.
Server side check: `cd server && npm test` (`test/e2e/android-interop.test.ts` ingests the Android envelopes). Regenerate the server fixture: `cd server && npx tsx scripts/make-contract-fixtures.ts ../mesh/test-vectors/contract_v1/server_envelope.json`.

## 7. Profile (identity) on iOS

Implemented against openapi `Profiles` + `ServerInfo.profile_required/profile_consent_version` + `MeshPayload.profile_summary`:
`Profile.swift` (model, validation, flag/age derivation, `ProfileInput` JSON, summary), `ProfileSync.swift` (record + sync state machine: `PUT` with `If-Match`/`ETag`, 409 merge, 422 re-consent, 404/older server copy re-`PUT`, `DELETE`, reinstall adoption), `ProfileKeychainStore.swift` (one Keychain item, `AfterFirstUnlockThisDeviceOnly`), `BackendClient` profile calls, `GatewaySync.profileSync` (runs inside the online cycle), SwiftUI in `BeaconMeshUI/ProfileViews.swift`.
The first SOS in `test-vectors/contract_v1_ios/ios_envelope.json` carries a `profile_summary`; the server's `summarySchema` accepts it (checked with the server's own `verifyEcdsa`/`eciesDecrypt`/`parseSummary` helpers). Profile content is never logged.
