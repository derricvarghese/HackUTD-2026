import Foundation

/// What the sender typed, kept on the sender's phone only (the envelope payload is encrypted to the backend).
public struct OwnInfo: Equatable {
    public var category: String
    public var text: String?
    public var people: Int?
    public var lat: Double?
    public var lng: Double?
    public var accuracy: Double?

    public init(category: String, text: String? = nil, people: Int? = nil, lat: Double? = nil, lng: Double? = nil,
                accuracy: Double? = nil) {
        self.category = category; self.text = text; self.people = people; self.lat = lat; self.lng = lng
        self.accuracy = accuracy
    }

    func toJSON() -> JSONValue {
        var o: [String: JSONValue] = ["category": .string(category)]
        if let text { o["text"] = .string(text) }
        if let people { o["people"] = .int(Int64(people)) }
        if let lat { o["lat"] = .double(lat) }
        if let lng { o["lng"] = .double(lng) }
        if let accuracy { o["accuracy"] = .double(accuracy) }
        return .object(o)
    }

    static func fromJSON(_ v: JSONValue?) -> OwnInfo? {
        guard let v, let c = v.optString("category") else { return nil }
        return OwnInfo(category: c, text: v.optString("text"), people: v["people"]?.intValue, lat: v["lat"]?.doubleValue,
                       lng: v["lng"]?.doubleValue, accuracy: v["accuracy"]?.doubleValue)
    }
}

/// Victim-facing status of an own SOS: from `GET /sos/{id}/status`, or a `delivered` / `status_update` backend message.
public struct SosStatus: Equatable {
    public var status: String
    public var reachedResponders: Bool
    public var etaMinutes: Int?
    public var message: String?
    public var updatedAtMs: Int64

    public init(status: String, reachedResponders: Bool, etaMinutes: Int? = nil, message: String? = nil, updatedAtMs: Int64) {
        self.status = status; self.reachedResponders = reachedResponders; self.etaMinutes = etaMinutes
        self.message = message; self.updatedAtMs = updatedAtMs
    }

    func toJSON() -> JSONValue {
        var o: [String: JSONValue] = ["status": .string(status), "reached": .bool(reachedResponders), "at": .int(updatedAtMs)]
        if let etaMinutes { o["eta"] = .int(Int64(etaMinutes)) }
        if let message { o["message"] = .string(message) }
        return .object(o)
    }

    static func fromJSON(_ v: JSONValue?) -> SosStatus? {
        guard let v, let s = v.optString("status") else { return nil }
        return SosStatus(status: s, reachedResponders: v["reached"]?.boolValue ?? false, etaMinutes: v["eta"]?.intValue,
                         message: v.optString("message"), updatedAtMs: Int64(v["at"]?.intValue ?? 0))
    }
}

public struct StoredMessage: Equatable, Identifiable {
    public var id: String
    /// The envelope exactly as received (or as created, with hop_count 0, for our own messages).
    public var envelope: MeshEnvelope
    public var receivedAt: Int64
    public var uploaded: Bool
    public var isOwn: Bool
    public var fromPeer: String?
    public var own: OwnInfo?
    public var serverStatus: SosStatus?
    /// Server rejection reason from the last batch result, if the upload was rejected (not retried).
    public var rejectedReason: String?
    /// Peers an own message was handed to at creation time.
    public var sentToPeers: Int

    public init(id: String, envelope: MeshEnvelope, receivedAt: Int64, uploaded: Bool = false, isOwn: Bool = false,
                fromPeer: String? = nil, own: OwnInfo? = nil, serverStatus: SosStatus? = nil, rejectedReason: String? = nil,
                sentToPeers: Int = 0) {
        self.id = id; self.envelope = envelope; self.receivedAt = receivedAt; self.uploaded = uploaded
        self.isOwn = isOwn; self.fromPeer = fromPeer; self.own = own; self.serverStatus = serverStatus
        self.rejectedReason = rejectedReason; self.sentToPeers = sentToPeers
    }

    public var canForward: Bool { envelope.canForward }
    public var tier: Tier { envelope.tierValue ?? .normal }
    public var expiresAtMs: Int64 { envelope.expiresAtMs }

