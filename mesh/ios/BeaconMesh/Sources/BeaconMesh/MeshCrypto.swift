import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Signs outgoing messages. ECDSA P-256 / SHA-256, ASN.1 DER signatures, exactly what the server verifies
/// (Node `crypto.verify('sha256', ...)` with a DER signature, server/src/crypto/verify.ts).
public protocol MeshSigner {
    /// X.509 SubjectPublicKeyInfo DER, the same bytes Android's `PublicKey.getEncoded()` and the server store.
    var publicKeyDER: Data { get }
    /// DER-encoded signature over `data` (SHA-256 is applied inside).
    func sign(_ data: Data) throws -> Data
}

public struct P256Signer: MeshSigner {
    public let privateKey: P256.Signing.PrivateKey

    public init(privateKey: P256.Signing.PrivateKey = .init()) {
        self.privateKey = privateKey
    }

    /// `derRepresentation` of a CryptoKit P-256 public key is the full SPKI structure (it includes the algorithm
    /// header), not the bare x9.63 point, so no manual header is needed.
    public var publicKeyDER: Data { privateKey.publicKey.derRepresentation }

    public func sign(_ data: Data) throws -> Data {
        try privateKey.signature(for: data).derRepresentation
    }
}

public extension MeshSigner {
    var publicKeyBase64: String { publicKeyDER.base64EncodedString() }

    func signBase64(_ text: String) throws -> String {
        try sign(Data(text.utf8)).base64EncodedString()
    }
}

public enum MeshCrypto {
    public static func verify(publicKeyDER: Data, data: Data, signatureDER: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: publicKeyDER),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: signatureDER)
        else { return false }
        return key.isValidSignature(sig, for: data)
    }

    /// Verifies a base64 signature over `text` (UTF-8) with a base64 SPKI key.
    public static func verifyB64(publicKeySPKI: String, text: String, signature: String) -> Bool {
        guard let key = Data(base64Encoded: publicKeySPKI.trimmingCharacters(in: .whitespacesAndNewlines)),
              let sig = Data(base64Encoded: signature) else { return false }
        return verify(publicKeyDER: key, data: Data(text.utf8), signatureDER: sig)
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// First 2 bytes of SHA-256(SPKI DER) as 4 uppercase hex chars.
    public static func relayId(publicKeyDER: Data) -> String {
        SHA256.hash(data: publicKeyDER).prefix(2).map { String(format: "%02X", $0) }.joined()
    }

    /// True when `spki` parses as a P-256 public key.
    public static func isValidP256SPKI(_ spki: Data) -> Bool {
        (try? P256.KeyAgreement.PublicKey(derRepresentation: spki)) != nil
    }
}

/// ECIES over P-256 exactly as in server/docs/crypto.md section 3:
///
///     wire = 0x01 || ephemeral public key (65 B, X9.62 uncompressed 0x04||X||Y) || nonce (12) || ciphertext || tag (16)
///     key  = HKDF-SHA256(ikm = ECDH x-coordinate (32 B), salt = empty, info = "beacon-ecies-v1", L = 32)
///     AEAD = AES-256-GCM, AAD = wire[0..<66] (version byte + ephemeral public key)
public enum Ecies {
    public static let version: UInt8 = 0x01
    static let info = Data("beacon-ecies-v1".utf8)
    static let headerLength = 66

    public enum Failure: Error, Equatable { case badKey, badCiphertext, authFailed }

    /// - Parameter recipientSPKI: backend encryption key, X.509 SPKI DER of a P-256 key.
    /// - Parameter ephemeral / nonce: injectable for deterministic tests only.
    public static func encrypt(_ plaintext: Data, recipientSPKI: Data,
                               ephemeral: P256.KeyAgreement.PrivateKey = .init(),
                               nonce: Data? = nil) throws -> Data {
        guard let recipient = try? P256.KeyAgreement.PublicKey(derRepresentation: recipientSPKI) else { throw Failure.badKey }
        var head = Data([version])
        head.append(ephemeral.publicKey.x963Representation)      // 65 bytes, 0x04 || X || Y
        let key = try deriveKey(ephemeral.sharedSecretFromKeyAgreement(with: recipient))
        let gcmNonce = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: key, nonce: gcmNonce, authenticating: head)
        return head + Data(gcmNonce) + box.ciphertext + box.tag
    }

    /// Inverse, for tests and tooling (a phone never holds the backend private key). Throws on tampering.
    public static func decrypt(_ wire: Data, recipient: P256.KeyAgreement.PrivateKey) throws -> Data {
        let w = [UInt8](wire)
        guard w.count >= headerLength + 12 + 16, w[0] == version else { throw Failure.badCiphertext }
        let head = Data(w[0..<headerLength])
        guard let eph = try? P256.KeyAgreement.PublicKey(x963Representation: Data(w[1..<headerLength])) else {
            throw Failure.badCiphertext
        }
        let key = try deriveKey(recipient.sharedSecretFromKeyAgreement(with: eph))
        do {
            let nonce = try AES.GCM.Nonce(data: Data(w[headerLength..<headerLength + 12]))
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: Data(w[(headerLength + 12)..<(w.count - 16)]),
                                            tag: Data(w[(w.count - 16)...]))
            return try AES.GCM.open(box, using: key, authenticating: head)
        } catch {
            throw Failure.authFailed
        }
    }

    static func deriveKey(_ shared: SharedSecret) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
    }
}

/// Device-authenticated REST calls (server/src/http/security.ts, server/docs/crypto.md section 4).
public enum RequestSigner {
    /// `METHOD \n PATH \n sha256hex(body) \n X-Timestamp`, no trailing newline.
    public static func message(method: String, path: String, body: Data, timestamp: String) -> String {
        "\(method.uppercased())\n\(path)\n\(MeshCrypto.sha256Hex(body))\n\(timestamp)"
    }

    /// Headers for one call. `path` is the request path as sent, including `/v1`, without the query string.
    public static func headers(deviceId: String, signer: MeshSigner, method: String, path: String, body: Data,
                               nowMs: Int64) throws -> [String: String] {
        let ts = Iso.format(nowMs)
        let sig = try signer.signBase64(message(method: method, path: path, body: body, timestamp: ts))
        return ["X-Device-Id": deviceId, "X-Timestamp": ts, "X-Device-Signature": sig]
    }
}
