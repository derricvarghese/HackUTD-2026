@testable import BeaconMesh
import Foundation
import Testing

/// In-memory radio: routers in a line, deliveries queued and drained (no re-entrancy).
private final class FakeNetwork {
    final class Port: MeshTransport {
        let name: String
        weak var net: FakeNetwork?
        init(name: String) { self.name = name }
        func send(_ envelopeJSON: Data, to peer: String) {
            net?.queue.append((from: name, to: peer, data: envelopeJSON))
        }
    }

    var nodes: [String: MeshRouter] = [:]
    var ports: [String: Port] = [:]
    var queue: [(from: String, to: String, data: Data)] = []
    var online: Set<String> = []
    var uploads: [String: [StoredMessage]] = [:]
    var nowMs: Int64 = 1_762_500_000_000

    @discardableResult
    func add(_ name: String) -> MeshRouter {
        let port = Port(name: name)
        port.net = self
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), now: { [unowned self] in nowMs })
        router.isOnline = { [unowned self] in online.contains(name) }
        router.upload = { [unowned self] in uploads[name, default: []].append($0) }
        router.transport = port
        nodes[name] = router
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

    func has(_ node: String, _ id: String) -> StoredMessage? {
        nodes[node]!.messages.first { $0.id == id }
    }
}

@Suite struct MeshRouterTests {
    private func line(_ names: [String]) -> FakeNetwork {
        let net = FakeNetwork()
        names.forEach { net.add($0) }
        for i in 0..<(names.count - 1) { net.link(names[i], names[i + 1]) }
        net.run()
        return net
    }

    @Test func testCriticalSosTravelsWholeLine() throws {
        let net = line(["A", "B", "C", "D"])
        let msg = try net.nodes["A"]!.originate(category: .trapped, text: "2 people, water rising", people: 2)
        net.run()
        let atD = try #require(net.has("D", msg.id))
        #expect(atD.envelope.hop == 3)
        #expect(atD.envelope.path == ["A", "B", "C"].map { net.nodes[$0]!.relayId })
        #expect(atD.header.maxHops == 10)
    }

    @Test func testDemoHopCapStopsNormalMessageAtThirdPhone() throws {
        let net = line(["A", "B", "C", "D"])
        let normal = try net.nodes["A"]!.originate(category: .checkin, nonCriticalHopCap: 2)
        net.run()
        #expect(net.has("B", normal.id) != nil)
        let atC = try #require(net.has("C", normal.id))
        #expect(atC.envelope.hop == 2)
        #expect(!atC.canForward)
        #expect(net.has("D", normal.id) == nil, "hop limit should stop it at phone 3")

        // Same cap, but critical ignores it and gets through.
        let critical = try net.nodes["A"]!.originate(category: .injured, nonCriticalHopCap: 2)
        net.run()
        #expect(net.has("D", critical.id) != nil)
    }

    @Test func testGatewayUploadsAndStopsRelaying() throws {
        let net = line(["A", "B", "C", "D"])
        net.online = ["C"]
        let msg = try net.nodes["A"]!.originate(category: .medical)
        net.run()
        #expect(net.uploads["C"]?.map(\.id) == [msg.id])
        #expect(net.uploads["C"]?.first?.envelope.hop == 2)
        #expect(net.has("D", msg.id) == nil)
    }

