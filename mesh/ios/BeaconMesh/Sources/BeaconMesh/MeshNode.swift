import Combine
import CoreLocation
import Foundation

/// One object the app owns: BLE transport + router + store + gateway uploader + location.
/// Everything runs on the main queue.
public final class MeshNode: NSObject, ObservableObject {
    @Published public private(set) var messages: [StoredMessage] = []
    @Published public private(set) var peerCount = 0
    @Published public private(set) var isGateway = false
    @Published public private(set) var logLines: [String] = []

    /// Demo setting: cap maxHops for non-critical messages (nil = use the priority table).
    @Published public var demoHopCap: Int? = nil
    @Published public var forceOffline = false {
        didSet { uploader.forceOffline = forceOffline; refresh() }
    }
    @Published public var backendURLString: String {
        didSet {
            UserDefaults.standard.set(backendURLString, forKey: "beacon.backendURL")
            uploader.backendURL = URL(string: backendURLString)
            refresh()
        }
    }

    public let router: MeshRouter
    public var relayId: String { router.relayId }

    private let transport = BLETransport()
    private let uploader: GatewayUploader
    private let location = CLLocationManager()
    private var lastLocation: CLLocation?
    private var pruneTimer: Timer?

    public init(signer: MeshSigner = KeychainKeyStore.loadOrCreate(),
                store: MessageStore = FileMessageStore.defaultStore()) {
        let url = UserDefaults.standard.string(forKey: "beacon.backendURL") ?? ""
        backendURLString = url
        router = MeshRouter(signer: signer, store: store)
        uploader = GatewayUploader(relayId: router.relayId, backendURL: URL(string: url))
        super.init()

        router.transport = transport
        router.isOnline = { [weak self] in self?.uploader.isOnline ?? false }
        router.upload = { [weak self] in self?.uploader.upload($0) }
        router.onChange = { [weak self] in self?.refresh() }
        router.log = { [weak self] in self?.append($0) }
        uploader.onOnline = { [weak self] in self?.refresh(); self?.router.internetBecameAvailable() }
        uploader.onUploaded = { [weak self] in self?.router.markUploaded($0) }
        uploader.log = { [weak self] in self?.append($0) }
        transport.delegate = self
        location.delegate = self
    }

    public func start() {
        location.requestWhenInUseAuthorization()
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.startUpdatingLocation()
        transport.start()
        router.pruneExpired()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.router.pruneExpired()
        }
        append("Node \(relayId) started")
        refresh()
    }

    public func stop() {
        transport.stop()
        pruneTimer?.invalidate()
        location.stopUpdatingLocation()
    }

    @discardableResult
    public func sendSOS(_ category: Category, text: String? = nil, people: Int? = nil) -> StoredMessage? {
        let loc = lastLocation
        do {
            return try router.originate(
                category: category,
                text: text?.isEmpty == true ? nil : text,
                lat: loc?.coordinate.latitude,
                lng: loc?.coordinate.longitude,
                accuracy: loc?.horizontalAccuracy,
                people: people,
                nonCriticalHopCap: demoHopCap)
        } catch {
            append("Failed to create SOS: \(error)")
            return nil
        }
    }

    private func refresh() {
        messages = router.messages.sorted { $0.receivedAt > $1.receivedAt }
        peerCount = router.connectedPeers.count
        isGateway = uploader.isOnline
    }

    private func append(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        logLines.insert("\(f.string(from: Date())) \(line)", at: 0)
        if logLines.count > 200 { logLines.removeLast(logLines.count - 200) }
    }
}

extension MeshNode: BLETransportDelegate {
    public func transport(_ transport: BLETransport, peerReady peer: String) { router.peerConnected(peer) }
    public func transport(_ transport: BLETransport, peerLost peer: String) { router.peerDisconnected(peer) }
    public func transport(_ transport: BLETransport, received envelopeJSON: Data, from peer: String) {
        router.receive(envelopeJSON, from: peer)
    }
    public func transport(_ transport: BLETransport, log message: String) { append(message) }
}

extension MeshNode: CLLocationManagerDelegate {
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lastLocation = locations.last
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
