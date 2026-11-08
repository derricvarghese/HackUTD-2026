# Beacon: offline SOS relay for iPhone and Android over Bluetooth LE

Phones in airplane mode (Bluetooth on) pass signed SOS messages hand to hand until one
of them has internet. That phone becomes the gateway and uploads everything it holds.
Messages are the Beacon API contract's `MeshEnvelope` (payload encrypted to the backend, signed by the sender), so the server
accepts them unchanged from any gateway. **Status:** Android implements the contract (PROTOCOL v2); iOS still speaks the deprecated
v1 and does not interoperate with Android until it follows [`ios/CONTRACT-MIGRATION.md`](ios/CONTRACT-MIGRATION.md).

```
[Phone A] --BLE--> [Phone B] --BLE--> [Phone C: has Wi-Fi = gateway] --HTTPS--> backend
   hop 1              hop 2                 POST /v1/sos/batch
```

* **Wire protocol**: [`PROTOCOL.md`](PROTOCOL.md) (v2, the API contract; v1 is deprecated). Read this first.
* **iOS**: [`ios/BeaconMesh`](ios/BeaconMesh), a Swift package (CoreBluetooth + CryptoKit, no dependencies). Units (metric or imperial, Settings -> Units) are all formatted by one pure type, `Units` in `BeaconMesh/Units.swift`; storage stays metric.
* **Android**: [`android`](android), a Kotlin app module (platform BLE + AndroidKeyStore + SQLite for the mesh; Jetpack Compose + Material 3 Expressive for the UI).
* **Shared test vectors**: [`test-vectors/contract_v1/`](test-vectors/contract_v1): `server_envelope.json` (made by the server's own test helper:
  signed + encrypted envelope, backend message, receipt, request signature, canonical JSON cases, test keys) is verified/decrypted by the Android
  tests; `android_envelope.json` (made by the Android router) is ingested by `server/test/e2e/android-interop.test.ts`; `android_profile_envelope.json` (with `profile_summary`) by `server/test/e2e/android-profile-interop.test.ts`.
  `envelope_v1.json` is the deprecated v1 vector (iOS only).

## Why not Nearby Connections?

Nearby Connections (Android) and Multipeer Connectivity (iOS) can't talk to each other.
Plain BLE GATT is the one thing both platforms speak without pairing, so every phone is
both a GATT **peripheral** (advertises the Beacon service and accepts writes) and a
**central** (scans, connects and writes). See PROTOCOL.md for the reasoning.

## Hop limits

| Tier | Used for | Max hops | Expires |
|---|---|---|---|
| critical | trapped, injured, medical | 10 | 24 h |
| high | water/meds | 7 | 12 h |
| normal | check-in, other, check-in replies | 5 | 6 h |
| safe | safe | 3 | 3 h |
| heartbeat | liveness pings | 2 | 30 min |

`max_hops` and `expires_at` are signed; `hop_count` and `hop_path` aren't (relays must change them). Receivers reject `hop_count > max_hops` and
`hop_count != hop_path.length`, drop already-seen IDs and expired messages. The table is replaced by `GET /v1/server-info` values once cached.

## Keys, backend and security

The app encrypts every SOS payload to the backend's P-256 key (ECIES) and signs the envelope with an Android Keystore key. The backend keys come
from `GET /v1/server-info` (cached whenever the phone is online) or are baked in at build time so a phone that was never online can still send:

```bash
./gradlew :app:assembleDebug -Pbeacon.encPublicKey=<base64 SPKI> -Pbeacon.signPublicKey=<base64 SPKI>   # public halves from `npm run keys` / server-info
```

With no key available the app refuses to create a message and says so (it never sends plaintext). The Mesh status screen shows the key status
(missing / built in / loaded from server), device registration, server reachability, the last upload result with per-item counts and the heartbeat state.
Backend URL stays a build setting (`-Pbeacon.backendUrl`, default `https://hackutd.alecj.com`).
Upgrading from the v1 build drops the old local message database (those messages could never be uploaded).

## Running it

### Android (needs real phones; BLE doesn't work on the emulator)

1. Open `mesh/android` in Android Studio and let it sync (JDK 17, Android SDK 36). Gradle 8.13, AGP 8.13.2, Kotlin 2.2.21.
2. Run on 2+ phones (Android 8.0+). The app opens with an onboarding screen that asks for Bluetooth,
   location and notification access and checks that Bluetooth and location are ON; the mesh starts only after that.
   From the command line: `export JAVA_HOME=<JDK 17>` then `./gradlew :app:installDebug` with the phone connected.
