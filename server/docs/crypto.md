# Beacon crypto wire format (Android <-> backend)

Everything here is implemented with raw primitives (`node:crypto` on the server, JCA/BouncyCastle on Android). We deliberately do **not** use
Tink HPKE for payloads (see `docs/server-design.md` section 13): the scheme below is plain ECIES and is easy to match byte for byte.
Reference implementations: `src/crypto/*.ts`, test helper `src/testing/envelope.ts`, fixtures generator `scripts/make-envelope.ts`.

## Keys

| Key | Algorithm | Encoding | Where it lives |
|---|---|---|---|
| Device signing key | ECDSA P-256 (`secp256r1`) | public: base64 **X.509 SubjectPublicKeyInfo DER** (what `PublicKey.getEncoded()` returns) | Android Keystore; public half sent in `POST /devices` |
| Backend encryption key | ECDH P-256 | public: base64 X.509 SPKI DER, served as `encryption_public_key` in `GET /v1/server-info` | `BACKEND_ENC_PRIVATE_KEY` (base64 PKCS#8 DER) |
| Backend signing key | ECDSA P-256 | public: base64 X.509 SPKI DER, served as `signing_public_key` | `BACKEND_SIGN_PRIVATE_KEY` |

`npm run keys` generates both backend key pairs. `encryption_public_key` in `/server-info` is this plain SPKI DER key (the OpenAPI description now says so; it is not a Tink keyset).

## 1. Canonical JSON (what gets signed)

`canonicalJson(value)`:
- objects: keys sorted ascending by UTF-16 code unit (plain string sort), recursively;
- no whitespace anywhere;
- strings, numbers, booleans, null: exactly as ECMAScript `JSON.stringify` (so `1.0` is `1`, `0.00001` is `0.00001`, `1e-7` is `1e-7`; strings use `\"`, `\\`, `\n`, `\uXXXX` for control chars, non-ASCII stays raw UTF-8);
- arrays keep their order; `undefined`/NaN/Infinity are errors.

Number caution: use integers where you can (`max_hops`, `radius_m`) and round coordinates to <= 5 decimals before building `routing`, so Kotlin's
`Double.toString()` (which may print `1.0E-5`) cannot differ from JS. Format numbers yourself to match the JS rule if in doubt.

## 2. Mesh envelope signature

Signed string = `canonicalJson` of exactly this object (the envelope **without** `hop_count`, `hop_path`, `signature`, `sender_public_key`):

```
{ id, sender_key_id, kind, tier, max_hops, expires_at, created_at, routing, payload }
```

- `expires_at`/`created_at` are signed as the exact strings carried in the envelope (the server never reformats them; send RFC 3339 UTC like `2026-11-07T16:12:00.000Z`).
- `routing` is signed as an object (e.g. `{"approx":{"lat":32.995,"lng":-96.745,"radius_m":1000},"category":"trapped"}`).
- `payload` is signed as the **base64 string** (the ciphertext), so sign after encrypting.
- Signature: `SHA256withECDSA` over the UTF-8 bytes, **ASN.1 DER** encoded (Android's `Signature.getInstance("SHA256withECDSA")` output as is), then base64 (standard alphabet, padding).
- `max_hops` and `expires_at` being signed is what stops a relay from resetting limits. `hop_count`/`hop_path` are mutable by relays and are not signed.

`sender_key_id`: the device id (uuid) returned by `POST /devices`. If the phone has never been online, put its own base64 SPKI public key in
`sender_key_id` **or** in `sender_public_key`; the server verifies the signature against it and auto-registers the key on first sight.

## 3. Payload encryption (ECIES)

Plaintext = UTF-8 JSON of `MeshPayload` (see openapi.yaml). Ciphertext = base64 of:

```
offset  size  field
0       1     version = 0x01
1       65    ephemeral public key, X9.62 uncompressed point: 0x04 || X(32) || Y(32)
66      12    GCM nonce (random per message)
78      n     AES-256-GCM ciphertext
78+n    16    GCM authentication tag
```

Derivation (per message, fresh ephemeral key pair on P-256):

1. `shared = ECDH(ephemeralPrivate, backendEncryptionPublic)`: the 32-byte raw X coordinate (JCA `KeyAgreement.getInstance("ECDH")`, `generateSecret()`).
2. `key = HKDF-SHA256(ikm = shared, salt = empty (= 32 zero bytes per RFC 5869), info = ASCII "beacon-ecies-v1", L = 32)`.
3. `AES-256-GCM`, 96-bit nonce, 128-bit tag, **AAD = bytes 0..65 of the wire format** (version byte + ephemeral public key).

Android sketch: `KeyPairGenerator("EC")` with `ECGenParameterSpec("secp256r1")`; take the uncompressed point from `ECPublicKey.w` (left-pad X and Y to 32 bytes);
`KeyAgreement`; HKDF via BouncyCastle `HKDFBytesGenerator(SHA256Digest())` or a small HMAC loop; `Cipher.getInstance("AES/GCM/NoPadding")` with `GCMParameterSpec(128, nonce)` and `updateAAD(...)`.
JCA's GCM output is already `ciphertext || tag`.

## 4. Device-authenticated REST calls

Headers: `X-Device-Id` (uuid), `X-Timestamp`, `X-Device-Signature`.
Signed string (joined with single `\n`, no trailing newline):

```
METHOD            upper case, e.g. POST
PATH              request path as sent, including /v1, excluding the query string, e.g. /v1/sos/batch
SHA256(body)      lower-case hex of the exact request body bytes (empty body = e3b0c442...b855)
X-Timestamp       the header value verbatim
```

`X-Timestamp` may be RFC 3339 UTC (preferred) or epoch seconds/milliseconds; skew beyond 5 minutes gives `401` with `code=expired`. Signature: SHA256withECDSA, DER, base64, with the device key.
Send the body bytes you hashed (do not re-serialise). Failure codes: `unauthorized` (unknown device/missing headers), `bad_signature`, `expired`.

## 5. Server -> phone

`DeliveredReceipt.signature`: ECDSA P-256/SHA-256 (DER, base64) by the backend signing key over `canonicalJson({"id":..., "delivered_at":..., "max_hops":5})` (`hop_count` is mutable and unsigned).
Verify with `signing_public_key`.

`BackendMessage` (`GET /mesh/outbox`, `messages` in batch responses): same key and algorithm. The signed string is `canonicalJson` of exactly

```
{ id, kind, sos_id, checkin_id, body, max_hops, expires_at, created_at }
```

`checkin_id` is always present (`null` when the message is not about a check-in); `body` is signed as served; `expires_at`/`created_at` are the exact strings in the message.
`hop_count` and `hop_path` are not signed (relays mutate them). `max_hops` is 5, TTL 6 h. Reference: `signBackendMessage`/`verifyBackendMessage` in `src/crypto/receipts.ts`.
A phone matches a message to its own case by `sos_id` (or `checkin_id`); `checkin_request` bodies carry `{message, deadline_at}`, `status_update` bodies `{status, eta_minutes, message}`, `delivered` bodies `{status, message}`.

## 6. Per-item batch results

`POST /v1/sos/batch` verifies in this order: sender key resolution -> signature (`bad_signature`) -> idempotency (known id => `duplicate`, even if expired) ->
hop/expiry (`invalid_limits`, `expired`, `hop_limit_exceeded`) -> per-sender rate limit (`rate_limited`) -> decrypt (`undecryptable`) -> payload JSON/schema (`malformed`).
`invalid_limits` means: tier/kind mismatch (`kind=heartbeat` iff `tier=heartbeat`), `max_hops` outside `1..table[tier]` (lower than the table is allowed for the debug "max hops = 2" demo), or `expires_at - created_at` more than the tier TTL (+5 min skew).
Schema-level violations (e.g. `hop_count` above 10, a missing envelope field) fail the whole request with `422` before per-item processing.

Tier table: critical 10 hops / 24 h, high 7 / 12 h, normal 5 / 6 h, safe 3 / 3 h, heartbeat 2 / 30 min.
