@testable import BeaconMesh
import Foundation
import Testing

final class FakeHTTP: HTTPTransport, @unchecked Sendable {
    var requests: [HTTPRequest] = []
    var handler: (HTTPRequest) -> HTTPResponse = { _ in HTTPResponse(status: 404) }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return handler(request)
    }
    func paths() -> [String] { requests.map { "\($0.method) \($0.url.path)" } }
}

private func json(_ status: Int, _ v: JSONValue, headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, data: v.serializedData(), headers: headers)
}

private let deviceId = "0192a000-0000-7000-8000-0000000000d1"
private let t0: Int64 = 1_794_067_200_000

private struct World {
    let http = FakeHTTP()
    let backend = TestBackend()
    let signer = P256Signer()
    let config: BackendConfig
    let router: MeshRouter
    let sync: GatewaySync
    var nowMs = t0
    let box = ClockBox()

    final class ClockBox { var ms: Int64 = t0 }

    init(builtInKeys: Bool = false) {
        let b = backend
        let cfg = BackendConfig(store: MemoryKeyValueStore(),
                                builtInEncryptionKey: builtInKeys ? b.encPublicB64 : "",
                                builtInSigningKey: builtInKeys ? b.signPublicB64 : "")
        config = cfg
        let clock = box
        router = MeshRouter(signer: signer, store: InMemoryMessageStore(), config: cfg, now: { clock.ms })
        let client = BackendClient(baseURL: "https://hackutd.alecj.com/", http: http, signer: signer, config: cfg, now: { clock.ms })
        sync = GatewaySync(client: client, router: router, config: cfg)
        sync.hop = { $0() }
        sync.now = { clock.ms }
        sync.reachable = true
        router.isOnline = { [sync] in sync.isOnline }
    }

    func serverInfo(event: Bool = true) -> JSONValue {
        .object([
            "server_time": .string(Iso.format(box.ms)), "encryption_public_key": .string(backend.encPublicB64),
            "signing_public_key": .string(backend.signPublicB64), "hop_limits": HopLimits.default.toJSON(),
            "heartbeat_interval_seconds": .int(60), "silence_threshold_seconds": .int(600), "gateway_upload_max_batch": .int(500),
            "event": event ? .object(["id": .string("e"), "name": .string("Flood")]) : .null,
        ])
    }

    /// Default happy-path server.
    func serve(batch: ((JSONValue) -> JSONValue)? = nil) {
        let be = backend
        http.handler = { req in
            switch (req.method, req.url.path) {
            case ("GET", "/v1/server-info"): return json(200, self.serverInfo())
            case ("POST", "/v1/devices"): return json(201, .object(["id": .string(deviceId), "sender_hash": .string("h"), "created_at": .string(Iso.format(t0))]))
            case ("POST", "/v1/sos"): return json(201, .object([:]))
            case ("POST", "/v1/sos/batch"):
                let body = JSONValue.parse(req.body)!
                if let batch { return json(200, batch(body)) }
                let results = body["envelopes"]!.arrayValue!.map { JSONValue.object(["id": $0["id"]!, "status": .string("created")]) }
                return json(200, .object(["results": .array(results)]))
            case ("GET", "/v1/mesh/outbox"): return json(200, .object(["data": .array([])]))
            case ("GET", "/v1/checkins/pending"): return json(200, .object(["data": .array([])]))
            case ("POST", "/v1/heartbeats"): return json(202, .object(["next_heartbeat_in_seconds": .int(60), "event_active": .bool(true)]))
            default:
                _ = be
                return json(404, .object(["code": .string("not_found")]))
            }
        }
    }
}