3. Server cross-check: `cd server && npm test` (includes `test/e2e/android-interop.test.ts`). Regenerate fixtures: `npx tsx scripts/make-contract-fixtures.ts ../mesh/test-vectors/contract_v1/server_envelope.json`, then `BEACON_WRITE_FIXTURES=1 ./gradlew :app:testDebugUnitTest --tests '*AndroidFixtureTest*'`.
   Unit tests: `./gradlew :app:testDebugUnitTest` (router, canonical signing, ECIES, contract fixtures from the server, request signing, upload handling with fake HTTP, framing, UI logic, one Robolectric Compose test).
   Lint: `./gradlew :app:lintDebug`.
4. On an exFAT/external drive, add `-Pbeacon.buildRoot=/tmp/beacon-gradle` to every Gradle command.
   macOS writes `._` AppleDouble files there, and Gradle then can't clean its own build folders.

UI structure (`app/src/main/java/com/beacon/mesh/ui`):

* `MainActivity` (splash screen, edge-to-edge) -> `BeaconApp` (theme, onboarding gate, bottom bar on phones / rail on wide windows, Navigation Compose with predictive back).
* `MeshViewModel` exposes `MeshNode.state` (a `StateFlow<MeshSnapshot>`: peers, messages, log, gateway and GPS state), UI settings and the SOS draft (SavedStateHandle).
* `screens/`: Onboarding, Home (SOS tiles, confirmation sheet with hold-to-send), Mesh status, Messages (list-detail), Settings, Debug/demo (haptics lab, hop cap, force offline, raw log).
* `logic/`: pure, unit-tested helpers (permission plan, message status/hop path mapping, SOS draft rules).
* Demo hop cap lives in Settings -> Debug and demo. The backend URL is fixed at build time (`BACKEND_URL`, default `https://hackutd.alecj.com`; override with `./gradlew -Pbeacon.backendUrl=https://host ...`) and shown read-only.
* Haptics: every interaction goes through one `Haptics` class (`ui/haptics`, `LocalHaptics`) with semantic events (tap, toggle, select, tick, success, error, sheet open/dismiss, ...). Standard effects use the platform haptic constants, so they follow the system touch-feedback setting; success, error, warning and sheet effects use richer vibration compositions where the hardware supports them and degrade to short waveforms. Rate limiting stops double-fires and drag spam. Settings -> Feedback -> "Haptic feedback" turns all of it off, including the hold-to-send buzz; Settings -> Debug and demo -> "Haptics lab" plays each event.
* **User profile (Android).** After the permissions step, onboarding shows a plain-language consent card (what is collected, who sees what, deletion, everything but the name optional) and then a six-section form (about you, appearance, medical and mobility, household with pets, emergency contact and address, notes) with a progress indicator and inline validation that follows the contract limits. "Skip for now" is available at every step (consent card and form), whatever `profile_required` says and even when the server was never reached: SOS is never blocked. A skip records no consent, uploads nothing and adds no `profile_summary`; the name is required only to save. Without a connection a name alone is enough and it syncs later. After a skip Home keeps a "Complete your profile" nudge (a prominent tonal card saying responders can find and help you faster when the server reports `profile_required=true`, a small banner otherwise); dismissing it lasts for the session only and it returns next launch, and Settings -> My profile shows "Not set up" with a Set up button. Home shows a dismissible "Complete your profile" banner and a status chip (Synced / Will sync when online / Sync failed, retry); Settings -> My profile views and edits everything, shows the sync row with Retry and the consent version and date, and "Delete my profile" (local erase at once, `DELETE /v1/devices/{id}/profile` until the server confirms).
  * Sync (`gateway/ProfileSync.kt`, driven by the same connectivity detection and IO thread as the gateway upload): `PUT /v1/devices/{id}/profile` with `If-Match: <last acked profile_version>` (`0` = create only), the version from the response is kept; `409` -> `GET`, adopt the version and write again (this phone is the only writer, so local content wins); `422` on consent -> refresh `/server-info` and ask the user to agree again when `profile_consent_version` changed; `404` / `Device.profile_version` missing or lower than local -> upload again from the local copy; `429`, offline and 5xx -> exponential backoff (15 s doubling up to 30 min, `Retry-After` honoured). It re-checks on app start, when the network comes back and every few minutes.
  * Privacy: the profile lives only in `files/profile.bin`, an AES-256-GCM blob sealed with a non-exportable Android Keystore key (excluded from backups and device transfer; a blob the key cannot open is dropped). Profile content is never logged, never put in the saved-state bundle (the form is autosaved into the encrypted blob so it survives process death) and never sent over the mesh, except `MeshPayload.profile_summary` (name, age range, coarse flags, last acked version; see PROTOCOL.md) on own SOS / safe messages. The summary is stored with the message payload in the local message database like the location. Right to erasure is "Delete my profile".
  * Tests: `profile/ProfileRulesTest` (flags/age buckets/limits mirror the server), `ProfileModelTest` (ProfileInput JSON omits empty fields), `ProfileSyncTest` (fake HTTP: 201/200, 409, 422 consent, 404 re-PUT, 429, offline, erase), `ProfileSummaryPayloadTest` (summary only on sos/safe, nothing else leaks, worst-case envelope still fits 64 chunks at a 100 B write), `ui/ProfileEditorTest` (onboarding/form state), `AndroidProfileFixtureTest` + `server/test/e2e/android-profile-interop.test.ts`.
