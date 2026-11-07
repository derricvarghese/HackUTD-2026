import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

/// Signs outgoing messages. ECDSA P-256 / SHA-256 so Android Keystore can do the same.
public protocol MeshSigner {
    /// SubjectPublicKeyInfo DER, the same bytes Android's `PublicKey.getEncoded()` returns.
    var publicKeyDER: Data { get }
    /// DER-encoded signature over `data`.
    func sign(_ data: Data) throws -> Data
}

public struct P256Signer: MeshSigner {
    public let privateKey: P256.Signing.PrivateKey

    public init(privateKey: P256.Signing.PrivateKey = .init()) {
        self.privateKey = privateKey
    }

    public var publicKeyDER: Data { privateKey.publicKey.derRepresentation }

    public func sign(_ data: Data) throws -> Data {
        try privateKey.signature(for: data).derRepresentation
    }
}

public enum MeshCrypto {
    public static func verify(publicKeyDER: Data, data: Data, signatureDER: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: publicKeyDER),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: signatureDER)
        else { return false }
        return key.isValidSignature(sig, for: data)
    }

    /// First 2 bytes of SHA-256(SPKI DER) as 4 uppercase hex chars.
    public static func relayId(publicKeyDER: Data) -> String {
        let digest = SHA256.hash(data: publicKeyDER)
        return digest.prefix(2).map { String(format: "%02X", $0) }.joined()
    }
}

#if canImport(Security)
/// Persists the device key in the Keychain so the relay ID survives app restarts.
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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
}
#endif
