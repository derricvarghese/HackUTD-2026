#if canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import Combine
import CoreLocation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Why a send did not happen. The app never sends plaintext and never fakes a location.
public enum SendFailure: Equatable {
    case noBackendKey
    case noLocation
    case other(String)
}

public enum SendResult {
    case sent(StoredMessage)
    case failed(SendFailure)
}

/// One object the app owns: BLE transport + router + store + backend sync + location + battery.
/// Everything runs on the main queue.
public final class MeshNode: NSObject, ObservableObject {
    @Published public private(set) var messages: [StoredMessage] = []
    @Published public private(set) var peerCount = 0
    @Published public private(set) var isGateway = false
    @Published public private(set) var hasInternet = false
    @Published public private(set) var logLines: [String] = []
    /// Open welfare check-ins (overdue ones included). One entry per check-in id.
    @Published public private(set) var checkins: [WelfareCheckin] = []
    /// Set when the person taps a check-in notification (or its card): the UI shows the confirmation sheet for it.
    @Published public var checkinToShow: WelfareCheckin?
    @Published public private(set) var encryptionKeyStatus: KeyStatus = .none
    @Published public private(set) var signingKeyStatus: KeyStatus = .none
    @Published public private(set) var deviceId: String?
    @Published public private(set) var lastUpload: UploadResult?
    @Published public private(set) var lastHeartbeatAt: Date?
    @Published public private(set) var lastInfoAt: Date?
    @Published public private(set) var eventActive = false
    @Published public private(set) var gpsAccuracy: Double?
    @Published public private(set) var hasLocation = false
    @Published public private(set) var syncError: String?
    @Published public private(set) var heldBackendCount = 0
    // Profile (identity). Contents stay in memory only while the app runs; never logged.
    @Published public private(set) var userProfile: UserProfile?
    @Published public private(set) var profileStatus: ProfileSyncStatus = .empty
    @Published public private(set) var needsProfileOnboarding = false
    @Published public private(set) var profileRequired = true
    @Published public private(set) var profileDeleting = false
    @Published public private(set) var profileConsentVersion = ProfileConsent.bundledVersion
    @Published public private(set) var acceptedConsent: ProfileConsentInfo?
    @Published public private(set) var lastProfileSyncAt: Date?
    /// "Complete your profile" banner dismissed in this launch only (not persisted: it returns next launch).
    @Published public private(set) var profileBannerDismissed = false
    @Published public private(set) var profileNudgeProminent = false
    /// Short ids (first 8 characters) before and after the last "Reset device identity" in this launch; nil before one.
    @Published public private(set) var lastIdentityReset: IdentityResetResult?
    /// Short id of the current signing key, for the debug area.
    public var keyShortId: String { MeshCrypto.shortKeyId(publicKeyDER: rotatingSigner.publicKeyDER) }
    public var instanceShortId: String { String(transport.instanceId.prefix(8)) }

    /// Demo setting: cap max_hops for non-critical messages (nil = use the hop table).
    @Published public var demoHopCap: Int? = nil {
        didSet { defaults.set(demoHopCap ?? 0, forKey: "beacon.demoHopCap") }
    }
    @Published public var forceOffline = false {
        didSet {
            defaults.set(forceOffline, forKey: "beacon.forceOffline")
            uploader.forceOffline = forceOffline
            refresh()
        }
    }

    /// Fixed at build time (Info.plist BEACON_BACKEND_URL, default https://hackutd.alecj.com). Not a user setting.
    public let backendURL = BackendBuildConfig.backendURL
    public var backendHost: String { BackendBuildConfig.backendHost }

    public let router: MeshRouter
    public var relayId: String { router.relayId }
    public var senderPublicKey: String { router.senderPublicKey }

    private let defaults = UserDefaults.standard
    private let transport = BLETransport()
    private let config: BackendConfig
    private let rotatingSigner: RotatingSigner
    private var identityResetter: IdentityResetter!
    private let sync: GatewaySync
    public let profile: ProfileSyncEngine
    private let uploader: GatewayUploader
    private let location = CLLocationManager()
    private var lastLocation: CLLocation?
    public let welfare: WelfareManager
    private var lastWakeMs: Int64 = 0
    private var pruneTimer: Timer?
    private var started = false