* Material 3 Expressive needs `material3` 1.5.0 alpha (1.4.0 keeps those APIs internal); newer androidx releases require AGP 9.1 and compileSdk 37.

* **First responder mode (Android).** Settings -> Responder mode adds a Responder tab (off by default; turning it off signs out). Sign in with a dashboard account (`POST /v1/auth/login` on the baked-in server): the access token stays in memory, the refresh token is stored AES-GCM encrypted with a non-exportable Keystore key, a 401 refreshes once and retries, sign out wipes everything. The tab shows a live OpenStreetMap map of open cases (pin colour by score tier, a pulsing ring for silent or unresponsive people, a circle over the ~1 km `approx_location` unless the API returned an exact `location`, dashed circles for SOS only heard over Bluetooth) plus a ranked list with filters (All, Critical, Silent, Mine, Unclaimed). Case details show triage reasons, hop path, check-ins and history; claim, en route, on scene, resolve (with outcome), release and notes need a responder or admin (volunteers are read-only); Navigate and Call appear only when the API returns the exact location or the full profile. Updates arrive over `/v1/ws` with exponential-backoff reconnect and an `updated_since` catch-up, falling back to a 15 s poll like iOS. The map uses **osmdroid** (about 1 MB, plain Views, no API key, no Google services) with OSM raster tiles in an `AndroidView`; MapLibre Native was heavier (about 10 MB of native libraries per ABI) and needs a style JSON for the same result. If tiles cannot load the map is a blank surface and the list keeps working. The mesh service keeps relaying while responder mode is on. Case details have a Directions button for every case (exact spot, or "Directions to the area" toward the centre of the ~1 km circle, as on iOS). **Location sharing** (Responder tab -> sliders icon -> "Share my location with dispatch", off by default, plus "Available for assignments"): after a plain-language rationale and the runtime location permission (while in use only; approximate-only is accepted with a notice), the platform `LocationManager` (no Play services) feeds `PATCH /v1/responders/{id}` with `location`, at most every 10 s, when the position moved 25 m or every 60 s, with backoff, nothing sent offline, only the newest fix kept. A "Sharing your location" banner stays visible in the Responder tab. Switching off, signing out, leaving responder mode, revoking the permission or an expired session stops it and sends `location: null` (retried until accepted, or dropped if the session is gone). The switch persists but sharing starts only after a sign-in in the current run (after a restart you tap Resume). **Limitation:** there is no background-location permission, so Android only delivers fixes while the app is in the foreground; with the screen off or another app on top the position goes stale and dispatch sees the last one until it is cleared.
* **First responder mode (iOS).** Same behaviour as Android: Settings -> Responder mode (off by default) adds the Responder tab and turning it off signs out, stops sharing and removes the tab; with it off the app is the plain victim app. Inside, "Share my location with dispatch" (rationale, When-In-Use only, approximate accepted with a notice, Open Settings when denied) and "Available for assignments" send `PATCH /v1/responders/{id}`; a "Sharing your location" chip stays above every tab while sharing. The throttle/backoff/clear logic is the pure `ResponderLocationSharer` in the BeaconMesh target (tested in `ResponderLocationTests`). Sharing only starts after a sign-in in the current run and fixes arrive only while the app is active (no background location). **Reset device identity (iOS, Settings -> Debug and demo, with confirmation):** for demos, because the server merges reports from one sender. It replaces the Keychain signing key, rotates the BLE instance UUID and restarts the transport, forgets the device id and heartbeat sequence (the next online moment registers the new key), and marks the profile unsynced so it is re-PUT to the new device. Message history and seen-ids stay; old and new 8-character ids are shown with a copy button. Sequencing lives in `IdentityResetter` (tested in `IdentityResetTests`).

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
3. On A open Settings -> Debug and demo, set **Hop cap = 2**, go Home and send **Something else** (a normal-tier message, in the + menu): it reaches C, and C shows "hop limit reached". D never gets it.
4. Tap **Trapped** (critical ignores the cap): it reaches D.
5. On C, turn Wi-Fi on and connect: C becomes **GATEWAY** and uploads everything it holds.
   Use **Force offline** (Settings -> Debug and demo) to keep a phone that has Wi-Fi acting as a pure relay.

## Welfare check-ins and the heartbeat (iOS)

