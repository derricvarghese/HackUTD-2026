import Foundation

/// Tracks which BLE connection stands for which phone. Port of Android `PeerRegistry.kt`.
///
/// BLE identifiers are not identities: phones rotate private addresses and a phone that is both peripheral and central
/// shows up under several identifiers (the "ghost peer" problem). Each app install has a persistent UUID instead;
/// this registry keeps exactly one outbound link per UUID. Not thread-safe: use from the transport's (main) queue.
public final class PeerRegistry {
    public enum Decision: Equatable {
        /// This link is the one to use for `id`.
        case accept(id: String)
        /// We already have a link to this phone under another address: drop this one.
        case duplicate(id: String, existingAddress: String)
        /// The id is our own: we saw ourselves.
        case selfId
    }

    private let ownId: String
    private var order: [String] = []                 // ids in insertion order
    private var addressById: [String: String] = [:]
    private var idByAddress: [String: String] = [:]

    public init(ownId: String) { self.ownId = ownId }

    /// Number of distinct phones with an accepted outbound link.
    public var count: Int { addressById.count }
    public var ids: [String] { order }

    public func identify(address: String, id: String) -> Decision {
        if id.caseInsensitiveCompare(ownId) == .orderedSame { return .selfId }
        if let existing = addressById[id], existing != address { return .duplicate(id: id, existingAddress: existing) }
        if addressById[id] == nil { order.append(id) }
        addressById[id] = address
        idByAddress[address] = id
        return .accept(id: id)
    }

    public func addressFor(id: String) -> String? { addressById[id] }
    public func idFor(address: String) -> String? { idByAddress[address] }

    /// Forgets `address`; returns the phone id if that link was the accepted one for it.
    @discardableResult
    public func release(address: String) -> String? {
        guard let id = idByAddress.removeValue(forKey: address) else { return nil }
        if addressById[id] == address {
            addressById.removeValue(forKey: id)
            order.removeAll { $0 == id }
        }
        return id
    }

    public func clear() {
        order.removeAll()
        addressById.removeAll()
        idByAddress.removeAll()
    }

    /// Fallback identity for peers that do not expose the id characteristic (older builds).
    public static func legacyId(_ address: String) -> String { "addr:\(address)" }
}

/// The persistent per-install id and its wire encodings (16 raw bytes, RFC 4122 / big-endian order).
public enum InstanceId {
    /// GATT characteristic with the 16 raw id bytes (read-only).
    public static let characteristicUUID = "B5A10003-7E4C-4C3A-9D2F-6B8E1C0FBEAC"
    /// Frame type of the HELLO write: 0x02 followed by the sender's 16 id bytes (17 bytes in one write).
    public static let helloFrameType: UInt8 = 0x02

    public static func newId() -> String { UUID().uuidString.lowercased() }

    public static func bytes(of id: String) -> Data? {
        guard let u = UUID(uuidString: id) else { return nil }
        return withUnsafeBytes(of: u.uuid) { Data($0) }
    }

    public static func id(fromBytes data: Data) -> String? {
        guard data.count == 16 else { return nil }
        let b = [UInt8](data)
        let u = UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
        return u.uuidString.lowercased()
    }

    public static func helloFrame(for id: String) -> Data? {
        bytes(of: id).map { Data([helloFrameType]) + $0 }
    }

    /// Returns the sender id if `frame` is a HELLO frame.
    public static func parseHello(_ frame: Data) -> String? {
        let b = [UInt8](frame)
        guard b.count == 17, b[0] == helloFrameType else { return nil }
        return id(fromBytes: Data(b[1...]))
    }

    /// Loads the id from `defaults` or creates and stores a fresh one.
    public static func loadOrCreate(defaults: UserDefaults = .standard, key: String = "beacon.instanceId") -> String {
        if let s = defaults.string(forKey: key), UUID(uuidString: s) != nil { return s.lowercased() }
        let fresh = newId()
        defaults.set(fresh, forKey: key)
        return fresh
    }
}
