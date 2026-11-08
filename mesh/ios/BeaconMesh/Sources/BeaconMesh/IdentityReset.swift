import Foundation

// "Reset device identity" (Settings -> Debug and demo). The server merges every report from the same sender, so a
// demo that wants several separate reports needs a fresh identity. This file is only the sequencing; the Apple side
// plugs in the Keychain, BLE and notification pieces. Keys and secrets are never logged or returned.

/// Replaces the signing key in persistent storage and returns a signer for the new key.
public protocol DeviceKeyRotating: AnyObject {
    func rotateSigningKey() throws -> MeshSigner
}

/// The stable BLE instance UUID (this phone's peer id).
public protocol InstanceIdRotating: AnyObject {
    var currentInstanceId: String { get }
    func rotateInstanceId() -> String
}

public protocol ProfileResetting: AnyObject {
    func resetForNewDevice()
}

public final class UserDefaultsInstanceId: InstanceIdRotating {
    private let defaults: UserDefaults
    private let key: String
    public init(defaults: UserDefaults = .standard, key: String = "beacon.instanceId") { self.defaults = defaults; self.key = key }
    public var currentInstanceId: String { InstanceId.loadOrCreate(defaults: defaults, key: key) }
    public func rotateInstanceId() -> String { InstanceId.rotate(defaults: defaults, key: key) }
}

/// Short, non-secret labels: first 8 characters of the old and new identity.
public struct IdentityResetResult: Equatable {
    public var oldKeyId: String
    public var newKeyId: String
    public var oldInstanceId: String
    public var newInstanceId: String
}

public final class IdentityResetter {
    private let signer: RotatingSigner
    private let keys: DeviceKeyRotating
    private let instance: InstanceIdRotating
    private let config: BackendConfig
    private let profile: ProfileResetting?
    /// Restart the BLE transport under the new instance id (clears links and the peer registry).
    private let restartTransport: (String) -> Void
    /// Cancel the old identity's pending check-ins / local reminders.
    private let cancelCheckins: () -> Void
    private let now: () -> Int64

    /// Newest result, nil before the first reset.
    public private(set) var last: IdentityResetResult?
    public private(set) var lastAtMs: Int64?

    public init(signer: RotatingSigner, keys: DeviceKeyRotating, instance: InstanceIdRotating, config: BackendConfig,
                profile: ProfileResetting?, restartTransport: @escaping (String) -> Void,
                cancelCheckins: @escaping () -> Void, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.signer = signer; self.keys = keys; self.instance = instance; self.config = config; self.profile = profile
        self.restartTransport = restartTransport; self.cancelCheckins = cancelCheckins; self.now = now
    }

    /// Order matters: the new key is created first, so a failure there changes nothing. Messages and seen-ids are
    /// left alone, as is the local profile (it is re-sent to the new device).
    @discardableResult
    public func reset() throws -> IdentityResetResult {
        let oldKey = MeshCrypto.shortKeyId(publicKeyDER: signer.publicKeyDER)
        let oldInstance = instance.currentInstanceId
        let fresh = try keys.rotateSigningKey()                 // 1. new signing key (old one deleted by the store)
        signer.replace(with: fresh)
        let newInstance = instance.rotateInstanceId()           // 2. new BLE peer id
        config.resetDeviceRegistration()                        // 3. forget device id, heartbeat seq, cursors
        cancelCheckins()                                        // 4. old identity's check-ins and reminders
        profile?.resetForNewDevice()                            // 5. re-PUT the profile to the new device
        restartTransport(newInstance)                           // 6. peers see the new id
        let r = IdentityResetResult(oldKeyId: oldKey, newKeyId: MeshCrypto.shortKeyId(publicKeyDER: signer.publicKeyDER),
                                    oldInstanceId: String(oldInstance.prefix(8)), newInstanceId: String(newInstance.prefix(8)))
        last = r
        lastAtMs = now()
        return r
    }
}
