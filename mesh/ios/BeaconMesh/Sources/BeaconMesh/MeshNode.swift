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
    @Published public private(set) var checkins: [CheckinPrompt] = []
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
    private let sync: GatewaySync
    private let uploader: GatewayUploader
    private let location = CLLocationManager()
    private var lastLocation: CLLocation?
    private var restCheckins: [CheckinPrompt] = []
    private var pruneTimer: Timer?
    private var started = false

    public init(signer: MeshSigner = KeychainKeyStore.loadOrCreate(),
                store: MessageStore = FileMessageStore.defaultStore(),
                keyValueStore: KeyValueStore = UserDefaultsKeyValueStore()) {
        config = BackendConfig(store: keyValueStore,
                               builtInEncryptionKey: BackendBuildConfig.encryptionPublicKey,
                               builtInSigningKey: BackendBuildConfig.signingPublicKey)
        router = MeshRouter(signer: signer, store: store, config: config)
        let client = BackendClient(baseURL: BackendBuildConfig.backendURL, http: URLSessionTransport(), signer: signer, config: config)
        sync = GatewaySync(client: client, router: router, config: config)
        uploader = GatewayUploader(sync: sync)
        super.init()

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
        sync.onCheckins = { [weak self] in self?.restCheckins = $0; self?.refresh() }
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
    public func tick() { uploader.tick() }

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

    /// Answer a check-in. `response`: ok | need_help | other.
    public func reply(to prompt: CheckinPrompt, response: String, text: String? = nil) async -> SendFailure? {
        let fix = currentCoordinate()
        do {
            try await sync.reply(to: prompt, response: response, text: text?.nilIfEmpty, lat: fix?.0, lng: fix?.1)
            await MainActor.run {
                restCheckins.removeAll { $0.checkinId == prompt.checkinId }
                refresh()
            }
            return nil
        } catch MeshError.noBackendKey { return .noBackendKey }
        catch MeshError.noLocation { return .noLocation }
        catch { return .other("\(error)") }
    }

    public func syncNow() { uploader.syncNow() }

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
        heldBackendCount = router.backendItems.count
        hasLocation = currentCoordinate() != nil
        var merged = router.pendingCheckins.compactMap(CheckinPrompt.from)
        for p in restCheckins where !merged.contains(where: { $0.checkinId == p.checkinId }) { merged.append(p) }
        checkins = merged
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
