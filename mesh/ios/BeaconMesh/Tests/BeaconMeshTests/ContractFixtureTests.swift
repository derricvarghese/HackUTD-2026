@testable import BeaconMesh
import Foundation
import Testing
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Fixtures produced by the server helper (server_envelope.json) and the Android app (android_envelope.json) in
/// mesh/test-vectors/contract_v1. Skipped (pass trivially) when the files are not in the checkout.
@Suite struct ContractFixtureTests {
    private func server() -> JSONValue? { loadJSON(Paths.contractFixtures.appendingPathComponent("server_envelope.json")) }

    private func backend(_ fx: JSONValue) throws -> TestBackend {
        let b = try #require(fx["backend"])
        return try TestBackend(encPkcs8B64: try #require(b.optString("encryption_private_key_pkcs8")),
                               signPkcs8B64: try #require(b.optString("signing_private_key_pkcs8")))
    }

    @Test func serverEnvelopeVerifiesAndDecrypts() throws {
        guard let fx = server() else { return }
        let be = try backend(fx)
        let env = try fromMeshEnvelope(fx["envelope"])
        // our canonical encoding of the received fields == the server's signed part
        #expect(try env.signedPart() == fx.optString("envelope_signed_part"))
        let key = try #require(MeshValidation.senderKeyDER(env))
        #expect(MeshCrypto.verify(publicKeyDER: key, data: Data(try env.signedPart().utf8), signatureDER: Data(base64Encoded: env.signature)!))
        // full relay-side validation at the fixture's validation time (relays gave it hop_count 2)
        let now = try #require(fx.optString("now_for_validation").flatMap(Iso.parse))
        #expect(MeshValidation.validate(env, limits: .default, nowMs: now) == nil)
        // payload decrypts with the fixture backend key to the expected plaintext
        #expect(try be.decrypt(env) == fx["expected_payload"])
    }

    @Test func serverBackendMessagesAndReceiptVerify() throws {
        guard let fx = server() else { return }
        let sign = try #require(fx["backend"]?.optString("signing_public_key"))
        for key in ["backend_message", "backend_message_checkin"] {
            let m = try fromBackendMessage(fx[key])
            #expect(MeshCrypto.verifyB64(publicKeySPKI: sign, text: try m.signedPart(), signature: m.signature), "\(key)")
        }
        let r = try fromDeliveredReceipt(fx["delivered_receipt"])
        #expect(MeshCrypto.verifyB64(publicKeySPKI: sign, text: try r.signedPart(), signature: r.signature))
        let checkin = try fromBackendMessage(fx["backend_message_checkin"])
        #expect(checkin.checkinId == "0192a7f0-0000-7000-8000-0000000000c1")
        #expect(CheckinPrompt.from(StoredBackend(id: checkin.id, payload: .message(checkin), receivedAt: 0, expiresAtMs: 0, verified: true))?.message == "Are you OK? Please reply.")
    }

    @Test func serverRequestSignatureVerifiesAndMatchesSignedString() throws {
        guard let fx = server() else { return }
        let rs = try #require(fx["request_signature"])
        let body = Data(try #require(rs.optString("body")).utf8)
        let msg = RequestSigner.message(method: try #require(rs.optString("method")), path: try #require(rs.optString("path")),
                                        body: body, timestamp: try #require(rs.optString("timestamp")))
        #expect(msg == rs.optString("signed_string"))
        let dev = try #require(fx["device"]?.optString("public_key"))
        #expect(MeshCrypto.verifyB64(publicKeySPKI: dev, text: msg, signature: try #require(rs.optString("signature"))))
        #expect(MeshCrypto.sha256Hex(Data()) == rs.optString("empty_body_sha256"))
    }

    @Test func serverEnvelopeIsAcceptedAndDecryptedByRouterPath() throws {
        guard let fx = server() else { return }
        let be = try backend(fx)
        let now = try #require(fx.optString("now_for_validation").flatMap(Iso.parse))
        // a relay phone that knows the signing key receives the server's backend message for the fixture SOS
        let cfg = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: be.encPublicB64, builtInSigningKey: be.signPublicB64)
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), config: cfg, now: { now })
        var wire = try fromBackendMessage(fx["backend_message"])
        wire = wire.forwarded(by: "E45B")
        #expect(router.receive(wire.toJSON().serializedData(), from: "peer") == .accepted(forwardedTo: 0, uploaded: false))
        #expect(router.backendItems.first?.verified == true)
        let envWire = try fromMeshEnvelope(fx["envelope"])
        #expect(router.receive(envWire.toBytes(), from: "peer") == .accepted(forwardedTo: 0, uploaded: false))
    }

    @Test func androidEnvelopesVerifyAndDecrypt() throws {
        guard let fx = server(), let android = loadJSON(Paths.contractFixtures.appendingPathComponent("android_envelope.json")) else { return }
        let be = try backend(fx)
        let envs = try #require(android["envelopes"]?.arrayValue)
        let expected = try #require(android["expected"]?.arrayValue)
        let now = try #require(android.optString("now_for_validation").flatMap(Iso.parse))
        #expect(envs.count == expected.count && !envs.isEmpty)
        for (j, e) in zip(envs, expected) {
            let env = try #require(MeshEnvelope.fromJSON(j))
            #expect(env.id == e.optString("id"))
            let relayed = env.hopCount == 0 ? env.forwarded(by: "E45B") : env
            #expect(MeshValidation.validate(relayed, limits: .default, nowMs: now) == nil, "\(env.id)")
            let plain = try be.decrypt(env)
            #expect(plain == e["payload"], "\(env.id)")
        }
    }
}

