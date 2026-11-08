import Foundation
#if canImport(Security) && canImport(CryptoKit)
import CryptoKit
import Security

/// Persists the device signing key in the Keychain so the relay ID and device registration survive restarts.
/// (Unchanged approach from v1: a software P-256 key stored as a generic password item.)
public enum KeychainKeyStore {
    private static let service = "com.beacon.mesh"
    private static let account = "device-signing-key"

    public static func loadOrCreate() -> P256Signer {
        if let raw = read(), let key = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
            return P256Signer(privateKey: key)
        }
        let key = P256.Signing.PrivateKey()
        write(key.rawRepresentation)
        return P256Signer(privateKey: key)
    }

    private static func read() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private static func write(_ data: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
#endif