@Suite struct GatewaySyncTests {
    @Test func firstCycleFetchesInfoRegistersAndSignsEveryAuthenticatedCall() async throws {
        let w = World()
        w.serve()
        await w.sync.runCycle()
        #expect(w.http.paths().prefix(3) == ["GET /v1/server-info", "POST /v1/devices", "GET /v1/mesh/outbox"])
        #expect(w.config.deviceId == deviceId)
        #expect(w.config.encryptionKeyStatus == .cached && w.config.signingKeyStatus == .cached)
        // the registration body
        let reg = JSONValue.parse(w.http.requests[1].body)!
        #expect(reg["public_key"]?.stringValue == w.signer.publicKeyBase64)
        #expect(reg["platform"]?.stringValue == "ios", "iOS registers as ios (contract enum: android, ios)")
        #expect(w.http.requests[1].headers["X-Device-Signature"] == nil, "registration is unauthenticated")
        // every authenticated request carries a valid signature over METHOD\nPATH\nSHA256(body)\nTS
        for req in w.http.requests where req.headers["X-Device-Signature"] != nil {
            #expect(req.headers["X-Device-Id"] == deviceId)
            let msg = RequestSigner.message(method: req.method, path: req.url.path, body: req.body, timestamp: req.headers["X-Timestamp"]!)
            #expect(MeshCrypto.verifyB64(publicKeySPKI: w.signer.publicKeyBase64, text: msg, signature: req.headers["X-Device-Signature"]!), "\(req.url.path)")
        }
        #expect(w.http.requests.first?.url.absoluteString == "https://hackutd.alecj.com/v1/server-info")
    }

    @Test func signedPathExcludesQueryString() throws {
        let w = World()
        w.config.deviceId = deviceId
        let req = try w.sync.client.makeRequest(method: "GET", path: "/v1/mesh/outbox", query: "limit=200", body: Data(), auth: true)
        #expect(req.url.absoluteString == "https://hackutd.alecj.com/v1/mesh/outbox?limit=200")
        let msg = RequestSigner.message(method: "GET", path: "/v1/mesh/outbox", body: Data(), timestamp: req.headers["X-Timestamp"]!)
        #expect(MeshCrypto.verifyB64(publicKeySPKI: w.signer.publicKeyBase64, text: msg, signature: req.headers["X-Device-Signature"]!))
        #expect(req.headers["Content-Type"] == nil)
    }

    @Test func unregisteredAuthCallThrows() {
        let w = World()
        #expect(throws: BackendError.notRegistered) { try w.sync.client.makeRequest(method: "GET", path: "/v1/x", body: Data(), auth: true) }
    }

