import Foundation

/// Tiny persistence seam so the logic runs in tests without UserDefaults / Keychain.
public protocol KeyValueStore: AnyObject {
    func string(_ key: String) -> String?
    func setString(_ key: String, _ value: String?)
    func int(_ key: String) -> Int64
    func setInt(_ key: String, _ value: Int64)
}

public final class MemoryKeyValueStore: KeyValueStore {
    private var m: [String: Any] = [:]
    public init() {}
    public func string(_ key: String) -> String? { m[key] as? String }
    public func setString(_ key: String, _ value: String?) { m[key] = value }
    public func int(_ key: String) -> Int64 { (m[key] as? Int64) ?? 0 }
    public func setInt(_ key: String, _ value: Int64) { m[key] = value }
}

public final class UserDefaultsKeyValueStore: KeyValueStore {
    private let defaults: UserDefaults
    private let prefix: String
    public init(defaults: UserDefaults = .standard, prefix: String = "beacon.backend.") {
        self.defaults = defaults
        self.prefix = prefix
    }
    public func string(_ key: String) -> String? { defaults.string(forKey: prefix + key) }
    public func setString(_ key: String, _ value: String?) {
        if let value { defaults.set(value, forKey: prefix + key) } else { defaults.removeObject(forKey: prefix + key) }
    }
    public func int(_ key: String) -> Int64 { Int64(defaults.integer(forKey: prefix + key)) }
    public func setInt(_ key: String, _ value: Int64) { defaults.set(Int(value), forKey: prefix + key) }
}

public enum KeyStatus: String, Equatable {
    /// No backend encryption key at all: the app refuses to create messages (never sends plaintext).
    case none
    /// Using the key baked into the build (Info.plist BEACON_ENC_PUBLIC_KEY).
    case builtIn
    /// Using the key cached from GET /v1/server-info.
    case cached
}

/// Parsed `GET /v1/server-info`.
public struct ServerInfo: Equatable {
    public var serverTimeMs: Int64?
    public var encryptionPublicKey: String?
    public var signingPublicKey: String?
    public var hopLimits: HopLimits
    public var eventActive: Bool
    public var eventName: String?
    public var checkinIntervalSeconds: Int?
    public var heartbeatIntervalSeconds: Int?
    public var silenceThresholdSeconds: Int?
    public var gatewayUploadMaxBatch: Int?
    /// `profile_required` (nil when the server did not say) and `profile_consent_version`.
    public var profileRequired: Bool?
    public var profileConsentVersion: String?

    public static func fromJSON(_ o: JSONValue) -> ServerInfo {
        func pos(_ k: String) -> Int? { o[k]?.intValue.flatMap { $0 > 0 ? $0 : nil } }
        func nonBlank(_ k: String) -> String? {
            o.optString(k).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        }
        let event = o["event"]
        return ServerInfo(
            serverTimeMs: o.optString("server_time").flatMap(Iso.parse),
            encryptionPublicKey: nonBlank("encryption_public_key"),
            signingPublicKey: nonBlank("signing_public_key"),
            hopLimits: HopLimits.fromJSON(o["hop_limits"]),
            eventActive: event?.objectValue != nil,
            eventName: event?.optString("name"),
            checkinIntervalSeconds: pos("checkin_interval_seconds"),
            heartbeatIntervalSeconds: pos("heartbeat_interval_seconds"),
            silenceThresholdSeconds: pos("silence_threshold_seconds"),
            gatewayUploadMaxBatch: pos("gateway_upload_max_batch"),
            profileRequired: o["profile_required"]?.boolValue,
            profileConsentVersion: nonBlank("profile_consent_version"))
    }
}

/// Everything the phone knows about the backend: keys (cached from /server-info, with a build-time fallback),
/// hop table, heartbeat settings, event state and its own device registration.
public final class BackendConfig {
    public static let defaultHeartbeatSeconds = 300
    public static let defaultBatch = 500

    private let kv: KeyValueStore
    private let builtInEnc: String
    private let builtInSign: String