    public init(signer: MeshSigner = KeychainKeyStore.loadOrCreate(),
                store: MessageStore = FileMessageStore.defaultStore(),
                keyValueStore: KeyValueStore = UserDefaultsKeyValueStore(),
                profileStore: ProfileStoring = ProfileKeychainStore()) {
        let cfg = BackendConfig(store: keyValueStore,
                                builtInEncryptionKey: BackendBuildConfig.encryptionPublicKey,
                                builtInSigningKey: BackendBuildConfig.signingPublicKey)
        config = cfg
        welfare = WelfareManager(store: FileWelfareStore.defaultStore(), notifier: WelfareNotificationCenter.shared,
                                 reminderSeconds: { cfg.checkinReminderSeconds })
        let rotating = RotatingSigner(signer)
        rotatingSigner = rotating
        router = MeshRouter(signer: rotating, store: store, config: config)
        let client = BackendClient(baseURL: BackendBuildConfig.backendURL, http: URLSessionTransport(), signer: rotating, config: config)
        sync = GatewaySync(client: client, router: router, config: config)
        uploader = GatewayUploader(sync: sync)
        profile = ProfileSyncEngine(client: client, config: config, store: profileStore)
        super.init()
        identityResetter = IdentityResetter(
            signer: rotating, keys: KeychainDeviceKeyRotator(), instance: UserDefaultsInstanceId(), config: config, profile: profile,
            restartTransport: { [weak self] id in self?.transport.restart(withInstanceId: id) },
            cancelCheckins: { [weak self] in self?.dropCheckinsOfOldIdentity() })
        sync.profileSync = profile
        sync.welfare = welfare
        router.welfare = welfare
        welfare.onChange = { [weak self] in self?.refresh() }
        welfare.log = { [weak self] in self?.append($0) }   // short ids only, never check-in text
        let notifications = WelfareNotificationCenter.shared
        notifications.onOpen = { [weak self] id in self?.openCheckin(id) }
        notifications.onAnswer = { [weak self] id, response in _ = await self?.answerCheckin(id: id, response: response) }
        notifications.install()
        profile.requestGatewayCycle = { [weak self] in self?.sync.requestCycle(force: true) }
        profile.onChange = { [weak self] in self?.refresh() }
        profile.log = { [weak self] in self?.append($0) }   // engine log lines carry status codes only, never profile content
        router.profileSummary = { [weak self] in self?.profile.meshSummary() }

        let cap = defaults.integer(forKey: "beacon.demoHopCap")
        demoHopCap = cap > 0 ? cap : nil
        forceOffline = defaults.bool(forKey: "beacon.forceOffline")
        uploader.forceOffline = forceOffline
        if let fix = defaults.array(forKey: "beacon.lastFix") as? [Double], fix.count == 2 {
            cachedFix = (fix[0], fix[1])
        }

        sync.appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String).map { "ios-" + $0 }
        sync.log = { [weak self] in self?.append($0) }
        sync.sample = { [weak self] in self?.heartbeatSample() }
        sync.onUploadResult = { [weak self] in self?.lastUpload = $0; self?.refresh() }
        sync.onStateChange = { [weak self] in self?.refresh() }
        uploader.onChange = { [weak self] in self?.refresh() }
        uploader.onOnline = { [weak self] in self?.router.internetBecameAvailable() }