    @Test func ownSosGoesDirectAndOthersGoThroughBatchWithPerItemResults() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo()), nowMs: t0)
        let own = try w.router.originate(category: .trapped, text: "help", lat: 32.9857, lng: -96.7501, accuracy: 12, people: 2)
        // three envelopes from other phones: ok, rejected for good, rate limited
        let other = FakeNetwork(backend: w.backend)
        other.nowMs = t0
        other.add("X")
        var ids: [String] = []
        for _ in 0..<3 {
            let m = try other.nodes["X"]!.originate(category: .safe, lat: 1, lng: 2)
            w.router.receive(m.envelope.forwarded(by: "AAAA").toBytes(), from: "p")
            ids.append(m.id)
        }
        #expect(w.router.pendingUploads.count == 4)
        w.serve { body in
            let envs = body["envelopes"]!.arrayValue!
            #expect(envs.count == 3, "own SOS already went to /v1/sos")
            let statuses: [(String, String?)] = [("created", nil), ("rejected", "bad_signature"), ("rejected", "rate_limited")]
            return .object(["results": .array(envs.map { e in
                let s = statuses[ids.firstIndex(of: e["id"]!.stringValue!)!]
                var o: [String: JSONValue] = ["id": e["id"]!, "status": .string(s.0)]
                if let r = s.1 { o["reason"] = .string(r) }
                return .object(o)
            })])
        }
        await w.sync.flushUploadsForTest()
        #expect(w.http.paths().contains("POST /v1/sos"))
        let direct = w.http.requests.first { $0.url.path == "/v1/sos" }!
        let b = JSONValue.parse(direct.body)!
        #expect(b["id"]?.stringValue == own.id && b["channel"]?.stringValue == "app" && b["category"]?.stringValue == "trapped")
        #expect(b["trapped"]?.boolValue == true && b["people_count"]?.intValue == 2 && b["text"]?.stringValue == "help")
        #expect(b["created_at"]?.stringValue == own.envelope.createdAt)
        let msgs = Dictionary(uniqueKeysWithValues: w.router.messages.map { ($0.id, $0) })
        #expect(msgs[own.id]?.uploaded == true)
        #expect(msgs[ids[0]]?.uploaded == true)
        #expect(msgs[ids[1]]?.uploaded == false && msgs[ids[1]]?.rejectedReason == "bad_signature")
        #expect(msgs[ids[2]]?.uploaded == false && msgs[ids[2]]?.rejectedReason == nil, "rate_limited stays queued")
        #expect(w.router.pendingUploads.map(\.id) == [ids[2]])
        #expect(w.config.lastUploadAtMs == t0)
    }

    @Test func batchResponseReceiptsAndMessagesAreInjectedIntoTheMesh() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        let relayed = FakeNetwork(backend: w.backend)
        relayed.nowMs = t0
        relayed.add("X")
        let m = try relayed.nodes["X"]!.originate(category: .safe, lat: 1, lng: 2)
        w.router.receive(m.envelope.forwarded(by: "AAAA").toBytes(), from: "p")
        let sosId = Uuid7.generate()
        let receipt = w.backend.receipt(sosId: sosId, atMs: t0)
        let msg = w.backend.message(kind: "status_update", sosId: sosId, body: ["status": .string("assigned")], createdMs: t0)
        w.serve { body in
            .object(["results": .array([.object(["id": body["envelopes"]![.init(0)]!["id"]!, "status": .string("created")])]),
                     "receipts": .array([receipt.toJSON()]), "messages": .array([msg.toJSON()])])
        }
        await w.sync.flushUploadsForTest()
        #expect(w.router.backendItems.count == 2)
        #expect(w.router.backendItems.allSatisfy { $0.verified })
    }

    @Test func outboxPollInjectsAndTransportFailureBacksOff() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo()), nowMs: t0)
        let msg = w.backend.message(kind: "checkin_request", sosId: Uuid7.generate(), checkinId: Uuid7.generate(), body: ["message": .string("ok?")], createdMs: t0)
        w.serve()
        let base = w.http.handler
        w.http.handler = { req in req.url.path == "/v1/mesh/outbox" ? json(200, .object(["data": .array([msg.toJSON()])])) : base(req) }
        await w.sync.runCycle()
        #expect(w.router.backendItems.count == 1)
        #expect(w.sync.lastError == nil && w.sync.backoff.failures == 0)

        w.http.handler = { _ in json(503, .object(["code": .string("unavailable")])) }
        await w.sync.runCycle()
        #expect(w.sync.backoff.failures == 1 && w.sync.lastError == "HTTP 503 unavailable")
        #expect(w.sync.nextAttemptAtMs == t0 + 5000)
        w.box.ms += 6000
        await w.sync.runCycle()
        #expect(w.sync.nextAttemptAtMs == t0 + 6000 + 10_000)

        w.http.handler = { _ in json(429, .object(["code": .string("rate_limited")]), headers: ["retry-after": "120"]) }
        await w.sync.runCycle()
        #expect(w.sync.nextAttemptAtMs == w.box.ms + 120_000)
    }

    @Test func unknownDeviceResetsRegistration() async {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo()), nowMs: t0)
        w.http.handler = { _ in json(401, .object(["code": .string("unauthorized")])) }
        await w.sync.runCycle()
        #expect(w.config.deviceId == nil)
    }

    @Test func statusPollingAppliesVictimStatus() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo()), nowMs: t0)
        let own = try w.router.originate(category: .trapped, lat: 1, lng: 2)
        w.router.markUploaded(own.id)
        w.serve()
        let base = w.http.handler
        w.http.handler = { req in
            if req.url.path == "/v1/sos/\(own.id)/status" {
                return json(200, .object(["id": .string(own.id), "status": .string("en_route"), "reached_responders": .bool(true),
                                          "eta_minutes": .int(40), "message": .string("Help is on the way, ETA 40 min"),
                                          "updated_at": .string(Iso.format(t0))]))
            }
            return base(req)
        }
        await w.sync.runCycle()
        let st = try #require(w.router.messages.first { $0.id == own.id }?.serverStatus)
        #expect(st.status == "en_route" && st.etaMinutes == 40 && st.reachedResponders)
    }

    @Test func heartbeatOnlineUsesRestAndOfflineUsesMeshEnvelope() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo()), nowMs: t0)   // event active, interval 60 s
        w.sync.sample = { HeartbeatSample(lat: 32.9857, lng: -96.7501, batteryPct: 41, charging: false, moving: false) }
        w.serve()
        #expect(await w.sync.heartbeatIfDue())
        let hb = try #require(w.http.requests.first { $0.url.path == "/v1/heartbeats" })
        let body = JSONValue.parse(hb.body)!
        #expect(body["battery_pct"]?.intValue == 41 && body["seq"]?.intValue == 1)
        #expect(body["approx"]?["lat"]?.doubleValue == 32.985 && body["approx"]?["radius_m"]?.intValue == 1000)
        #expect(body["sent_at"]?.stringValue == Iso.format(t0))
        #expect(hb.headers["X-Device-Signature"] != nil)
        // not due again yet
        #expect(await w.sync.heartbeatIfDue() == false)
        // offline later: becomes a kind=heartbeat envelope stored for the mesh
        w.box.ms += 61_000
        w.sync.reachable = false
        #expect(await w.sync.heartbeatIfDue())
        let env = try #require(w.router.messages.first { $0.envelope.kind == "heartbeat" }).envelope
        #expect(env.tier == "heartbeat" && env.maxHops == 2)
        #expect(try w.backend.decrypt(env)["heartbeat"]?["seq"]?.intValue == 2)
    }

    @Test func heartbeatGoesOutWithoutActiveEventButNeverWithoutLocation() async {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.serve()
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        #expect(w.config.eventActive == false)
        #expect(await w.sync.heartbeatIfDue(), "no event known: still heartbeats (automatic liveness)")
        w.box.ms += 400_000
        w.sync.sample = { nil }
        #expect(await w.sync.heartbeatIfDue() == false, "no location")
    }

    @Test func heartbeatCarriesTransportNetworkPeersGatewayAndOpenSos() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo(event: false)), nowMs: t0)
        let sos = try w.router.originate(category: .trapped, lat: 1, lng: 2)
        w.router.markUploaded(sos.id)
        w.sync.interface = .cellular
        w.router.peerConnected("peer-a"); w.router.peerConnected("peer-b"); w.router.peerConnected("peer-a")
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        w.serve()
        #expect(await w.sync.heartbeatIfDue())
        let body = JSONValue.parse(try #require(w.http.requests.first { $0.url.path == "/v1/heartbeats" }).body)!
        #expect(body["transport"]?.stringValue == "direct" && body["network"]?.stringValue == "cellular")
        #expect(body["peers_nearby"]?.intValue == 2 && body["gateway"]?.boolValue == true)
        #expect(body["open_sos_ids"]?.arrayValue?.compactMap(\.stringValue) == [sos.id])
        // offline: the mesh envelope says transport mesh / network none / gateway false
        w.box.ms += 400_000
        w.sync.reachable = false
        #expect(await w.sync.heartbeatIfDue())
        let env = try #require(w.router.messages.first { $0.envelope.kind == "heartbeat" }).envelope
        let hb = try #require(try w.backend.decrypt(env)["heartbeat"])
        #expect(hb["transport"]?.stringValue == "mesh" && hb["network"]?.stringValue == "none" && hb["gateway"]?.boolValue == false)
    }

    @Test func forcedHeartbeatIgnoresTheIntervalAndNotFoundBacksOff() async {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        w.config.update(ServerInfo.fromJSON(w.serverInfo(event: false)), nowMs: t0)
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        w.serve()
        #expect(await w.sync.heartbeatIfDue())
        #expect(await w.sync.heartbeatIfDue() == false)
        #expect(await w.sync.heartbeatIfDue(force: true), "connectivity returned / SOS created")
        // server: no event and no open SOS -> 404; no mesh fallback, retried a full interval later
        w.http.handler = { _ in json(404, .object(["code": .string("not_found")])) }
        w.box.ms += 400_000
        #expect(await w.sync.heartbeatIfDue() == false)
        #expect(w.router.messages.allSatisfy { $0.envelope.kind != "heartbeat" })
        #expect(await w.sync.heartbeatIfDue() == false)
        #expect(w.http.requests.filter { $0.url.path == "/v1/heartbeats" }.count == 3, "second call after 404 is not due")
    }

    @Test func heartbeatReplyAndPollFeedWelfareWithoutDuplicates() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        let welfare = WelfareManager(store: InMemoryWelfareStore(), now: { w.box.ms })
        w.sync.welfare = welfare
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        let c = JSONValue.object(["id": .string("c1"), "sos_id": .string("s1"), "kind": .string("welfare"), "channel": .string("app"),
                                  "sent_at": .string(Iso.format(t0)), "deadline_at": .string(Iso.format(t0 + 300_000)),
                                  "choices": .array(WelfareResponse.all.map(JSONValue.string)), "attempt": .int(1)])
        w.serve()
        let base = w.http.handler
        w.http.handler = { req in
            switch req.url.path {
            case "/v1/heartbeats": return json(202, .object(["event_active": .bool(false), "pending_checkins": .array([c])]))
            case "/v1/checkins/pending": return json(200, .object(["data": .array([c])]))
            default: return base(req)
            }
        }
        await w.sync.runCycle()
        #expect(welfare.pending().map(\.checkinId) == ["c1"])
        #expect(welfare.all().count == 1)
    }

    @Test func answerOnlineUsesPatchAndMarksAnsweredAtOnce() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        let welfare = WelfareManager(store: InMemoryWelfareStore(), now: { w.box.ms })
        w.sync.welfare = welfare
        w.router.welfare = welfare
        welfare.ingest([WelfareCheckin(checkinId: "0192a7f0-0000-7000-8000-0000000000c1", sosId: "s1", sentAtMs: t0, deadlineAtMs: t0 + 300_000, receivedAtMs: t0)])
        let id = "0192a7f0-0000-7000-8000-0000000000c1"
        w.http.handler = { req in req.method == "PATCH" ? json(200, .object(["id": .string(id)])) : json(404, .object([:])) }
        let out = await w.sync.answerCheckin(id, response: WelfareResponse.needUrgentHelp)
        #expect(out == .delivered)
        let patch = try #require(w.http.requests.first)
        #expect(patch.method == "PATCH" && patch.url.path == "/v1/checkins/\(id)")
        let b = JSONValue.parse(patch.body)!
        #expect(b["response"]?.stringValue == "need_urgent_help" && b["responded_at"]?.stringValue != nil)
        #expect(welfare.find(id)?.answer == "need_urgent_help" && welfare.find(id)?.delivered == true)
        #expect(welfare.pending().isEmpty && w.router.messages.isEmpty)
        #expect(await w.sync.answerCheckin(id, response: "still_here") == .ignored, "already answered")
    }

    @Test func answerOfflineSendsMeshEnvelopeAndNoLongerNeedHelpResolvesLocally() async throws {
        let w = World(builtInKeys: true)
        let welfare = WelfareManager(store: InMemoryWelfareStore(), now: { w.box.ms })
        w.sync.welfare = welfare
        w.router.welfare = welfare
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        let own = try w.router.originate(category: .trapped, lat: 1, lng: 2)
        let id = "0192a7f0-0000-7000-8000-0000000000c2"
        welfare.ingest([WelfareCheckin(checkinId: id, sosId: own.id, sentAtMs: t0, deadlineAtMs: t0 + 300_000, receivedAtMs: t0)])
        w.sync.reachable = false
        #expect(await w.sync.answerCheckin(id, response: WelfareResponse.noLongerNeedHelp) == .meshSent)
        let env = try #require(w.router.messages.first { $0.envelope.kind == "checkin_reply" }).envelope
        #expect(env.tier == "normal")
        let plain = try w.backend.decrypt(env)
        #expect(plain["checkin_id"]?.stringValue == id && plain["response"]?.stringValue == "no_longer_need_help")
        let st = try #require(w.router.messages.first { $0.id == own.id }?.serverStatus)
        #expect(st.status == "resolved" && st.message == "Marked as resolved. Stay safe.")
        #expect(welfare.find(id)?.meshReplied == true)
        // coming online later: the PATCH is retried and 409 clears it
        w.sync.reachable = true
        w.config.deviceId = deviceId
        w.http.handler = { _ in json(409, .object(["code": .string("conflict")])) }
        await w.sync.flushCheckinReplies()
        #expect(welfare.find(id)?.delivered == true)
    }

    @Test func replyRetriesWithBackoffAfterServerErrorAndLateAnswerStillSends() async throws {
        let w = World(builtInKeys: true)
        w.config.deviceId = deviceId
        let welfare = WelfareManager(store: InMemoryWelfareStore(), now: { w.box.ms })
        w.sync.welfare = welfare
        w.sync.sample = { HeartbeatSample(lat: 1, lng: 2) }
        let id = "0192a7f0-0000-7000-8000-0000000000c3"
        welfare.ingest([WelfareCheckin(checkinId: id, sosId: "s1", sentAtMs: t0, deadlineAtMs: t0 + 300_000, receivedAtMs: t0)])
        w.box.ms = t0 + 400_000        // overdue
        w.http.handler = { _ in json(503, .object(["code": .string("unavailable")])) }
        #expect(await w.sync.answerCheckin(id, response: "still_here") == .retryLater, "overdue answers are accepted")
        let p = try #require(welfare.find(id))
        #expect(p.replyAttempts == 1 && p.nextReplyAtMs == t0 + 400_000 + 10_000 && p.meshReplied)
        #expect(welfare.dueReplies().isEmpty)
        w.box.ms += 11_000
        w.http.handler = { _ in json(200, .object([:])) }
        await w.sync.flushCheckinReplies()
        #expect(welfare.find(id)?.delivered == true)
    }

    @Test func offlineForcedMeansNoNetworkCalls() async {
        let w = World()
        w.serve()
        w.sync.forceOffline = true
        await w.sync.runCycle()
        #expect(w.http.requests.isEmpty)
    }

    @Test func backoffSchedule() {
        var b = Backoff()
        #expect(b.fail() == 5 && b.fail() == 10 && b.fail() == 20)
        for _ in 0..<10 { _ = b.fail() }
        #expect(b.delaySeconds == 300)
        #expect(b.fail(retryAfter: 900) == 900)
        b.succeed()
        #expect(b.delaySeconds == 0)
    }
}

