# Beacon Mesh: offline SOS relay for iPhone and Android over Bluetooth LE

Phones in airplane mode (Bluetooth on) pass signed SOS messages hand to hand until one
of them has internet. That phone becomes the gateway and uploads everything it holds.
iPhones and Android phones relay for each other.

```
[iPhone A] --BLE--> [Android B] --BLE--> [iPhone C: has Wi-Fi = gateway] --HTTPS--> backend
   hop 1                hop 2                 POST /api/mesh/ingest
```

* **Wire protocol**: [`PROTOCOL.md`](PROTOCOL.md). Read this first; both apps implement it exactly.
* **iOS**: [`ios/BeaconMesh`](ios/BeaconMesh), a Swift package (CoreBluetooth + CryptoKit, no dependencies).
* **Android**: [`android`](android), a Kotlin app module (platform BLE + AndroidKeyStore + SQLite, no dependencies).
* **Shared test vector**: [`test-vectors/envelope_v1.json`](test-vectors/envelope_v1.json), an envelope
  signed on iOS that the Android tests (and the backend) must verify.

## Why not Nearby Connections?

Nearby Connections (Android) and Multipeer Connectivity (iOS) can't talk to each other.
Plain BLE GATT is the one thing both platforms speak without pairing, so every phone is
both a GATT **peripheral** (advertises the Beacon service and accepts writes) and a
**central** (scans, connects and writes). See PROTOCOL.md for the reasoning.

## Hop limits

| Priority | Categories | Max hops | Expires |
|---|---|---|---|
| critical | trapped, injured, medical | 10 | 24 h |
| high | water_meds | 7 | 12 h |
| normal | checkin, other | 5 | 6 h |
| safe | safe | 3 | 3 h |

`maxHops` and `expiresAt` are signed; `hop` and `path` aren't (relays must change them).
Receivers reject `hop > maxHops` and `hop != path.length`, drop already-seen IDs and drop
expired messages. Resetting `hop` therefore can't keep a message alive forever.

## Running it

### Android (needs real phones; BLE doesn't work on the emulator)

1. Open `mesh/android` in Android Studio and let it sync. If it asks, let it create the Gradle wrapper.
2. Run on 2+ phones (Android 8.0+). Grant Bluetooth and location permissions at launch.
3. Unit tests: `./gradlew :app:testDebugUnitTest` (router, framing, and the cross-platform vector).

### iOS (needs real iPhones; the Simulator has no Bluetooth)

1. In Xcode: **File → New → Project → iOS App** (SwiftUI), e.g. `BeaconDemo`.
2. **File → Add Package Dependencies → Add Local…** → choose `mesh/ios/BeaconMesh`. Add both
   `BeaconMesh` and `BeaconMeshUI` to the app target.
3. Replace the generated `App` file with [`ios/BeaconDemoApp/BeaconDemoApp.swift`](ios/BeaconDemoApp/BeaconDemoApp.swift).
4. Add the keys from [`ios/BeaconDemoApp/Info-additions.plist`](ios/BeaconDemoApp/Info-additions.plist)
   to the target's Info tab (Bluetooth and location usage strings, plus background modes).
5. Set your team under Signing and run on a device.
6. Tests: `swift test` in `mesh/ios/BeaconMesh` (needs full Xcode, not just Command Line Tools).

### Demo script (hop limit live)

1. Put every phone in airplane mode with Bluetooth on. Keep the app **in the foreground** (see caveats).
2. Line up A, B, C and D far enough apart that each phone only reaches its neighbours,
   or just watch the `hop` and `path` on each phone.
3. On A set **Hop cap = 2** and tap **Check-in**: it reaches C, and C shows "hop limit reached". D never gets it.
4. Tap **Trapped** (critical ignores the cap): it reaches D.
5. On C, turn Wi-Fi on and set the backend URL: C becomes **GATEWAY** and uploads everything it holds.
   Use **Force offline** to keep a phone that has Wi-Fi acting as a pure relay.

## Gateway → backend contract

`POST {backendUrl}/api/mesh/ingest` with `{ envelope, gateway, receivedAt }`. The backend should:
base64-decode `envelope.signed`, verify `envelope.sig` (ECDSA P-256/SHA-256, DER) against
the SPKI public key in `signed.pub`, dedupe by `signed.id`, check `hop == path.length <= maxHops`,
and return 2xx. Show it on the dashboard as "Arrived via N hops: path[0] → … → gateway".
Use `test-vectors/envelope_v1.json` to test the verifier.

## Known limits / caveats

* **Foreground for the demo.** iOS only advertises a 128-bit service UUID in the background
  through Apple's "overflow area", which Android scanners can't see. Two backgrounded iPhones
  still find each other, slowly. Android keeps relaying in the background through the foreground service.
* Each phone keeps about 5–7 simultaneous BLE links. That's plenty for a demo, but not a stadium.
* `body` is plaintext in v1. Next step: encrypt it to the backend's public key (HPKE) and keep only
  routing fields readable.
* The DELIVERED receipt (frame type `0x02`) is reserved but not implemented yet.
