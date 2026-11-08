import Foundation

/// Constants shared with Android. Wire format = the Beacon API contract (openapi.yaml, server/docs/crypto.md).
public enum MeshProtocol {
    public static let version = 2
    public static let serviceUUID = "B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC"
    public static let rxCharacteristicUUID = "B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC"
    /// Read-only: the 16 raw bytes of the phone's persistent instance UUID (see `InstanceId`).
    public static let idCharacteristicUUID = InstanceId.characteristicUUID

    public static let hardMaxHops = 10
    public static let hardMaxTtlMs: Int64 = 24 * 3_600_000
    /// Relay-side tolerance for a creator's clock being ahead of ours.
    public static let maxClockSkewMs: Int64 = 10 * 60_000
    /// Server tolerance on `expires_at - created_at` above the tier TTL.
    public static let ttlSkewMs: Int64 = 5 * 60_000
    /// Backend-originated messages (receipts, check-in requests, status updates).
    public static let backendMaxHops = 5
    public static let backendTtlMs: Int64 = 6 * 3_600_000
    /// `DeviceRegister.platform` is an enum (android, ios) in openapi.yaml and in the server's validator.
    public static let devicePlatform = "ios"
}

/// Tiers of the contract (`Tier`). Defaults mirror the hop table in openapi.yaml; /server-info may override them.
public enum Tier: String, CaseIterable, Codable {
    case critical, high, normal, safe, heartbeat

    public var maxHops: Int {
        switch self {
        case .critical: return 10
        case .high: return 7
        case .normal: return 5
        case .safe: return 3
        case .heartbeat: return 2
        }
    }

    public var ttlMs: Int64 {
        switch self {
        case .critical: return 24 * 3_600_000
        case .high: return 12 * 3_600_000
        case .normal: return 6 * 3_600_000
        case .safe: return 3 * 3_600_000
        case .heartbeat: return 30 * 60_000
        }
    }

    /// Lower sorts first: critical messages are relayed before anything else.
    public var rank: Int {
        switch self {
        case .critical: return 0
        case .high: return 1
        case .normal: return 2
        case .safe: return 3
        case .heartbeat: return 4
        }
    }
}

public typealias Priority = Tier

public enum EnvelopeKind: String, CaseIterable {
    case sos, checkinReply = "checkin_reply", safe, offer, heartbeat
}

/// Hop table in force on this phone: contract defaults, replaced by server-provided values once cached.
public struct HopLimits: Equatable {
    private let rows: [Tier: (maxHops: Int, ttlMs: Int64)]

    public init(rows: [Tier: (maxHops: Int, ttlMs: Int64)] = [:]) { self.rows = rows }

    public static let `default` = HopLimits()

    public func maxHops(_ t: Tier) -> Int { rows[t]?.maxHops ?? t.maxHops }
    public func ttlMs(_ t: Tier) -> Int64 { rows[t]?.ttlMs ?? t.ttlMs }

    public static func == (a: HopLimits, b: HopLimits) -> Bool {
        Tier.allCases.allSatisfy { a.maxHops($0) == b.maxHops($0) && a.ttlMs($0) == b.ttlMs($0) }
    }

    public func toJSON() -> JSONValue {
        .array(Tier.allCases.map { t in
            .object(["tier": .string(t.rawValue), "max_hops": .int(Int64(maxHops(t))), "ttl_seconds": .int(ttlMs(t) / 1000)])
        })
    }

    /// Parses `hop_limits` from /server-info. Bad rows are ignored.
    public static func fromJSON(_ v: JSONValue?) -> HopLimits {
        guard let list = v?.arrayValue else { return .default }
        var m: [Tier: (maxHops: Int, ttlMs: Int64)] = [:]
        for row in list {
            guard let t = row.optString("tier").flatMap(Tier.init(rawValue:)),
                  let hops = row["max_hops"]?.intValue, let ttl = row["ttl_seconds"]?.intValue,
                  (1...MeshProtocol.hardMaxHops).contains(hops), ttl > 0 else { continue }
            m[t] = (hops, Int64(ttl) * 1000)
        }
        return HopLimits(rows: m)
    }
}

/// What the user picks in the UI. `apiCategory` is the contract `Category`; `kind` the envelope kind.
/// `medical` is sent as `injured`, `water_meds` as `need_water_meds`. The un-prompted `checkin` is a normal-tier `sos`
/// with category `other` (a `checkin_reply` envelope needs a backend check-in id).
public enum Category: String, Codable, CaseIterable {
    case trapped, injured, medical
    case waterMeds = "water_meds"
    case checkin, safe, other

