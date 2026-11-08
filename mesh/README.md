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
* **Android**: [`android`](android), a Kotlin app module (platform BLE + AndroidKeyStore + SQLite for the mesh; Jetpack Compose + Material 3 Expressive for the UI).
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

1. Open `mesh/android` in Android Studio and let it sync (JDK 17, Android SDK 36). Gradle 8.13, AGP 8.13.2, Kotlin 2.2.21.
2. Run on 2+ phones (Android 8.0+). The app opens with an onboarding screen that asks for Bluetooth,
   location and notification access and checks that Bluetooth and location are ON; the mesh starts only after that.
   From the command line: `export JAVA_HOME=<JDK 17>` then `./gradlew :app:installDebug` with the phone connected.
3. Unit tests: `./gradlew :app:testDebugUnitTest` (router, framing, cross-platform vector, UI logic, one Robolectric Compose test).
   Lint: `./gradlew :app:lintDebug`.
4. On an exFAT/external drive, add `-Pbeacon.buildRoot=/tmp/beacon-gradle` to every Gradle command.
   macOS writes `._` AppleDouble files there, and Gradle then can't clean its own build folders.

UI structure (`app/src/main/java/com/beacon/mesh/ui`):

* `MainActivity` (splash screen, edge-to-edge) -> `BeaconApp` (theme, onboarding gate, bottom bar on phones / rail on wide windows, Navigation Compose with predictive back).
* `MeshViewModel` exposes `MeshNode.state` (a `StateFlow<MeshSnapshot>`: peers, messages, log, gateway and GPS state), UI settings and the SOS draft (SavedStateHandle).
* `screens/`: Onboarding, Home (SOS tiles, confirmation sheet with hold-to-send), Mesh status, Messages (list-detail), Settings, Debug/demo (hop cap, force offline, backend URL, raw log).
* `logic/`: pure, unit-tested helpers (permission plan, backend URL validation, message status/hop path mapping, SOS draft rules).
* Demo hop cap and backend URL moved to Settings -> Debug and demo.
* Material 3 Expressive needs `material3` 1.5.0 alpha (1.4.0 keeps those APIs internal); newer androidx releases require AGP 9.1 and compileSdk 37.

### iOS (needs real iPhones; the Simulator has no Bluetooth)

1. Open `mesh/ios/BeaconDemo.xcodeproj` in Xcode. It already links the local `BeaconMesh` package
   and merges `BeaconDemoApp/Info.plist` (Bluetooth and location usage strings, plus background modes).
2. Target **BeaconDemo → Signing & Capabilities**: pick your team. If the bundle ID
   `com.beacon.mesh.demo` is taken, change it.
3. Plug in an iPhone, select it as the run destination, and press Run. The first time, trust the
   developer certificate on the phone under Settings → General → VPN & Device Management.
4. Tests: `swift test` in `mesh/ios/BeaconMesh`. On an exFAT/external drive, codesigning the test
   bundle fails because of AppleDouble files, so build on the internal disk:
   `swift test --scratch-path /tmp/beacon-spm`.

### Demo script (hop limit live)

1. Put every phone in airplane mode with Bluetooth on. Keep the app **in the foreground** (see caveats).
2. Line up A, B, C and D far enough apart that each phone only reaches its neighbours,
   or just watch the `hop` and `path` on each phone.
3. On A open Settings -> Debug and demo, set **Hop cap = 2**, go Home and send a **Check-in** (the + menu): it reaches C, and C shows "hop limit reached". D never gets it.
4. Tap **Trapped** (critical ignores the cap): it reaches D.
5. On C, turn Wi-Fi on and set the backend URL: C becomes **GATEWAY** and uploads everything it holds.
   Use **Force offline** (Settings -> Debug and demo) to keep a phone that has Wi-Fi acting as a pure relay.

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