    @Test func testStoreAndForwardToLatePeer() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B"); net.add("C")
        net.link("A", "B")
        let msg = try net.nodes["A"]!.originate(category: .trapped)
        net.run()
        #expect(net.has("C", msg.id) == nil)
        // B walks over to C later.
        net.link("B", "C")
        net.run()
        #expect(net.has("C", msg.id)?.envelope.hop == 2)
    }

    @Test func testGatewayFlushesHeldMessagesWhenInternetReturns() throws {
        let net = line(["A", "B"])
        let msg = try net.nodes["A"]!.originate(category: .waterMeds)
        net.run()
        #expect(net.uploads["B"] == nil)
        net.online = ["B"]
        net.nodes["B"]!.internetBecameAvailable()
        #expect(net.uploads["B"]?.map(\.id) == [msg.id])
    }

    // MARK: Security / validation

    private func receivedCopy(_ category: BeaconMesh.Category = .trapped) throws -> (FakeNetwork, Envelope) {
        let net = line(["A", "B"])
        let msg = try net.nodes["A"]!.originate(category: category)
        net.run()
        return (net, try #require(net.has("B", msg.id)).envelope)
    }

    private func deliver(_ env: Envelope, to node: MeshRouter) throws -> ReceiveOutcome {
        node.receive(try env.jsonData(), from: "X")
    }

    @Test func testDuplicateIsDropped() throws {
        let (net, env) = try receivedCopy()
        #expect(try deliver(env, to: net.nodes["B"]!) == .dropped(.duplicate))
    }

    @Test func testTamperedMaxHopsFailsSignature() throws {
        let (net, env) = try receivedCopy(.checkin)
        let fresh = net.add("Z")
        var header = try #require(env.header)
        header.maxHops = 10
        var bad = env
        bad.signed = try header.encoded().base64EncodedString()
        #expect(try deliver(bad, to: fresh) == .dropped(.badSignature))
    }

    @Test func testHopOverMaxIsRejected() throws {
        let (net, env) = try receivedCopy(.safe) // maxHops 3
        let fresh = net.add("Z")
        var bad = env
        bad.hop = 4
        bad.path = ["1111", "2222", "3333", "4444"]
        #expect(try deliver(bad, to: fresh) == .dropped(.hopLimit))
    }

    @Test func testHopResetWithoutPathIsRejected() throws {
        let (net, env) = try receivedCopy()
        let fresh = net.add("Z")
        var bad = env
        bad.hop = 0
        #expect(try deliver(bad, to: fresh) == .dropped(.hopLimit))
        bad.hop = 1
        bad.path = []
        #expect(try deliver(bad, to: fresh) == .dropped(.pathMismatch))
    }

    @Test func testExpiredIsDropped() throws {
        let (net, env) = try receivedCopy(.safe) // 3 h TTL
        let fresh = net.add("Z")
        net.nowMs += 3 * 3_600_000 + 1
        #expect(try deliver(env, to: fresh) == .dropped(.expired))
    }

    @Test func testGarbageIsMalformed() {
        let net = FakeNetwork()
        let a = net.add("A")
        #expect(a.receive(Data("not json".utf8), from: "X") == .dropped(.malformed))
    }
}

@Suite struct FramingTests {
    @Test func testChunkAndReassembleOutOfOrder() {
        let payload = Data((0..<1500).map { UInt8($0 % 251) })
        let frames = Framing.chunk(payload, transferId: 0xDEADBEEF, maxWriteLength: 182)
        #expect(frames.count == Int((1500.0 / 173.0).rounded(.up)))
        #expect(frames.allSatisfy { $0.count <= 182 })
        let r = Reassembler()
        var out: Data?
        for f in frames.reversed() { out = r.ingest(f, from: "p") ?? out }
        #expect(out == payload)
    }

    @Test func testSingleChunk() {
        let payload = Data("hi".utf8)
        let frames = Framing.chunk(payload, transferId: 1, maxWriteLength: 100)
        #expect(frames.count == 1)
        #expect(Array(frames[0].prefix(9)) == [0x01, 0, 0, 0, 1, 0, 0, 0, 1])
        #expect(Reassembler().ingest(frames[0], from: "p") == payload)
    }

    @Test func testStalePartialIsPurged() {
        let payload = Data(repeating: 7, count: 300)
        let frames = Framing.chunk(payload, transferId: 9, maxWriteLength: 100)
        let r = Reassembler(timeout: 30)
        let t0 = Date()
        #expect(r.ingest(frames[0], from: "p", now: t0) == nil)
        for f in frames.dropFirst() {
            #expect(r.ingest(f, from: "p", now: t0.addingTimeInterval(31)) == nil)
        }
    }
}

/// The shared vector in mesh/test-vectors must verify on every platform (and the backend).
@Suite struct TestVectorTests {
    @Test func testSharedEnvelopeVectorVerifies() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // BeaconMeshTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // BeaconMesh
            .deletingLastPathComponent() // ios
            .appendingPathComponent("test-vectors/envelope_v1.json")
        let root = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let envData = try JSONSerialization.data(withJSONObject: try #require(root["envelope"]))
        let env = try #require(Envelope.decode(envData))
        let bytes = try #require(env.signedBytes)
        let header = try #require(env.header)
        #expect(header.id == root["expectedId"] as? String)
        #expect(MeshCrypto.relayId(publicKeyDER: Data(base64Encoded: header.pub)!) == root["expectedOriginRelayId"] as? String)
        #expect(MeshValidation.validate(env, header: header, signedBytes: bytes, nowMs: header.createdAt + 1000) == nil)
    }
}