    public var tier: Tier {
        switch self {
        case .trapped, .injured, .medical: return .critical
        case .waterMeds: return .high
        case .checkin, .other: return .normal
        case .safe: return .safe
        }
    }

    public var priority: Tier { tier }

    public var kind: EnvelopeKind { self == .safe ? .safe : .sos }

    public var apiCategory: String {
        switch self {
        case .trapped: return "trapped"
        case .injured, .medical: return "injured"
        case .waterMeds: return "need_water_meds"
        case .checkin, .other: return "other"
        case .safe: return "safe"
        }
    }

    /// Reverse of `apiCategory` for display of received/own messages.
    public static func fromWire(_ s: String?) -> Category? {
        guard let s else { return nil }
        if let c = Category(rawValue: s) { return c }
        switch s {
        case "need_water_meds": return .waterMeds
        default: return nil
        }
    }
}

// MARK: - Routing

/// Builds the `routing` block: approx = centre of the ~1 km grid cell (0.01 degree), radius 1000 m.
/// Mirrors server/src/testing/envelope.ts so the signed JSON numbers print identically in JavaScript.
public enum Routing {
    /// `Math.round(n * 1e5) / 1e5` of `floor(v * 100) / 100 + 0.005`.
    public static func cell(_ v: Double) -> Double {
        let c = (v * 100).rounded(.down) / 100 + 0.005
        return (c * 1e5 + 0.5).rounded(.down) / 1e5
    }

    public static func build(lat: Double, lng: Double, category: String?) -> JSONValue {
        var o: [String: JSONValue] = [
            "approx": .object(["lat": .double(cell(lat)), "lng": .double(cell(lng)), "radius_m": .int(1000)]),
        ]
        if let category { o["category"] = .string(category) }
        return .object(o)
    }
}

// MARK: - Envelope

/// The contract's `MeshEnvelope`. `routing` is kept as received (it is part of the signed bytes).
public struct MeshEnvelope: Equatable {
    public var id: String
    public var senderKeyId: String
    public var senderPublicKey: String?
    public var kind: String
    public var tier: String
    public var maxHops: Int
    public var hopCount: Int
    public var hopPath: [String]
    public var expiresAt: String
    public var createdAt: String
    public var routing: JSONValue
    /// Base64 ECIES ciphertext of the `MeshPayload` JSON.
    public var payload: String
    /// Base64 DER ECDSA P-256 / SHA-256 signature over `signedPart()`.
    public var signature: String

    public init(id: String, senderKeyId: String, senderPublicKey: String?, kind: String, tier: String, maxHops: Int,
                hopCount: Int = 0, hopPath: [String] = [], expiresAt: String, createdAt: String, routing: JSONValue,
                payload: String, signature: String) {
        self.id = id; self.senderKeyId = senderKeyId; self.senderPublicKey = senderPublicKey; self.kind = kind
        self.tier = tier; self.maxHops = maxHops; self.hopCount = hopCount; self.hopPath = hopPath
        self.expiresAt = expiresAt; self.createdAt = createdAt; self.routing = routing; self.payload = payload
        self.signature = signature
    }

    public var tierValue: Tier? { Tier(rawValue: tier) }
    public var expiresAtMs: Int64 { Iso.parse(expiresAt) ?? 0 }
    public var createdAtMs: Int64 { Iso.parse(createdAt) ?? 0 }
    public var category: String? { routing["category"]?.stringValue }
    public var canForward: Bool { hopCount < maxHops }

    /// Canonical JSON of {id, sender_key_id, kind, tier, max_hops, expires_at, created_at, routing, payload}
    /// (server `envelopeSignedPart`). `hop_count`, `hop_path`, `sender_public_key` and `signature` are not signed.
    public func signedPart() throws -> String {
        try Self.signedPart(id: id, senderKeyId: senderKeyId, kind: kind, tier: tier, maxHops: maxHops,
                            expiresAt: expiresAt, createdAt: createdAt, routing: routing, payload: payload)
    }

    public static func signedPart(id: String, senderKeyId: String, kind: String, tier: String, maxHops: Int,
                                  expiresAt: String, createdAt: String, routing: JSONValue, payload: String) throws -> String {
        try JSONValue.object([
            "id": .string(id), "sender_key_id": .string(senderKeyId), "kind": .string(kind), "tier": .string(tier),
            "max_hops": .int(Int64(maxHops)), "expires_at": .string(expiresAt), "created_at": .string(createdAt),
            "routing": routing, "payload": .string(payload),
        ]).canonical()
    }