The iOS app sends the **automatic heartbeat** itself (`POST /v1/heartbeats` with `transport=direct`, otherwise a `kind=heartbeat` envelope with `transport=mesh`) every
`heartbeat_interval_seconds` (default 300) while the app runs, with or without an event and while an SOS is open, plus at once when connectivity returns and when an SOS is
created. It carries `network` (NWPath interface), `peers_nearby`, `gateway` and `open_sos_ids` (max 20). Nobody presses anything for it; there is no "I'm OK" button.
A person with an open SOS gets **welfare check-ins** (heartbeat 202 `pending_checkins`, `GET /v1/checkins/pending`, mesh `checkin_request`) as ONE local notification per
`checkin_id` with no answer buttons: a tap on the notification opens the in-app check-in screen, where the person taps one of the three answers ("I'm still here", "I no longer need help", "I need urgent help"). Answers go by `PATCH /v1/checkins/{id}` or a mesh `checkin_reply`; `no_longer_need_help` also shows the case as resolved. A missed check-in stays the same
one: the notification becomes "overdue" and is replaced and re-alerted (same identifier, never a pile) on every re-delivery, by one repeating local request (iOS floors repeating triggers at 60 s, so a shorter server value is honoured only while the app is in the foreground) and by the foreground timer; a late answer is accepted. No alarm. Limitation: a repeating request can only start once the app runs after the deadline, so until then a sleeping phone shows just the one notification scheduled for `deadline_at`.
**iOS limits (be honest):** iOS only runs the app in the background for Bluetooth (the `bluetooth-central/peripheral` modes) and short wakeups, so a check-in can only be shown when the
app runs (BLE wake, foreground, heartbeat reply); local reminders then keep coming. Real push (APNs) is NOT set up: it needs the Push Notifications capability plus APNs credentials on the
server. Xcode: enable **Time Sensitive Notifications** under Signing & Capabilities (adds `com.apple.developer.usernotifications.time-sensitive`; the project has no entitlements file yet).
Without it notifications are still delivered, just not as time sensitive. No critical alerts are used.

## Gateway to backend

A phone with internet registers once (`POST /v1/devices`), signs every call (`X-Device-Id`, `X-Timestamp`, `X-Device-Signature`), uploads held envelopes with
`POST /v1/sos/batch` (per-item results, `Retry-After` honoured), injects returned receipts and backend messages into the mesh, polls `GET /v1/mesh/outbox`
every 30 s, and keeps keys and hop table fresh from `/v1/server-info`. If the sender itself is online it uses `POST /v1/sos` and polls `GET /v1/sos/{id}/status`.
The foreground service sends the automatic heartbeat (`POST /v1/heartbeats`, or a heartbeat envelope over the mesh) whenever it runs, event or not. A person with
an open SOS may get a welfare check-in: one notification with no answer buttons; tapping it opens the in-app check-in screen with the three answers ("I'm still here" / "I no longer need help" / "I need urgent help", answered by PATCH or a mesh
`checkin_reply`); if missed it stays the same notification, turns "overdue" and re-alerts until answered. There is no alarm. Details: [`PROTOCOL.md`](PROTOCOL.md).

**Debug and demo (Settings -> Debug):** "Test welfare check-in notification" posts a fake local check-in with a 20 s deadline (no server call). "Reset device identity" deletes
the Keystore signing key and makes a new one, gives the BLE transport a new instance id, clears the server device registration (the new key registers when next online),
restarts the heartbeat counter, cancels open check-ins and re-uploads the kept profile for the new device; held messages and history stay. Use it to send several separate
reports from one phone, since the server merges reports from the same device. The screen shows the device id with a copy button.

## Known limits / caveats

* **Foreground for the demo.** iOS only advertises a 128-bit service UUID in the background
  through Apple's "overflow area", which Android scanners can't see. Two backgrounded iPhones
  still find each other, slowly. Android keeps relaying in the background through the foreground service.
* Each phone keeps about 5–7 simultaneous BLE links. That's plenty for a demo, but not a stadium.
* Relays see only routing fields (approximate location, category, tier); the payload is encrypted. Relays that have no key for a sender relay the
  message unverified; the server is the final check.
* A phone without a location fix cannot create an SOS (the server requires coordinates).
* Receipts and backend messages travel as plain JSON objects over the same data frames (frame type 0x02 is now the BLE HELLO, see PROTOCOL.md).
* Full phone-to-server upload needs a deployed server plus keys (`server-info` or the Gradle properties above).
* Android map and location notes: osmdroid's own tile downloader has no timeouts and stalls on networks where one IP family black-holes (VPN, NAT64), so the
  responder map downloads tiles with OkHttp (`OkHttpTileProvider`). Location uses the fused provider (API 31+) then GPS then network, and a worse fix never
  replaces a better one (`location/LocationSelector`); the UI shows the source and the rounded 68 % radius.