    func toJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(id), "envelope": envelope.toJSON(), "received_at": .int(receivedAt),
            "uploaded": .bool(uploaded), "is_own": .bool(isOwn), "sent_to": .int(Int64(sentToPeers)),
        ]
        if let fromPeer { o["from_peer"] = .string(fromPeer) }
        if let own { o["own"] = own.toJSON() }
        if let serverStatus { o["status"] = serverStatus.toJSON() }
        if let rejectedReason { o["rejected"] = .string(rejectedReason) }
        return .object(o)
    }

    static func fromJSON(_ v: JSONValue) -> StoredMessage? {
        guard let id = v.optString("id"), let env = v["envelope"].flatMap(MeshEnvelope.fromJSON), let at = v["received_at"]?.intValue
        else { return nil }
        return StoredMessage(id: id, envelope: env, receivedAt: Int64(at), uploaded: v["uploaded"]?.boolValue ?? false,
                             isOwn: v["is_own"]?.boolValue ?? false, fromPeer: v.optString("from_peer"),
                             own: OwnInfo.fromJSON(v["own"]), serverStatus: SosStatus.fromJSON(v["status"]),
                             rejectedReason: v.optString("rejected"), sentToPeers: v["sent_to"]?.intValue ?? 0)
    }
}

/// A backend-signed message or receipt held for relaying (and, when it concerns us, for display).
public struct StoredBackend: Equatable, Identifiable {
    public enum Payload: Equatable {
        case message(BackendMessage)
        case receipt(DeliveredReceipt)
    }

    /// Dedupe key: the message id, or "receipt:<sos id>" (a receipt id is the SOS id).
    public var id: String
    public var payload: Payload
    public var receivedAt: Int64
    public var expiresAtMs: Int64
    /// Signature checked against the backend signing key. Unverified items are relayed but never shown as truth.
    public var verified: Bool
    /// The item concerned one of our SOS / check-ins and has been applied to it.
    public var addressedToMe: Bool
    /// Check-in requests only: the user has replied.
    public var answered: Bool

    public init(id: String, payload: Payload, receivedAt: Int64, expiresAtMs: Int64, verified: Bool,
                addressedToMe: Bool = false, answered: Bool = false) {
        self.id = id; self.payload = payload; self.receivedAt = receivedAt; self.expiresAtMs = expiresAtMs
        self.verified = verified; self.addressedToMe = addressedToMe; self.answered = answered
    }

    public var canForward: Bool {
        switch payload {
        case .message(let m): return m.canForward
        case .receipt(let r): return r.canForward
        }
    }

    public var sosId: String {
        switch payload {
        case .message(let m): return m.sosId
        case .receipt(let r): return r.id
        }
    }

    public func forwardedJSON(by relayId: String) -> Data {
        switch payload {
        case .message(let m): return m.forwarded(by: relayId).toJSON().serializedData()
        case .receipt(let r): return r.forwarded(by: relayId).toJSON().serializedData()
        }
    }

    func toJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(id), "received_at": .int(receivedAt), "expires_at_ms": .int(expiresAtMs),
            "verified": .bool(verified), "mine": .bool(addressedToMe), "answered": .bool(answered),
        ]
        switch payload {
        case .message(let m): o["message"] = m.toJSON()
        case .receipt(let r): o["receipt"] = r.toJSON()
        }
        return .object(o)
    }

    static func fromJSON(_ v: JSONValue) -> StoredBackend? {
        guard let id = v.optString("id"), let at = v["received_at"]?.intValue, let exp = v["expires_at_ms"]?.intValue else { return nil }
        let payload: Payload
        if let m = v["message"].flatMap(BackendMessage.fromJSON) { payload = .message(m) }
        else if let r = v["receipt"].flatMap(DeliveredReceipt.fromJSON) { payload = .receipt(r) }
        else { return nil }
        return StoredBackend(id: id, payload: payload, receivedAt: Int64(at), expiresAtMs: Int64(exp),
                             verified: v["verified"]?.boolValue ?? false, addressedToMe: v["mine"]?.boolValue ?? false,
                             answered: v["answered"]?.boolValue ?? false)
    }
}