    /// The copy a transmitter sends: hop_count + 1 and its own relay ID appended.
    public func forwarded(by relayId: String) -> MeshEnvelope {
        var e = self
        e.hopCount += 1
        e.hopPath.append(relayId)
        return e
    }

    public func toJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(id), "sender_key_id": .string(senderKeyId), "kind": .string(kind), "tier": .string(tier),
            "max_hops": .int(Int64(maxHops)), "hop_count": .int(Int64(hopCount)),
            "hop_path": .array(hopPath.map(JSONValue.string)), "expires_at": .string(expiresAt),
            "created_at": .string(createdAt), "routing": routing, "payload": .string(payload), "signature": .string(signature),
        ]
        if let senderPublicKey { o["sender_public_key"] = .string(senderPublicKey) }
        return .object(o)
    }

    public func toBytes() -> Data { toJSON().serializedData() }

    public static func fromJSON(_ o: JSONValue) -> MeshEnvelope? {
        guard let id = o.optString("id"), let sk = o.optString("sender_key_id"), let kind = o.optString("kind"),
              let tier = o.optString("tier"), let maxHops = o["max_hops"]?.intValue, let hc = o["hop_count"]?.intValue,
              let exp = o.optString("expires_at"), let cre = o.optString("created_at"),
              let routing = o["routing"], routing.objectValue != nil,
              let payload = o.optString("payload"), let sig = o.optString("signature")
        else { return nil }
        return MeshEnvelope(id: id, senderKeyId: sk, senderPublicKey: o.optString("sender_public_key"), kind: kind,
                            tier: tier, maxHops: maxHops, hopCount: hc, hopPath: stringList(o["hop_path"]),
                            expiresAt: exp, createdAt: cre, routing: routing, payload: payload, signature: sig)
    }

    public static func decode(_ data: Data) -> MeshEnvelope? { JSONValue.parse(data).flatMap(fromJSON) }
}

func stringList(_ v: JSONValue?) -> [String] { v?.arrayValue?.compactMap(\.stringValue) ?? [] }

// MARK: - Backend messages

/// The contract's `BackendMessage`: delivered | checkin_request | status_update, signed by the backend.
public struct BackendMessage: Equatable {
    public static let kinds: Set<String> = ["delivered", "checkin_request", "status_update"]

    public var id: String
    public var kind: String
    public var sosId: String
    public var checkinId: String?
    public var body: JSONValue
    public var maxHops: Int
    public var hopCount: Int
    public var hopPath: [String]
    public var expiresAt: String
    public var createdAt: String
    public var signature: String

    public init(id: String, kind: String, sosId: String, checkinId: String?, body: JSONValue, maxHops: Int,
                hopCount: Int = 0, hopPath: [String] = [], expiresAt: String, createdAt: String, signature: String) {
        self.id = id; self.kind = kind; self.sosId = sosId; self.checkinId = checkinId; self.body = body
        self.maxHops = maxHops; self.hopCount = hopCount; self.hopPath = hopPath; self.expiresAt = expiresAt
        self.createdAt = createdAt; self.signature = signature
    }

    public var expiresAtMs: Int64 { Iso.parse(expiresAt) ?? 0 }
    public var canForward: Bool { hopCount < maxHops }

    /// Canonical JSON of {id, kind, sos_id, checkin_id (null when absent), body, max_hops, expires_at, created_at}.
    public func signedPart() throws -> String {
        try JSONValue.object([
            "id": .string(id), "kind": .string(kind), "sos_id": .string(sosId),
            "checkin_id": checkinId.map(JSONValue.string) ?? .null, "body": body,
            "max_hops": .int(Int64(maxHops)), "expires_at": .string(expiresAt), "created_at": .string(createdAt),
        ]).canonical()
    }

    public func forwarded(by relayId: String) -> BackendMessage {
        var m = self
        m.hopCount += 1
        m.hopPath.append(relayId)
        return m
    }

    public func toJSON() -> JSONValue {
        .object([
            "id": .string(id), "kind": .string(kind), "sos_id": .string(sosId),
            "checkin_id": checkinId.map(JSONValue.string) ?? .null, "body": body,
            "max_hops": .int(Int64(maxHops)), "hop_count": .int(Int64(hopCount)),
            "hop_path": .array(hopPath.map(JSONValue.string)), "expires_at": .string(expiresAt),
            "created_at": .string(createdAt), "signature": .string(signature),
        ])
    }

