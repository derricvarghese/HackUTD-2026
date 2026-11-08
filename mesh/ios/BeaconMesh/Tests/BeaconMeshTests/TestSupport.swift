@testable import BeaconMesh
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

enum Paths {
    /// .../mesh
    static let meshDir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // BeaconMeshTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // BeaconMesh
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // mesh
    static let contractFixtures = meshDir.appendingPathComponent("test-vectors/contract_v1")
    static let iosFixtures = meshDir.appendingPathComponent("ios/BeaconMesh/Tests/Fixtures")
    static let iosSharedCopy = meshDir.appendingPathComponent("test-vectors/contract_v1_ios")
}

func loadJSON(_ url: URL) -> JSONValue? {
    (try? Data(contentsOf: url)).flatMap { JSONValue.parse($0) }
}

/// The backend side of the world for tests: encryption + signing key pairs (what `npm run keys` produces).
struct TestBackend {
    let encPrivate: P256.KeyAgreement.PrivateKey
    let signPrivate: P256.Signing.PrivateKey
    var encPublicB64: String { encPrivate.publicKey.derRepresentation.base64EncodedString() }
    var signPublicB64: String { signPrivate.publicKey.derRepresentation.base64EncodedString() }

    init() {
        encPrivate = P256.KeyAgreement.PrivateKey()
        signPrivate = P256.Signing.PrivateKey()
    }

    init(encPkcs8B64: String, signPkcs8B64: String) throws {
        encPrivate = try P256.KeyAgreement.PrivateKey(derRepresentation: Data(base64Encoded: encPkcs8B64)!)
        signPrivate = try P256.Signing.PrivateKey(derRepresentation: Data(base64Encoded: signPkcs8B64)!)
    }

    func sign(_ text: String) -> String {
        try! signPrivate.signature(for: Data(text.utf8)).derRepresentation.base64EncodedString()
    }

    /// A backend-signed message exactly as the server's `signBackendMessage` produces it.
    func message(kind: String, sosId: String, checkinId: String? = nil, body: [String: JSONValue],
                 createdMs: Int64, ttlMs: Int64 = 6 * 3_600_000, id: String = Uuid7.generate()) -> BackendMessage {
        var m = BackendMessage(id: id, kind: kind, sosId: sosId, checkinId: checkinId, body: .object(body), maxHops: 5,
                               expiresAt: Iso.format(createdMs + ttlMs), createdAt: Iso.format(createdMs), signature: "")
        m.signature = sign(try! m.signedPart())
        return m
    }

    func receipt(sosId: String, atMs: Int64) -> DeliveredReceipt {
        var r = DeliveredReceipt(id: sosId, deliveredAt: Iso.format(atMs), signature: "")
        r.signature = sign(try! r.signedPart())
        return r
    }

    func decrypt(_ envelope: MeshEnvelope) throws -> JSONValue {
        let plain = try Ecies.decrypt(Data(base64Encoded: envelope.payload)!, recipient: encPrivate)
        return JSONValue.parse(plain)!
    }
}

/// In-memory radio: routers, deliveries queued and drained (no re-entrancy).
final class FakeNetwork {
    final class Port: MeshTransport {
        let name: String
        weak var net: FakeNetwork?
        init(name: String) { self.name = name }
        func send(_ json: Data, to peer: String) { net?.queue.append((from: name, to: peer, data: json)) }
    }

    let backend: TestBackend
    var nodes: [String: MeshRouter] = [:]
    var configs: [String: BackendConfig] = [:]
    var ports: [String: Port] = [:]
    var queue: [(from: String, to: String, data: Data)] = []
    var online: Set<String> = []
    var uploads: [String: [StoredMessage]] = [:]
    var nowMs: Int64 = 1_762_500_000_000

    init(backend: TestBackend = TestBackend()) { self.backend = backend }

    /// - Parameter withSigningKey: false simulates a phone that has never learned the backend signing key.
    @discardableResult
    func add(_ name: String, withEncryptionKey: Bool = true, withSigningKey: Bool = true) -> MeshRouter {
        let port = Port(name: name)
        port.net = self
        let config = BackendConfig(store: MemoryKeyValueStore(),
                                   builtInEncryptionKey: withEncryptionKey ? backend.encPublicB64 : "",
                                   builtInSigningKey: withSigningKey ? backend.signPublicB64 : "")
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), config: config, now: { [unowned self] in nowMs })
        router.isOnline = { [unowned self] in online.contains(name) }
        router.upload = { [unowned self] in uploads[name, default: []].append($0) }
        router.transport = port
        nodes[name] = router
        configs[name] = config
        ports[name] = port
        return router
    }

    func link(_ a: String, _ b: String) {
        nodes[a]!.peerConnected(b)
        nodes[b]!.peerConnected(a)
    }

    func run() {
        while !queue.isEmpty {
            let d = queue.removeFirst()
            nodes[d.to]?.receive(d.data, from: d.from)
        }
    }

    func has(_ node: String, _ id: String) -> StoredMessage? { nodes[node]!.messages.first { $0.id == id } }

    func line(_ names: [String]) {
        names.forEach { add($0) }
        for i in 0..<(names.count - 1) { link(names[i], names[i + 1]) }
        run()
    }
}

let dallas = (lat: 32.9857, lng: -96.7501)

struct MissingFixtureField: Error {}
func fromMeshEnvelope(_ v: JSONValue?) throws -> MeshEnvelope { guard let v, let e = MeshEnvelope.fromJSON(v) else { throw MissingFixtureField() }; return e }
func fromBackendMessage(_ v: JSONValue?) throws -> BackendMessage { guard let v, let e = BackendMessage.fromJSON(v) else { throw MissingFixtureField() }; return e }
func fromDeliveredReceipt(_ v: JSONValue?) throws -> DeliveredReceipt { guard let v, let e = DeliveredReceipt.fromJSON(v) else { throw MissingFixtureField() }; return e }