@Suite struct StoreMigrationTests {
    private func tmp() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("beacon-\(UUID().uuidString).json") }

    @Test func legacyV1ArrayFileIsMovedAsideNotFatal() throws {
        let url = tmp()
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(at: url.appendingPathExtension("v1.bak")) }
        try Data(#"[{"id":"x","envelope":{"v":1,"signed":"e30=","sig":"AA==","hop":1,"path":["A1"]},"header":{},"receivedAt":1,"uploaded":false,"isOwn":false}]"#.utf8).write(to: url)
        let store = FileMessageStore(url: url)
        #expect(store.all().isEmpty)
        #expect(FileManager.default.fileExists(atPath: url.appendingPathExtension("v1.bak").path))
        // and the new store works afterwards
        let net = FakeNetwork()
        net.add("A")
        let m = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        store.save(m)
        #expect(FileMessageStore(url: url).all().map(\.id) == [m.id])
    }

    @Test func garbageAndBadRowsAreSkipped() throws {
        let url = tmp()
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(at: url.appendingPathExtension("v1.bak")) }
        try Data("{{{ nope".utf8).write(to: url)
        #expect(FileMessageStore(url: url).all().isEmpty)
        try Data(#"{"version":2,"messages":[{"id":"bad"},42],"backend":[null]}"#.utf8).write(to: url)
        let s = FileMessageStore(url: url)
        #expect(s.all().isEmpty && s.allBackend().isEmpty)
    }

    @Test func roundTripKeepsEverything() throws {
        let url = tmp()
        defer { try? FileManager.default.removeItem(at: url) }
        let net = FakeNetwork()
        net.add("A")
        let store = FileMessageStore(url: url)
        let m = try net.nodes["A"]!.originate(category: .trapped, text: "é中", lat: 32.9857, lng: -96.7501, accuracy: 5, people: 3)
        store.save(m)
        store.update(m.id) { $0.serverStatus = SosStatus(status: "en_route", reachedResponders: true, etaMinutes: 40, message: "hi", updatedAtMs: 7); $0.sentToPeers = 2 }
        let bm = net.backend.message(kind: "delivered", sosId: m.id, body: [:], createdMs: net.nowMs)
        store.saveBackend(StoredBackend(id: bm.id, payload: .message(bm), receivedAt: 1, expiresAtMs: bm.expiresAtMs, verified: true, addressedToMe: true))
        let reloaded = FileMessageStore(url: url)
        let got = try #require(reloaded.all().first)
        #expect(got.envelope == m.envelope)
        #expect(got.own?.text == "é中" && got.own?.people == 3 && got.serverStatus?.etaMinutes == 40 && got.sentToPeers == 2)
        #expect(reloaded.allBackend().first?.addressedToMe == true)
        reloaded.deleteExpired(nowMs: Int64.max)
        #expect(FileMessageStore(url: url).all().isEmpty)
    }
}

extension JSONValue {
    /// Array index helper for tests.
    init(_ index: Int) { self = .int(Int64(index)) }
    subscript(_ i: JSONValue) -> JSONValue? {
        if case .array(let a) = self, case .int(let n) = i, a.indices.contains(Int(n)) { return a[Int(n)] }
        return nil
    }
}
