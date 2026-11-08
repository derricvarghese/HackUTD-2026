@testable import BeaconMesh
import Foundation
import Testing
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

@Suite struct CanonicalJSONTests {
    @Test func sortsKeysAndStripsWhitespace() throws {
        let v = try #require(JSONValue.parse(#"{ "b": 1, "a": [true, null, "x"], "c": {"z": 1.5, "y": 0.00001, "x": 1e-7} }"#))
        #expect(try v.canonical() == #"{"a":[true,null,"x"],"b":1,"c":{"x":1e-7,"y":0.00001,"z":1.5}}"#)
    }

    @Test func numbersFollowEcmaScript() throws {
        let cases: [(Double, String)] = [
            (1.0, "1"), (32.995, "32.995"), (-96.745, "-96.745"), (0.1, "0.1"), (1000, "1000"), (1e21, "1e+21"),
            (123456789012345680000, "123456789012345680000"), (-0.5, "-0.5"), (0.00001, "0.00001"), (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (1e300, "1e+300"), (5e-324, "5e-324"), (0, "0"), (-0.0, "0"),
            (100, "100"), (1.2345e25, "1.2345e+25"),
        ]
        for (d, s) in cases { #expect(try JSONValue.double(d).canonical() == s, "\(d)") }
        #expect(throws: CanonicalError.self) { try JSONValue.double(.nan).canonical() }
        #expect(throws: CanonicalError.self) { try JSONValue.double(.infinity).canonical() }
    }

    @Test func stringsEscapeLikeJsonStringify() throws {
        let s = "quote \" back \\ nl \n tab \t ctl \u{01} uni é 中 😀 del \u{7F} slash /"
        #expect(try JSONValue.string(s).canonical() == "\"quote \\\" back \\\\ nl \\n tab \\t ctl \\u0001 uni é 中 😀 del \u{7F} slash /\"")
    }

    @Test func keysSortByUtf16CodeUnit() throws {
        let v = JSONValue.object(["é": .int(1), "B": .int(2), "a": .int(3), "Z": .int(4), "😀": .int(5), "\u{FF5E}": .int(6)])
        // U+FF5E (BMP) sorts after U+1F600's high surrogate D83D in UTF-16
        #expect(try v.canonical() == "{\"B\":2,\"Z\":4,\"a\":3,\"é\":1,\"😀\":5,\"\u{FF5E}\":6}")
    }

    @Test func parserHandlesEscapesAndRejectsGarbage() {
        #expect(JSONValue.parse(#"{"s":"é😀\n"}"#)?["s"]?.stringValue == "é😀\n")
        #expect(JSONValue.parse("not json") == nil)
        #expect(JSONValue.parse(#"{"a":1,}"#) == nil)
        #expect(JSONValue.parse(#"{"a":1} trailing"#) == nil)
        #expect(JSONValue.parse("1.0")?.doubleValue == 1.0)
    }

    @Test func sharedServerCanonicalCases() throws {
        guard let fx = loadJSON(Paths.contractFixtures.appendingPathComponent("server_envelope.json")) else { return }
        let cases = try #require(fx["canonical_json_cases"]?.arrayValue)
        #expect(!cases.isEmpty)
        for c in cases {
            let input = try #require(c.optString("input_json"))
            let parsed = try #require(JSONValue.parse(input))
            #expect(try parsed.canonical() == c.optString("output"), "\(input)")
        }
    }
}

@Suite struct TimeTests {
    @Test func formatMatchesToISOString() {
        #expect(Iso.format(1_762_500_000_000) == "2025-11-07T07:20:00.000Z")
        #expect(Iso.format(0) == "1970-01-01T00:00:00.000Z")
        #expect(Iso.format(1_762_500_000_123) == "2025-11-07T07:20:00.123Z")
    }

    @Test func parseRoundTripsAndHandlesOffsets() {
        for ms: Int64 in [0, 1_762_500_000_123, 4_102_444_800_999, 951_782_400_000] {
            #expect(Iso.parse(Iso.format(ms)) == ms)
        }
        #expect(Iso.parse("2026-11-07T16:12:00Z") == Iso.parse("2026-11-07T10:12:00-06:00"))
        #expect(Iso.parse("2026-11-07T16:12:00.5Z") == (Iso.parse("2026-11-07T16:12:00Z") ?? 0) + 500)
        #expect(Iso.parse("yesterday") == nil)
    }

    @Test func uuid7Layout() {
        let id = Uuid7.generate(nowMs: 0x0192_A7D4_1C2E)
        #expect(id.hasPrefix("0192a7d4-1c2e-7"))
        #expect(Uuid7.isUUID(id))
        #expect(["8", "9", "a", "b"].contains(String(id[id.index(id.startIndex, offsetBy: 19)])))
    }
}

@Suite struct EciesTests {
    @Test func roundTrip() throws {
        let backend = TestBackend()
        let plain = Data(#"{"lat":32.9857,"lng":-96.7501,"category":"trapped","text":"héllo 中"}"#.utf8)
        let wire = try Ecies.encrypt(plain, recipientSPKI: backend.encPrivate.publicKey.derRepresentation)
        #expect(wire[0] == 0x01)
        #expect(wire[1] == 0x04)                       // X9.62 uncompressed ephemeral key
        #expect(wire.count == 1 + 65 + 12 + plain.count + 16)
        #expect(try Ecies.decrypt(wire, recipient: backend.encPrivate) == plain)
    }

    @Test func freshEphemeralKeyAndNoncePerMessage() throws {
        let b = TestBackend()
        let spki = b.encPrivate.publicKey.derRepresentation
        let a = try Ecies.encrypt(Data("x".utf8), recipientSPKI: spki)
        let c = try Ecies.encrypt(Data("x".utf8), recipientSPKI: spki)
        #expect(a != c)
        #expect(a[1..<66] != c[1..<66])
    }

    @Test func tamperingAndWrongKeyFail() throws {
        let b = TestBackend()
        var wire = try Ecies.encrypt(Data("secret".utf8), recipientSPKI: b.encPrivate.publicKey.derRepresentation)
        #expect(throws: Ecies.Failure.self) { try Ecies.decrypt(wire, recipient: TestBackend().encPrivate) }
        wire[70] ^= 0x01                                // inside the GCM nonce
        #expect(throws: Ecies.Failure.self) { try Ecies.decrypt(wire, recipient: b.encPrivate) }
        var aad = try Ecies.encrypt(Data("secret".utf8), recipientSPKI: b.encPrivate.publicKey.derRepresentation)
        aad[0] = 0x02                                   // version byte is authenticated and checked
        #expect(throws: Ecies.Failure.self) { try Ecies.decrypt(aad, recipient: b.encPrivate) }
        #expect(throws: Ecies.Failure.self) { try Ecies.decrypt(Data(repeating: 1, count: 20), recipient: b.encPrivate) }
    }

    @Test func rejectsGarbageRecipientKey() {
        #expect(throws: Ecies.Failure.self) { try Ecies.encrypt(Data("x".utf8), recipientSPKI: Data(repeating: 7, count: 91)) }
    }

    /// Re-derives the key by hand from the documented recipe (HKDF-SHA256, empty salt, info "beacon-ecies-v1", AAD = header)
    /// so a CryptoKit/swift-crypto quirk in `hkdfDerivedSymmetricKey` cannot hide a mismatch with the server.
    @Test func matchesDocumentedDerivation() throws {
        let b = TestBackend()
        let eph = P256.KeyAgreement.PrivateKey()
        let nonce = Data((0..<12).map(UInt8.init))
        let wire = try Ecies.encrypt(Data("abc".utf8), recipientSPKI: b.encPrivate.publicKey.derRepresentation, ephemeral: eph, nonce: nonce)
        let shared = try b.encPrivate.sharedSecretFromKeyAgreement(with: eph.publicKey)
        let raw = shared.withUnsafeBytes { Data($0) }
        #expect(raw.count == 32)
        // RFC 5869 by hand: PRK = HMAC(salt = 32 zero bytes, ikm), OKM = HMAC(PRK, info || 0x01)
        let prk = Data(HMAC<SHA256>.authenticationCode(for: raw, using: SymmetricKey(data: Data(repeating: 0, count: 32))))
        let okm = Data(HMAC<SHA256>.authenticationCode(for: Data("beacon-ecies-v1".utf8) + Data([1]), using: SymmetricKey(data: prk)))
        let head = wire.prefix(66)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: wire[78..<(wire.count - 16)], tag: wire.suffix(16))
        #expect(try AES.GCM.open(box, using: SymmetricKey(data: okm), authenticating: Data(head)) == Data("abc".utf8))
    }
}

@Suite struct SigningTests {
    @Test func spkiIsFullDerNotBarePoint() {
        let s = P256Signer()
        #expect(s.publicKeyDER.count == 91)             // 26-byte SPKI header + 65-byte point
        #expect(s.publicKeyDER.prefix(3) == Data([0x30, 0x59, 0x30]))
    }

    @Test func signaturesAreDerAndVerify() throws {
        let s = P256Signer()
        let sig = try s.sign(Data("hello".utf8))
        #expect(sig[0] == 0x30)                         // ASN.1 SEQUENCE, not raw r||s (which would be 64 bytes)
        #expect(sig.count >= 68 && sig.count <= 72)
        #expect(MeshCrypto.verify(publicKeyDER: s.publicKeyDER, data: Data("hello".utf8), signatureDER: sig))
        #expect(!MeshCrypto.verify(publicKeyDER: s.publicKeyDER, data: Data("hellO".utf8), signatureDER: sig))
    }

    @Test func envelopeSignedPartMatchesServerShape() throws {
        let env = MeshEnvelope(id: "01a1b6bc-f800-7cc8-959c-3a8855af522c", senderKeyId: "KEY", senderPublicKey: "PUB", kind: "sos",
                               tier: "critical", maxHops: 10, hopCount: 2, hopPath: ["A1", "B2"],
                               expiresAt: "2026-11-08T16:00:00.000Z", createdAt: "2026-11-07T16:00:00.000Z",
                               routing: Routing.build(lat: 32.9857, lng: -96.7501, category: "trapped"), payload: "UEFZ", signature: "SIG")
        #expect(try env.signedPart() == #"{"created_at":"2026-11-07T16:00:00.000Z","expires_at":"2026-11-08T16:00:00.000Z","id":"01a1b6bc-f800-7cc8-959c-3a8855af522c","kind":"sos","max_hops":10,"payload":"UEFZ","routing":{"approx":{"lat":32.985,"lng":-96.755,"radius_m":1000},"category":"trapped"},"sender_key_id":"KEY","tier":"critical"}"#)
        // hop_count / hop_path / sender_public_key / signature must not influence the signed bytes
        var other = env
        other.hopCount = 9; other.hopPath = ["Z"]; other.senderPublicKey = nil; other.signature = "X"
        #expect(try other.signedPart() == env.signedPart())
    }

    @Test func routingCellRounding() {
        #expect(Routing.cell(32.9857) == 32.985)
        #expect(Routing.cell(-96.7501) == -96.755)
        #expect(Routing.cell(33.1) == 33.105)
        #expect(Routing.cell(-0.001) == -0.005)
    }

    @Test func backendMessageAndReceiptSignedParts() throws {
        let m = BackendMessage(id: "i", kind: "status_update", sosId: "s", checkinId: nil,
                               body: .object(["status": .string("en_route"), "eta_minutes": .int(40), "message": .string("go")]),
                               maxHops: 5, hopCount: 3, hopPath: ["A"], expiresAt: "E", createdAt: "C", signature: "x")
        #expect(try m.signedPart() == #"{"body":{"eta_minutes":40,"message":"go","status":"en_route"},"checkin_id":null,"created_at":"C","expires_at":"E","id":"i","kind":"status_update","max_hops":5,"sos_id":"s"}"#)
        let r = DeliveredReceipt(id: "i", deliveredAt: "D", hopCount: 4, signature: "x")
        #expect(try r.signedPart() == #"{"delivered_at":"D","id":"i","max_hops":5}"#)
    }
}

@Suite struct RequestSignerTests {
    @Test func messageFormat() {
        let body = Data(#"{"a":1}"#.utf8)
        let m = RequestSigner.message(method: "post", path: "/v1/sos/batch", body: body, timestamp: "2026-11-07T16:10:00.000Z")
        let parts = m.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        #expect(parts.count == 4)
        #expect(parts[0] == "POST")
        #expect(parts[1] == "/v1/sos/batch")
        #expect(parts[2] == MeshCrypto.sha256Hex(body))
        #expect(parts[2].count == 64 && parts[2] == parts[2].lowercased())
        #expect(parts[3] == "2026-11-07T16:10:00.000Z")
        #expect(!m.hasSuffix("\n"))
    }

    @Test func emptyBodyHash() {
        #expect(MeshCrypto.sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func headersVerifyWithDeviceKey() throws {
        let s = P256Signer()
        let body = Data("{}".utf8)
        let h = try RequestSigner.headers(deviceId: "0192a000-0000-7000-8000-0000000000d1", signer: s, method: "POST",
                                          path: "/v1/heartbeats", body: body, nowMs: 1_762_500_000_000)
        #expect(h["X-Device-Id"] == "0192a000-0000-7000-8000-0000000000d1")
        #expect(h["X-Timestamp"] == "2025-11-07T07:20:00.000Z")
        let msg = RequestSigner.message(method: "POST", path: "/v1/heartbeats", body: body, timestamp: h["X-Timestamp"]!)
        #expect(MeshCrypto.verifyB64(publicKeySPKI: s.publicKeyBase64, text: msg, signature: h["X-Device-Signature"]!))
    }
}