    public init(store: KeyValueStore, builtInEncryptionKey: String = "", builtInSigningKey: String = "") {
        kv = store
        builtInEnc = builtInEncryptionKey
        builtInSign = builtInSigningKey
    }

    private func valid(_ b64: String?) -> String? {
        guard let t = b64?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty,
              let der = Data(base64Encoded: t), MeshCrypto.isValidP256SPKI(der) else { return nil }
        return t
    }

    /// Base64 SPKI of the backend encryption key, or nil when none is available.
    public var encryptionKey: String? { valid(kv.string("enc_key")) ?? valid(builtInEnc) }
    public var signingKey: String? { valid(kv.string("sign_key")) ?? valid(builtInSign) }

    public var encryptionKeyStatus: KeyStatus {
        if valid(kv.string("enc_key")) != nil { return .cached }
        return valid(builtInEnc) != nil ? .builtIn : .none
    }
    public var signingKeyStatus: KeyStatus {
        if valid(kv.string("sign_key")) != nil { return .cached }
        return valid(builtInSign) != nil ? .builtIn : .none
    }

    public var hopLimits: HopLimits {
        guard let s = kv.string("hops"), let v = JSONValue.parse(s) else { return .default }
        return HopLimits.fromJSON(v)
    }

    public var heartbeatIntervalSeconds: Int {
        let v = Int(kv.int("hb_interval"))
        return v > 0 ? v : Self.defaultHeartbeatSeconds
    }
    public var silenceThresholdSeconds: Int { Int(kv.int("silence")) }
    public var maxBatch: Int { min(max(Int(kv.int("batch")) == 0 ? Self.defaultBatch : Int(kv.int("batch")), 1), 500) }
    public var eventActive: Bool { kv.int("event_active") == 1 }
    public var lastInfoAtMs: Int64 { kv.int("info_at") }
    /// From the last /server-info: nil = never learned (treated as required by the UI).
    public var profileRequired: Bool? { kv.int("profile_required") == 0 ? nil : kv.int("profile_required") == 1 ? true : false }
    public var profileConsentVersion: String? { kv.string("profile_consent_version") }

    public var deviceId: String? {
        get { kv.string("device_id") }
        set { kv.setString("device_id", newValue) }
    }
    /// ISO timestamp of the newest backend message pulled from /mesh/outbox (`since=` cursor).
    public var outboxCursor: String? {
        get { kv.string("outbox_cursor") }
        set { kv.setString("outbox_cursor", newValue) }
    }
    public var lastHeartbeatAtMs: Int64 {
        get { kv.int("hb_last") }
        set { kv.setInt("hb_last", newValue) }
    }
    public var lastUploadAtMs: Int64 {
        get { kv.int("upload_last") }
        set { kv.setInt("upload_last", newValue) }
    }
    public func setEventActive(_ active: Bool) { kv.setInt("event_active", active ? 1 : 0) }
    public var heartbeatSeq: Int {
        get { Int(kv.int("hb_seq")) }
        set { kv.setInt("hb_seq", Int64(newValue)) }
    }

    /// Stores a fresh /server-info. Garbage keys are ignored so a bad response cannot lock the phone out.
    public func update(_ info: ServerInfo, nowMs: Int64) {
        if let k = valid(info.encryptionPublicKey) { kv.setString("enc_key", k) }
        if let k = valid(info.signingPublicKey) { kv.setString("sign_key", k) }
        kv.setString("hops", info.hopLimits.toJSON().serialized())
        if let v = info.heartbeatIntervalSeconds { kv.setInt("hb_interval", Int64(v)) }
        if let v = info.silenceThresholdSeconds { kv.setInt("silence", Int64(v)) }
        if let v = info.gatewayUploadMaxBatch { kv.setInt("batch", Int64(v)) }
        kv.setInt("event_active", info.eventActive ? 1 : 0)
        if let r = info.profileRequired { kv.setInt("profile_required", r ? 1 : 2) }
        if let v = info.profileConsentVersion { kv.setString("profile_consent_version", v) }
        kv.setInt("info_at", nowMs)
    }
}