        router.transport = transport
        router.isOnline = { [weak self] in self?.uploader.isOnline ?? false }
        router.upload = { [weak self] _ in self?.sync.requestCycle(force: true) }
        router.onChange = { [weak self] in self?.refresh() }
        router.log = { [weak self] in self?.append($0) }
        router.onCheckinRequest = { [weak self] _ in self?.refresh() }
        transport.delegate = self
        location.delegate = self
        refresh()
    }

    private var cachedFix: (Double, Double)?

    public func start() {
        guard !started else { transport.start(); return }
        started = true
        #if canImport(UIKit) && !os(watchOS)
        UIDevice.current.isBatteryMonitoringEnabled = true
        #endif
        location.requestWhenInUseAuthorization()
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.startUpdatingLocation()
        transport.start()
        uploader.start()
        welfare.wake()
        router.pruneExpired()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.router.pruneExpired()
            self?.uploader.tick()
        }
        append("Node \(relayId) started")
        refresh()
        uploader.tick()
    }

    public func stop() {
        transport.stop()
        uploader.stop()
        pruneTimer?.invalidate()
        location.stopUpdatingLocation()
        started = false
    }

    /// Cheap periodic hook (also called from BLE callbacks so a backgrounded app still syncs and heartbeats).
    public func tick() {
        uploader.tick()
        // Re-plan the single local reminder request of each open check-in now and then; wake() never alerts by itself.
        let t = Int64(Date().timeIntervalSince1970 * 1000)
        if t - lastWakeMs > 20_000 { lastWakeMs = t; welfare.wake() }
        welfare.remindDueOverdue()   // foreground: honours the exact reminder interval (the repeating request is >= 60 s)
    }

    // MARK: Sending

    /// True when a send would not be refused for a missing key.
    public var canEncrypt: Bool { encryptionKeyStatus != .none }

    @discardableResult
    public func sendSOS(_ category: Category, text: String? = nil, people: Int? = nil) -> SendResult {
        let fix = currentCoordinate()
        do {
            let msg = try router.originate(
                category: category,
                text: text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                lat: fix?.0, lng: fix?.1,
                accuracy: lastLocation.flatMap { $0.horizontalAccuracy >= 0 ? $0.horizontalAccuracy : nil },
                people: people,
                nonCriticalHopCap: demoHopCap)
            // The first SOS is the right moment to ask for notifications (check-ins arrive as notifications), and the
            // server should hear from this phone right away.
            WelfareNotificationCenter.shared.requestAuthorizationIfNeeded()
            sync.requestHeartbeat()
            return .sent(msg)
        } catch MeshError.noBackendKey {
            append("SOS not created: no backend encryption key (go online once, or build with BEACON_ENC_PUBLIC_KEY)")
            return .failed(.noBackendKey)
        } catch MeshError.noLocation {
            append("SOS not created: no location fix yet")
            return .failed(.noLocation)
        } catch {
            append("Failed to create SOS: \(error)")
            return .failed(.other("\(error)"))
        }
    }

    /// Answer a welfare check-in (also after its deadline). Marked answered at once, the notification and reminders are
    /// removed, then the reply goes out: PATCH when online, a mesh `checkin_reply` otherwise.
    @discardableResult
    public func answerCheckin(id: String, response: String) async -> GatewaySync.ReplyOutcome {
        let outcome = await sync.answerCheckin(id, response: response)
        await MainActor.run { checkinToShow = nil; refresh() }
        return outcome
    }

    public func openCheckin(_ id: String) {
        DispatchQueue.main.async { [self] in
            if let p = welfare.find(id), p.isOpen { checkinToShow = p }
        }
    }

    public func syncNow() { uploader.syncNow() }

    // MARK: Profile

    /// Validates and stores the profile (offline-safe), then syncs when possible. Returns field issues; empty = saved.
    @discardableResult
    public func saveProfile(_ p: UserProfile, consentVersion: String) -> [String: String] {
        profile.save(p, consentVersion: consentVersion)
    }
    public func renewProfileConsent() { profile.renewConsent(version: profile.consentVersion) }
    public func skipProfile() { profile.skip() }
    public func dismissProfileBanner() { profileBannerDismissed = true }
    public func deleteProfile() {
        welfare.cancelAll()          // no consent, no check-ins
        profile.deleteProfile()
    }
    public func retryProfileSync() { profile.retry() }

    // MARK: State

    private func currentCoordinate() -> (Double, Double)? {
        if let l = lastLocation { return (l.coordinate.latitude, l.coordinate.longitude) }
        return cachedFix
    }

    private func heartbeatSample() -> HeartbeatSample? {
        guard let c = currentCoordinate() else { return nil }
        var pct: Int?
        var charging: Bool?
        #if canImport(UIKit) && !os(watchOS)
        let level = UIDevice.current.batteryLevel
        if level >= 0 { pct = Int((level * 100).rounded()) }
        let st = UIDevice.current.batteryState
        if st != .unknown { charging = (st == .charging || st == .full) }
        #endif
        let moving = lastLocation.map { $0.speed > 1.0 }
        return HeartbeatSample(lat: c.0, lng: c.1, batteryPct: pct, charging: charging, moving: moving)
    }

    private func refresh() {
        messages = router.messages.filter { $0.envelope.kind != "heartbeat" }.sorted { $0.receivedAt > $1.receivedAt }
        peerCount = router.connectedPeers.count
        isGateway = uploader.isOnline
        hasInternet = uploader.hasInternet
        encryptionKeyStatus = config.encryptionKeyStatus
        signingKeyStatus = config.signingKeyStatus
        deviceId = config.deviceId
        eventActive = config.eventActive
        lastInfoAt = config.lastInfoAtMs > 0 ? Date(timeIntervalSince1970: Double(config.lastInfoAtMs) / 1000) : nil
        lastHeartbeatAt = config.lastHeartbeatAtMs > 0 ? Date(timeIntervalSince1970: Double(config.lastHeartbeatAtMs) / 1000) : nil
        syncError = sync.lastError
        userProfile = profile.profile
        profileStatus = profile.status
        needsProfileOnboarding = profile.needsOnboarding
        profileRequired = profile.profileRequired
        profileDeleting = profile.isDeleting
        profileNudgeProminent = profile.nudgeIsProminent
        profileConsentVersion = profile.consentVersion
        acceptedConsent = profile.record.consentVersion.map { ProfileConsentInfo(version: $0, acceptedAtMs: profile.record.consentAcceptedAtMs) }
        lastProfileSyncAt = profile.record.lastSyncedAtMs > 0 ? Date(timeIntervalSince1970: Double(profile.record.lastSyncedAtMs) / 1000) : nil
        heldBackendCount = router.backendItems.count
        hasLocation = currentCoordinate() != nil
        checkins = welfare.pending()
        if let shown = checkinToShow, !checkins.contains(where: { $0.checkinId == shown.checkinId }) { checkinToShow = nil }
    }

    /// Debug/demo: become a new sender. New signing key, new BLE peer id, device registration forgotten (the next
    /// online moment registers the new key), heartbeat sequence restarted, profile re-sent to the new device. Local
    /// message history and seen-ids are kept. Returns false (nothing changed) if the Keychain refused the new key.
    @discardableResult
    public func resetIdentity() -> Bool {
        do {
            lastIdentityReset = try identityResetter.reset()
            append("Device identity reset")          // ids are shown in Settings, never keys
            refresh()
            sync.requestCycle(force: true)
            return true
        } catch {
            append("Device identity reset failed")
            return false
        }
    }

    private func dropCheckinsOfOldIdentity() {
        welfare.cancelAll()          // old identity's check-ins, their notifications and local reminders
        checkinToShow = nil
        for item in router.pendingCheckins {
            if case .message(let m) = item.payload, let id = m.checkinId { router.markCheckinAnswered(checkinId: id) }
        }
    }

    private func append(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        logLines.insert("\(f.string(from: Date())) \(line)", at: 0)
        if logLines.count > 200 { logLines.removeLast(logLines.count - 200) }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

extension MeshNode: BLETransportDelegate {
    public func transport(_ transport: BLETransport, peerReady peer: String) { router.peerConnected(peer); tick() }
    public func transport(_ transport: BLETransport, peerLost peer: String) { router.peerDisconnected(peer) }
    public func transport(_ transport: BLETransport, received json: Data, from peer: String) {
        router.receive(json, from: peer)
        tick()
    }
    public func transport(_ transport: BLETransport, log message: String) { append(message) }
}

extension MeshNode: CLLocationManagerDelegate {
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        lastLocation = l
        gpsAccuracy = l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil
        hasLocation = true
        defaults.set([l.coordinate.latitude, l.coordinate.longitude], forKey: "beacon.lastFix")
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
#endif
