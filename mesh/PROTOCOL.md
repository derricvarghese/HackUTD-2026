# Beacon Mesh Protocol v1 (iOS ⇄ Android over Bluetooth LE)

This is the contract both apps implement. If you change anything here, change
**both** `mesh/ios` and `mesh/android`, and regenerate `mesh/test-vectors`.

## Why raw BLE GATT (not Nearby Connections / Multipeer)

Google Nearby Connections and Apple Multipeer Connectivity do not talk to each
other. The one radio stack that iPhones and Android phones share without
pairing is **Bluetooth Low Energy GATT**, so every phone runs both roles at once:

| Role | What it does |
|------|--------------|
| **Peripheral** (GATT server) | Advertises the Beacon service UUID and accepts writes on the `RX` characteristic. |
| **Central** (GATT client) | Scans for the Beacon service UUID, connects to every peer it finds, and *writes* frames into that peer's `RX`. |

Data always flows **central → peripheral by write-with-response**. Because both
phones scan, each pair ends up with a link in each direction, so either side can
send. Write-with-response gives flow control and an ACK per chunk.

## GATT layout

| Item | UUID | Properties |
|------|------|-----------|
| Service | `B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC` | primary, advertised |
| RX characteristic | `B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC` | write, write-without-response |

Advertisements contain only the 128-bit service UUID (no device name), which
fits in the 31-byte legacy advertising packet on both platforms.

## Transport framing (one GATT write = one chunk)

```
offset size  field
0      1     frameType   0x01 = envelope chunk (0x02 reserved: DELIVERED receipt)
1      4     transferId  u32 big-endian, random per envelope per send
5      2     index       u16 big-endian, 0-based
7      2     count       u16 big-endian, total chunks (1..64)
9      ...   data        slice of the UTF-8 envelope JSON
```

* Chunk data size = `usable write length − 9`. Android: `negotiatedMtu − 3`
  (we request MTU 517). iOS: `maximumWriteValueLength(for: .withoutResponse)`.
  We use the *without-response* length even though we write *with* response,
  so iOS never falls back to prepared ("long") writes that the Android GATT
  server would have to reassemble.
* Receivers reassemble by `(peer, transferId)`, drop partial transfers after
  30 s, and refuse `count > 64` (≈ 11 KB cap).

## Envelope (the reassembled JSON)

```json
{
  "v": 1,
  "signed": "<base64 of the signed header bytes>",
  "sig":    "<base64 DER ECDSA-P256-SHA256 signature over the signed bytes>",
  "hop":    2,
  "path":   ["A1F3", "B7C2"]
}
```

### Signed header (`signed`, base64-decoded → UTF-8 JSON)

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

### Unsigned routing fields

`hop` and `path` must be changed by relays, so they live outside the
signature. A malicious relay could reset `hop` to 0, but:

1. `maxHops` and `expiresAt` are signed, so the limit and the death time can't move.
2. Every phone drops IDs it has already seen.
3. Every phone rejects `hop > maxHops`, `hop < 1`, or `hop != path.length`.

## Hop semantics

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

## Relay algorithm (identical on both platforms)

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

## Gateway upload

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