    public static func fromJSON(_ o: JSONValue) -> BackendMessage? {
        guard let id = o.optString("id"), let kind = o.optString("kind"), kinds.contains(kind),
              let sos = o.optString("sos_id"), let maxHops = o["max_hops"]?.intValue,
              let exp = o.optString("expires_at"), let cre = o.optString("created_at"), let sig = o.optString("signature")
        else { return nil }
        return BackendMessage(id: id, kind: kind, sosId: sos, checkinId: o.optString("checkin_id"),
                              body: o["body"]?.objectValue != nil ? o["body"]! : .object([:]), maxHops: maxHops,
                              hopCount: o["hop_count"]?.intValue ?? 0, hopPath: stringList(o["hop_path"]),
                              expiresAt: exp, createdAt: cre, signature: sig)
    }
}

/// The contract's `DeliveredReceipt`; travels the mesh like a backend message. TTL = 6 h from first sight.
public struct DeliveredReceipt: Equatable {
    public var id: String
    public var deliveredAt: String
    public var maxHops: Int
    public var hopCount: Int
    public var hopPath: [String]
    public var signature: String

    public init(id: String, deliveredAt: String, maxHops: Int = 5, hopCount: Int = 0, hopPath: [String] = [], signature: String) {
        self.id = id; self.deliveredAt = deliveredAt; self.maxHops = maxHops; self.hopCount = hopCount
        self.hopPath = hopPath; self.signature = signature
    }

    public var canForward: Bool { hopCount < maxHops }

    /// Canonical JSON of {id, delivered_at, max_hops: 5} (`max_hops` is a constant in the signed part).
    public func signedPart() throws -> String {
        try JSONValue.object(["id": .string(id), "delivered_at": .string(deliveredAt), "max_hops": .int(5)]).canonical()
    }

    public func forwarded(by relayId: String) -> DeliveredReceipt {
        var r = self
        r.hopCount += 1
        r.hopPath.append(relayId)
        return r
    }

    public func toJSON() -> JSONValue {
        .object(["id": .string(id), "delivered_at": .string(deliveredAt), "max_hops": .int(Int64(maxHops)),
                 "hop_count": .int(Int64(hopCount)), "hop_path": .array(hopPath.map(JSONValue.string)),
                 "signature": .string(signature)])
    }

    public static func fromJSON(_ o: JSONValue) -> DeliveredReceipt? {
        guard let id = o.optString("id"), let at = o.optString("delivered_at"), let sig = o.optString("signature"),
              let mh = o["max_hops"]?.intValue else { return nil }
        return DeliveredReceipt(id: id, deliveredAt: at, maxHops: mh, hopCount: o["hop_count"]?.intValue ?? 0,
                                hopPath: stringList(o["hop_path"]), signature: sig)
    }
}

/// One decoded BLE frame payload. All three travel as JSON objects in frame type 0x01; they are told apart by shape.
public enum MeshWire {
    case envelope(MeshEnvelope)
    case backendMessage(BackendMessage)
    case receipt(DeliveredReceipt)

    public static func decode(_ data: Data) -> MeshWire? {
        guard let json = JSONValue.parse(data), json.objectValue != nil else { return nil }
        if json["sender_key_id"] != nil { return MeshEnvelope.fromJSON(json).map(MeshWire.envelope) }
        if json["delivered_at"] != nil { return DeliveredReceipt.fromJSON(json).map(MeshWire.receipt) }
        if json["sos_id"] != nil { return BackendMessage.fromJSON(json).map(MeshWire.backendMessage) }
        return nil
    }
}

// MARK: - Payloads

/// Plaintext inside `MeshEnvelope.payload` (openapi `MeshPayload`).
public enum MeshPayload {
    /// `profileSummary`: openapi `ProfileSummary` (see `ProfileSummary.build`), added for kind sos/safe only.
    public static func sos(category: Category, text: String?, lat: Double, lng: Double, accuracy: Double?,
                           people: Int?, profileSummary: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = [
            "lat": .double(lat), "lng": .double(lng), "category": .string(category.apiCategory),
        ]
        if let accuracy, accuracy >= 0 { o["accuracy_m"] = .double((accuracy * 10).rounded() / 10) }
        if let text, !text.isEmpty { o["text"] = .string(String(text.prefix(1000))) }
        if let people, people >= 1 { o["people_count"] = .int(Int64(people)) }
        if category == .trapped { o["trapped"] = .bool(true) }
        if category == .injured || category == .medical { o["injured"] = .bool(true) }
        if let profileSummary { o["profile_summary"] = profileSummary }
        return .object(o)
    }

