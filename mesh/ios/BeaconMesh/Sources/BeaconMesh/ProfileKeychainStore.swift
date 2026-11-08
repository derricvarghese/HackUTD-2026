import Foundation
#if canImport(Security)
import Security

/// Keeps the whole `ProfileRecord` (a few KB of JSON) as ONE Keychain generic-password item.
///
/// Why the Keychain directly and not "AES key in the Keychain + encrypted file": the record is small (Keychain items
/// take tens of KB without trouble), the Keychain already provides encryption at rest bound to the device and the
/// passcode, and there is no second artefact (key/file mismatch, plaintext temp file, partial writes) to get wrong.
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by the background sync after the first unlock
///   (BLE/gateway work runs with the screen locked) but never in iCloud/iTunes backups or on another device.
///   (Stricter than plain `AfterFirstUnlock`, which would migrate with an encrypted backup.)
/// - Keychain items survive app deletion on iOS, personal data should not: on a fresh install (UserDefaults marker
///   missing) any old item is erased first. The server copy is restored later through `ProfileSyncEngine`'s adoption.
public final class ProfileKeychainStore: ProfileStoring {
    private static let service = "com.beacon.mesh.profile"
    private static let account = "user-profile-v1"
    private static let installMarker = "beacon.profile.installed"

    public init(defaults: UserDefaults = .standard) {
        if !defaults.bool(forKey: Self.installMarker) {
            Self.delete()
            defaults.set(true, forKey: Self.installMarker)
        }
    }

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> ProfileRecord? {
        var q = Self.base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let json = JSONValue.parse(data) else { return nil }
        return ProfileRecord.fromJSON(json)
    }

    public func save(_ record: ProfileRecord) {
        let data = record.toJSON().serializedData()
        let status = SecItemUpdate(Self.base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = Self.base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            add[kSecAttrSynchronizable as String] = false
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() { Self.delete() }

    private static func delete() { SecItemDelete(base as CFDictionary) }
}
#endif