/// The fixture iOS produces for the server owner: `Tests/Fixtures/ios_envelope.json`, copied to
/// mesh/test-vectors/contract_v1_ios/. Regenerate with `BEACON_WRITE_FIXTURES=1 swift test --filter IosFixture`.
@Suite struct IosFixtureTests {
    static let fixedNow: Int64 = 1_794_067_200_000   // 2026-11-07T16:00:00.000Z

    @Test func generateAndVerifyFixture() throws {
        guard let fx = loadJSON(Paths.contractFixtures.appendingPathComponent("server_envelope.json")) else { return }
        let be = try TestBackend(encPkcs8B64: try #require(fx["backend"]?.optString("encryption_private_key_pkcs8")),
                                 signPkcs8B64: try #require(fx["backend"]?.optString("signing_private_key_pkcs8")))
        if ProcessInfo.processInfo.environment["BEACON_WRITE_FIXTURES"] == "1" {
            try writeFixture(backend: be)
        }
        let file = Paths.iosFixtures.appendingPathComponent("ios_envelope.json")
        guard let ios = loadJSON(file) else { Issue.record("missing \(file.path); run with BEACON_WRITE_FIXTURES=1"); return }
        let now = try #require(ios.optString("now_for_validation").flatMap(Iso.parse))
        #expect(ios.optString("backend_encryption_public_key") == be.encPublicB64)
        let envs = try #require(ios["envelopes"]?.arrayValue)
        let expected = try #require(ios["expected"]?.arrayValue)
        #expect(envs.count == 4 && envs.count == expected.count)
        for (j, e) in zip(envs, expected) {
            let env = try #require(MeshEnvelope.fromJSON(j))
            // origin copies have hop_count 0; relays validate the copy that arrives after one transmission
            #expect(MeshValidation.validate(env.forwarded(by: "E45B"), limits: .default, nowMs: now) == nil)
            #expect(try be.decrypt(env) == e["payload"])
            #expect(env.senderKeyId == ios.optString("device_public_key"))
        }
        // the signed batch request verifies with the device key
        let rs = try #require(ios["request_signature"])
        let msg = RequestSigner.message(method: "POST", path: "/v1/sos/batch", body: Data(try #require(rs.optString("body")).utf8),
                                        timestamp: try #require(rs.optString("timestamp")))
        #expect(MeshCrypto.verifyB64(publicKeySPKI: try #require(ios.optString("device_public_key")), text: msg,
                                     signature: try #require(rs.optString("signature"))))
    }

    private func writeFixture(backend be: TestBackend) throws {
        let key = P256.Signing.PrivateKey()
        let signer = P256Signer(privateKey: key)
        let cfg = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: be.encPublicB64)
        let router = MeshRouter(signer: signer, store: InMemoryMessageStore(), config: cfg, now: { Self.fixedNow })
        var envs: [JSONValue] = [], expected: [JSONValue] = []
        func add(_ m: StoredMessage, _ payload: JSONValue) {
            envs.append(m.envelope.toJSON())
            expected.append(.object(["id": .string(m.id), "payload": payload]))
        }
        let sosPayload = MeshPayload.sos(category: .trapped, text: "Trapped on roof, 2 people é中 \"quoted\" \\ slash", lat: 32.9857,
                                         lng: -96.7501, accuracy: 8.5, people: 2)
        add(try router.originate(category: .trapped, text: "Trapped on roof, 2 people é中 \"quoted\" \\ slash", lat: 32.9857, lng: -96.7501, accuracy: 8.5, people: 2), sosPayload)
        add(try router.originate(category: .safe, lat: 32.9857, lng: -96.7501), MeshPayload.sos(category: .safe, text: nil, lat: 32.9857, lng: -96.7501, accuracy: nil, people: nil))
        add(try router.originateCheckinReply(checkinId: "0192a7f0-0000-7000-8000-0000000000c1", response: "ok", text: "fine", lat: 32.9857, lng: -96.7501),
            MeshPayload.checkinReply(checkinId: "0192a7f0-0000-7000-8000-0000000000c1", response: "ok", text: "fine"))
        let hb = try router.originateHeartbeat(lat: 32.9857, lng: -96.7501, batteryPct: 41, charging: false, moving: false, seq: 17)
        add(hb, MeshPayload.heartbeat(sentAtMs: Self.fixedNow, lat: 32.9857, lng: -96.7501, batteryPct: 41, charging: false, moving: false, seq: 17))
        let body = JSONValue.object(["envelopes": .array(envs)]).serialized()
        let ts = Iso.format(Self.fixedNow + 60_000)
        let rsig = try signer.signBase64(RequestSigner.message(method: "POST", path: "/v1/sos/batch", body: Data(body.utf8), timestamp: ts))
        let out = JSONValue.object([
            "description": .string("Contract v1 envelopes produced by the iOS MeshRouter (software key). Encrypted to the backend key in contract_v1/server_envelope.json; the device key is inline (sender_key_id = device_public_key). Test keys only."),
            "backend_encryption_public_key": .string(be.encPublicB64),
            "device_public_key": .string(signer.publicKeyBase64),
            "device_private_key_pkcs8": .string(key.derRepresentation.base64EncodedString()),
            "now_for_validation": .string(Iso.format(Self.fixedNow + 60_000)),
            "envelopes": .array(envs),
            "expected": .array(expected),
            "request_signature": .object(["method": .string("POST"), "path": .string("/v1/sos/batch"), "body": .string(body),
                                          "timestamp": .string(ts), "signature": .string(rsig)]),
        ])
        let pretty = out.serialized()
        for dir in [Paths.iosFixtures, Paths.iosSharedCopy] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(pretty.utf8).write(to: dir.appendingPathComponent("ios_envelope.json"))
        }
    }
}