    public static func checkinReply(checkinId: String, response: String, text: String?) -> JSONValue {
        var o: [String: JSONValue] = ["checkin_id": .string(checkinId), "response": .string(response)]
        if let text, !text.isEmpty { o["text"] = .string(String(text.prefix(1000))) }
        return .object(o)
    }

    public static func heartbeat(sentAtMs: Int64, lat: Double, lng: Double, batteryPct: Int?, charging: Bool?,
                                 moving: Bool?, seq: Int) -> JSONValue {
        .object(["heartbeat": heartbeatBody(sentAtMs: sentAtMs, lat: lat, lng: lng, batteryPct: batteryPct,
                                            charging: charging, moving: moving, seq: seq)])
    }

    /// openapi `HeartbeatCreate` (also the body of POST /heartbeats).
    public static func heartbeatBody(sentAtMs: Int64, lat: Double, lng: Double, batteryPct: Int?, charging: Bool?,
                                     moving: Bool?, seq: Int) -> JSONValue {
        var hb: [String: JSONValue] = [
            "sent_at": .string(Iso.format(sentAtMs)),
            "approx": .object(["lat": .double(Routing.cell(lat)), "lng": .double(Routing.cell(lng)), "radius_m": .int(1000)]),
            "seq": .int(Int64(seq)),
        ]
        if let batteryPct { hb["battery_pct"] = .int(Int64(min(max(batteryPct, 0), 100))) }
        if let charging { hb["charging"] = .bool(charging) }
        if let moving { hb["moving"] = .bool(moving) }
        return .object(hb)
    }
}

public enum DropReason: String, Equatable {
    case malformed, duplicate, badSignature, expired, hopLimit, pathMismatch, limits
}

public enum MeshValidation {
    /// Everything except the duplicate check (which needs the store).
    /// `publicKeyDER` is the sender key when the relay knows it (inline `sender_public_key`, or a key used as `sender_key_id`).
    /// A registered device id without an inline key cannot be verified by a relay; the server does that.
    public static func validate(_ env: MeshEnvelope, limits: HopLimits, nowMs: Int64) -> DropReason? {
        guard let tier = env.tierValue, EnvelopeKind(rawValue: env.kind) != nil,
              Uuid7.isUUID(env.id), !env.senderKeyId.isEmpty,
              env.routing["approx"]?.objectValue != nil,
              Data(base64Encoded: env.payload) != nil, let sig = Data(base64Encoded: env.signature),
              let created = Iso.parse(env.createdAt), let expires = Iso.parse(env.expiresAt)
        else { return .malformed }
        if (env.kind == EnvelopeKind.heartbeat.rawValue) != (tier == .heartbeat) { return .limits }
        if let key = senderKeyDER(env) {
            guard let part = try? env.signedPart(),
                  MeshCrypto.verify(publicKeyDER: key, data: Data(part.utf8), signatureDER: sig)
            else { return .badSignature }
        } else if !Uuid7.isUUID(env.senderKeyId) {
            return .badSignature   // not a UUID, not a key
        }
        if nowMs > expires { return .expired }
        if env.maxHops < 1 || env.maxHops > min(limits.maxHops(tier), MeshProtocol.hardMaxHops) { return .limits }
        let ttl = expires - created
        if ttl <= 0 || ttl > limits.ttlMs(tier) + MeshProtocol.ttlSkewMs { return .limits }
        if created > nowMs + MeshProtocol.maxClockSkewMs { return .limits }
        if env.hopCount < 1 || env.hopCount > env.maxHops { return .hopLimit }
        if env.hopCount != env.hopPath.count { return .pathMismatch }
        return nil
    }

    /// The sender's SPKI DER if the envelope carries it (or uses it as `sender_key_id`).
    public static func senderKeyDER(_ env: MeshEnvelope) -> Data? {
        if let k = env.senderPublicKey, let d = Data(base64Encoded: k) { return d }
        if !Uuid7.isUUID(env.senderKeyId), let d = Data(base64Encoded: env.senderKeyId) { return d }
        return nil
    }

    /// Hop/expiry checks shared by receipts and backend messages.
    public static func hopsOk(hopCount: Int, maxHops: Int, pathCount: Int) -> DropReason? {
        if maxHops < 1 || maxHops > MeshProtocol.hardMaxHops { return .limits }
        if hopCount < 1 || hopCount > maxHops { return .hopLimit }
        if hopCount != pathCount { return .pathMismatch }
        return nil
    }
}
