import Foundation

/// Constants shared with Android. See mesh/PROTOCOL.md.
public enum MeshProtocol {
    public static let version = 1
    public static let serviceUUID = "B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC"
    public static let rxCharacteristicUUID = "B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC"

    public static let hardMaxHops = 10
    public static let hardMaxTtlMs: Int64 = 24 * 3_600_000
    public static let maxClockSkewMs: Int64 = 10 * 60_000
}

public enum Priority: String, Codable, CaseIterable {
    case critical, high, normal, safe

    public var maxHops: Int {
        switch self {
        case .critical: return 10
        case .high: return 7
        case .normal: return 5
        case .safe: return 3
        }
    }

    public var ttlMs: Int64 {
        switch self {
        case .critical: return 24 * 3_600_000
        case .high: return 12 * 3_600_000
        case .normal: return 6 * 3_600_000
        case .safe: return 3 * 3_600_000
        }
    }

    /// Lower sorts first: critical messages are relayed before anything else.
    public var rank: Int {
        switch self {
        case .critical: return 0
        case .high: return 1
        case .normal: return 2
        case .safe: return 3
        }
    }
}

public enum MessageKind: String, Codable {
    case sos, checkin, safe
}

public enum Category: String, Codable, CaseIterable {
    case trapped, injured, medical
    case waterMeds = "water_meds"
    case checkin, safe, other

    public var priority: Priority {
        switch self {
        case .trapped, .injured, .medical: return .critical
        case .waterMeds: return .high
        case .checkin, .other: return .normal
        case .safe: return .safe
        }
    }

    public var kind: MessageKind {
        switch self {
        case .safe: return .safe
        case .checkin: return .checkin
        default: return .sos
        }
    }
}

public struct SosBody: Codable, Equatable {
    public var category: String
    public var text: String?
    public var lat: Double?
    public var lng: Double?
    public var acc: Double?
    public var people: Int?

    public init(category: String, text: String? = nil, lat: Double? = nil, lng: Double? = nil,
                acc: Double? = nil, people: Int? = nil) {
        self.category = category
        self.text = text
        self.lat = lat
        self.lng = lng
        self.acc = acc
        self.people = people
    }
}

/// The part of a message the sender signs. Serialised once; the bytes travel verbatim.
public struct SignedHeader: Codable, Equatable {
    public var v: Int
    public var id: String
    public var pub: String
    public var kind: String
    public var pri: String
    public var maxHops: Int
    public var createdAt: Int64
    public var expiresAt: Int64
    public var body: SosBody?

    public var priority: Priority { Priority(rawValue: pri) ?? .normal }

    public func encoded() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    public static func decode(_ bytes: Data) -> SignedHeader? {
        try? JSONDecoder().decode(SignedHeader.self, from: bytes)
    }
}

/// What actually goes over the air (after reassembly).
public struct Envelope: Codable, Equatable {
    public var v: Int
    /// base64 of the signed header bytes
    public var signed: String
    /// base64 DER ECDSA P-256 / SHA-256 signature
    public var sig: String
    /// number of radio transmissions so far (unsigned, relays increment)
    public var hop: Int
    /// relay IDs of each transmitter, origin first (unsigned)
    public var path: [String]

    public init(v: Int = MeshProtocol.version, signed: String, sig: String, hop: Int, path: [String]) {
        self.v = v
        self.signed = signed
        self.sig = sig
        self.hop = hop
        self.path = path
    }

    public var signedBytes: Data? { Data(base64Encoded: signed) }
    public var header: SignedHeader? { signedBytes.flatMap(SignedHeader.decode) }

    /// The copy a transmitter sends: hop + 1 and its own relay ID appended.
    public func forwarded(by relayId: String) -> Envelope {
        Envelope(v: v, signed: signed, sig: sig, hop: hop + 1, path: path + [relayId])
    }

    public func jsonData() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    public static func decode(_ data: Data) -> Envelope? {
        try? JSONDecoder().decode(Envelope.self, from: data)
    }
}

public enum DropReason: String, Equatable {
    case malformed, duplicate, badSignature, expired, hopLimit, pathMismatch, limits
}

public enum MeshValidation {
    /// Everything except the duplicate check (which needs the store).
    public static func validate(_ env: Envelope, header: SignedHeader, signedBytes: Data, nowMs: Int64) -> DropReason? {
        guard env.v == MeshProtocol.version, header.v == MeshProtocol.version else { return .malformed }
        guard let pub = Data(base64Encoded: header.pub), let sig = Data(base64Encoded: env.sig),
              MeshCrypto.verify(publicKeyDER: pub, data: signedBytes, signatureDER: sig)
        else { return .badSignature }
        if nowMs > header.expiresAt { return .expired }
        if header.maxHops < 1 || header.maxHops > MeshProtocol.hardMaxHops { return .limits }
        if header.expiresAt - header.createdAt > MeshProtocol.hardMaxTtlMs { return .limits }
        if header.createdAt > nowMs + MeshProtocol.maxClockSkewMs { return .limits }
        if env.hop < 1 || env.hop > header.maxHops { return .hopLimit }
        if env.hop != env.path.count { return .pathMismatch }
        return nil
    }
}