public protocol MessageStore: AnyObject {
    func contains(_ id: String) -> Bool
    func save(_ message: StoredMessage)
    func all() -> [StoredMessage]
    func markUploaded(_ id: String)
    func update(_ id: String, _ change: (inout StoredMessage) -> Void)
    func containsBackend(_ id: String) -> Bool
    func saveBackend(_ item: StoredBackend)
    func allBackend() -> [StoredBackend]
    func updateBackend(_ id: String, _ change: (inout StoredBackend) -> Void)
    func deleteExpired(nowMs: Int64)
}

public final class InMemoryMessageStore: MessageStore {
    private var messages: [String: StoredMessage] = [:]
    private var backend: [String: StoredBackend] = [:]
    public init() {}

    public func contains(_ id: String) -> Bool { messages[id] != nil }
    public func save(_ message: StoredMessage) { messages[message.id] = message }
    public func all() -> [StoredMessage] { messages.values.sorted { ($0.receivedAt, $0.id) < ($1.receivedAt, $1.id) } }
    public func markUploaded(_ id: String) { messages[id]?.uploaded = true }
    public func update(_ id: String, _ change: (inout StoredMessage) -> Void) {
        guard var m = messages[id] else { return }
        change(&m)
        messages[id] = m
    }
    public func containsBackend(_ id: String) -> Bool { backend[id] != nil }
    public func saveBackend(_ item: StoredBackend) { backend[item.id] = item }
    public func allBackend() -> [StoredBackend] { backend.values.sorted { ($0.receivedAt, $0.id) < ($1.receivedAt, $1.id) } }
    public func updateBackend(_ id: String, _ change: (inout StoredBackend) -> Void) {
        guard var b = backend[id] else { return }
        change(&b)
        backend[id] = b
    }
    public func deleteExpired(nowMs: Int64) {
        messages = messages.filter { $0.value.expiresAtMs >= nowMs }
        backend = backend.filter { $0.value.expiresAtMs >= nowMs }
    }
}

/// Small JSON-file store. A hackathon mesh holds tens of messages, so rewriting the file is fine.
///
/// File format v2: `{"version":2,"messages":[...],"backend":[...]}`. The v1 file was a bare JSON array of
/// pre-contract envelopes; it is moved aside to `<name>.v1.bak` and ignored (those messages cannot be uploaded
/// to the contract API anyway). Individual rows that fail to decode are skipped, never fatal.
public final class FileMessageStore: MessageStore {
    public static let formatVersion = 2

    private let url: URL
    private let memory = InMemoryMessageStore()

    public init(url: URL) {
        self.url = url
        guard let data = try? Data(contentsOf: url), let root = JSONValue.parse(data) else { return }
        if root.objectValue == nil {
            // legacy v1 array (or garbage): keep a backup, start clean
            try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("v1.bak"))
            return
        }
        guard root["version"]?.intValue == Self.formatVersion else { return }
        root["messages"]?.arrayValue?.compactMap(StoredMessage.fromJSON).forEach(memory.save)
        root["backend"]?.arrayValue?.compactMap(StoredBackend.fromJSON).forEach(memory.saveBackend)
    }

    public static func defaultStore() -> FileMessageStore {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return FileMessageStore(url: dir.appendingPathComponent("beacon-mesh-messages.json"))
    }

    public func contains(_ id: String) -> Bool { memory.contains(id) }
    public func save(_ message: StoredMessage) { memory.save(message); flush() }
    public func all() -> [StoredMessage] { memory.all() }
    public func markUploaded(_ id: String) { memory.markUploaded(id); flush() }
    public func update(_ id: String, _ change: (inout StoredMessage) -> Void) { memory.update(id, change); flush() }
    public func containsBackend(_ id: String) -> Bool { memory.containsBackend(id) }
    public func saveBackend(_ item: StoredBackend) { memory.saveBackend(item); flush() }
    public func allBackend() -> [StoredBackend] { memory.allBackend() }
    public func updateBackend(_ id: String, _ change: (inout StoredBackend) -> Void) { memory.updateBackend(id, change); flush() }
    public func deleteExpired(nowMs: Int64) { memory.deleteExpired(nowMs: nowMs); flush() }

    private func flush() {
        let root = JSONValue.object([
            "version": .int(Int64(Self.formatVersion)),
            "messages": .array(memory.all().map { $0.toJSON() }),
            "backend": .array(memory.allBackend().map { $0.toJSON() }),
        ])
        let data = root.serializedData()
        #if os(iOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: .atomic)
        #endif
    }
}
