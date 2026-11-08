import Foundation

/// The optional `HeartbeatCreate` fields besides battery / motion.
public struct HeartbeatExtras: Equatable {
    /// `direct` (REST) or `mesh` (wrapped in an envelope).
    public var transport: String?
    /// `wifi` | `cellular` | `none` | `unknown`.
    public var network: String?
    public var peersNearby: Int?
    /// This phone has internet and relays for others.
    public var gateway: Bool?
    /// Own unresolved SOS ids (a hint for the server; at most `Heartbeat.maxOpenSos`).
    public var openSosIds: [String]

    public init(transport: String? = nil, network: String? = nil, peersNearby: Int? = nil, gateway: Bool? = nil,
                openSosIds: [String] = []) {
        self.transport = transport; self.network = network; self.peersNearby = peersNearby; self.gateway = gateway
        self.openSosIds = openSosIds
    }

    func put(into hb: inout [String: JSONValue]) {
        if let transport, Heartbeat.transports.contains(transport) { hb["transport"] = .string(transport) }
        if let network, Heartbeat.networks.contains(network) { hb["network"] = .string(network) }
        if let peersNearby { hb["peers_nearby"] = .int(Int64(max(peersNearby, 0))) }
        if let gateway { hb["gateway"] = .bool(gateway) }
        if !openSosIds.isEmpty {
            var seen = Set<String>()
            let ids = openSosIds.filter { seen.insert($0).inserted }.prefix(Heartbeat.maxOpenSos)
            hb["open_sos_ids"] = .array(ids.map(JSONValue.string))
        }
    }
}

/// What kind of link NWPathMonitor reports (mapped from `NWPath.usesInterfaceType`).
public enum NetworkInterfaceKind: Equatable {
    case wifi, cellular, other, unknown
}

/// The AUTOMATIC liveness beacon (contract `HeartbeatCreate`). Nobody presses anything for it; its absence means the phone
/// has no connectivity. The app sends it whenever the mesh runs: with or without an active event, and while an SOS is open
/// (the server accepts that with `event_active=false`).
public enum Heartbeat {
    public static let maxOpenSos = 20
    public static let transports: Set<String> = ["direct", "mesh"]
    public static let networks: Set<String> = ["wifi", "cellular", "none", "unknown"]
    static let finalStatuses: Set<String> = ["resolved", "closed", "merged"]

    public static func due(lastSentMs: Int64, nowMs: Int64, intervalSeconds: Int) -> Bool {
        lastSentMs <= 0 || nowMs - lastSentMs >= Int64(intervalSeconds) * 1000
    }

    /// Whether a heartbeat goes out now. `force` = connectivity just returned or an SOS was just created.
    /// A heartbeat needs a coarse location; without any fix there is nothing to send. The event state is irrelevant.
    public static func shouldSend(nowMs: Int64, lastSentMs: Int64, intervalSeconds: Int, force: Bool, hasLocation: Bool) -> Bool {
        hasLocation && (force || due(lastSentMs: lastSentMs, nowMs: nowMs, intervalSeconds: intervalSeconds))
    }

    /// Contract `network` value: `none` without internet, else the interface type.
    public static func networkKind(reachable: Bool, interface: NetworkInterfaceKind) -> String {
        guard reachable else { return "none" }
        switch interface {
        case .wifi: return "wifi"
        case .cellular: return "cellular"
        case .other, .unknown: return "unknown"
        }
    }

    /// Own unresolved SOS ids, newest first, at most 20, created by the current identity (`ownPublicKey`).
    public static func openSosIds(_ messages: [StoredMessage], nowMs: Int64, ownPublicKey: String) -> [String] {
        messages
            .filter {
                $0.isOwn && $0.envelope.kind == "sos" && $0.expiresAtMs > nowMs && $0.rejectedReason == nil
                    && !finalStatuses.contains($0.serverStatus?.status ?? "") && $0.envelope.senderPublicKey == ownPublicKey
            }
            .sorted { $0.receivedAt > $1.receivedAt }
            .prefix(maxOpenSos).map(\.id)
    }

    /// When the next try should happen after the server answered 404 (no active event and no open SOS for this device):
    /// a full interval, or 60 s when we hold an own SOS that may just not have reached the server yet.
    public static func retryDelayAfterNotFound(intervalSeconds: Int, hasOpenSos: Bool) -> Int {
        hasOpenSos ? min(60, intervalSeconds) : intervalSeconds
    }
}
