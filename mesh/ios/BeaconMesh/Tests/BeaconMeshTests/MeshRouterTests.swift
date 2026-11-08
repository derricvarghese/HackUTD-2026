@testable import BeaconMesh
import Foundation
import Testing

@Suite struct MeshRouterTests {
    @Test func criticalSosTravelsWholeLine() throws {
        let net = FakeNetwork()
        net.line(["A", "B", "C", "D"])
        let msg = try net.nodes["A"]!.originate(category: .trapped, text: "2 people, water rising", lat: dallas.lat, lng: dallas.lng, people: 2)
        net.run()
        let atD = try #require(net.has("D", msg.id))
        #expect(atD.envelope.hopCount == 3)
        #expect(atD.envelope.hopPath == ["A", "B", "C"].map { net.nodes[$0]!.relayId })
        #expect(atD.envelope.maxHops == 10)
        #expect(atD.envelope.tier == "critical")
        #expect(atD.own == nil, "relays never see the plaintext")
        // the relayed copy still decrypts to the original payload at the backend
        let plain = try net.backend.decrypt(atD.envelope)
        #expect(plain["category"]?.stringValue == "trapped")
        #expect(plain["people_count"]?.intValue == 2)
        #expect(atD.envelope.routing["category"]?.stringValue == "trapped")
    }

    @Test func demoHopCapStopsNormalMessageAtThirdPhone() throws {
        let net = FakeNetwork()
        net.line(["A", "B", "C", "D"])
        let normal = try net.nodes["A"]!.originate(category: .checkin, lat: dallas.lat, lng: dallas.lng, nonCriticalHopCap: 2)
        net.run()
        #expect(normal.envelope.maxHops == 2)
        #expect(net.has("B", normal.id) != nil)
        let atC = try #require(net.has("C", normal.id))
        #expect(atC.envelope.hopCount == 2)
        #expect(!atC.canForward)
        #expect(net.has("D", normal.id) == nil, "hop limit should stop it at phone 3")
        let critical = try net.nodes["A"]!.originate(category: .trapped, lat: dallas.lat, lng: dallas.lng, nonCriticalHopCap: 2)
        net.run()
        #expect(net.has("D", critical.id) != nil, "critical ignores the demo cap")
        #expect(critical.envelope.maxHops == 10)
    }

    @Test func noBackendKeyRefusesAndNeverSendsPlaintext() throws {
        let net = FakeNetwork()
        net.add("A", withEncryptionKey: false)
        net.add("B")
        net.link("A", "B")
        #expect(throws: MeshError.noBackendKey) { try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2) }
        #expect(net.nodes["A"]!.messages.isEmpty)
        #expect(net.queue.isEmpty)
        #expect(net.configs["A"]!.encryptionKeyStatus == .none)
    }

    @Test func noLocationRefuses() {
        let net = FakeNetwork()
        net.add("A")
        #expect(throws: MeshError.noLocation) { try net.nodes["A"]!.originate(category: .safe, lat: nil, lng: nil) }
    }

    @Test func gatewayUploadsAndStopsRelaying() throws {
        let net = FakeNetwork()
        net.line(["A", "B", "C"])
        net.online = ["B"]
        let msg = try net.nodes["A"]!.originate(category: .injured, lat: dallas.lat, lng: dallas.lng)
        net.run()
        #expect(net.uploads["B"]?.map(\.id) == [msg.id])
        #expect(net.has("C", msg.id) == nil, "a gateway uploads and does not relay")
    }

    @Test func onlineOriginatorUploadsInsteadOfRelaying() throws {
        let net = FakeNetwork()
        net.line(["A", "B"])
        net.online = ["A"]
        let msg = try net.nodes["A"]!.originate(category: .safe, lat: dallas.lat, lng: dallas.lng)
        net.run()
        #expect(net.uploads["A"]?.map(\.id) == [msg.id])
        #expect(net.has("B", msg.id) == nil)
    }

    @Test func storeAndForwardToLatePeer() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        let msg = try net.nodes["A"]!.originate(category: .waterMeds, lat: dallas.lat, lng: dallas.lng)
        #expect(net.nodes["A"]!.messages.first?.sentToPeers == 0)
        net.link("A", "B")
        net.run()
        let atB = try #require(net.has("B", msg.id))
        #expect(atB.envelope.hopCount == 1)
        #expect(atB.envelope.maxHops == 7)
    }

    @Test func heldMessagesAreSentCriticalFirst() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        let safe = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        let crit = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        net.link("A", "B")
        let order = net.queue.compactMap { MeshEnvelope.decode($0.data)?.id }
        #expect(order == [crit.id, safe.id])
    }

    @Test func gatewayFlushesHeldMessagesWhenInternetReturns() throws {
        let net = FakeNetwork()
        net.line(["A", "B"])
        let m = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        net.run()
        net.online = ["B"]
        net.nodes["B"]!.internetBecameAvailable()
        #expect(net.uploads["B"]?.map(\.id) == [m.id])
        net.nodes["B"]!.markUploaded(m.id)
        #expect(net.nodes["B"]!.pendingUploads.isEmpty)
    }

    @Test func rejectedMessagesAreNotRetried() throws {
        let net = FakeNetwork()
        net.add("A")
        let m = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        #expect(net.nodes["A"]!.pendingUploads.count == 1)
        net.nodes["A"]!.markRejected(m.id, reason: "invalid_limits")
        #expect(net.nodes["A"]!.pendingUploads.isEmpty)
    }

    @Test func duplicateIsDropped() throws {
        let net = FakeNetwork()
        net.line(["A", "B"])
        let m = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        net.run()
        let again = m.envelope.forwarded(by: "ZZZZ").toBytes()
        #expect(net.nodes["B"]!.receive(again, from: "x") == .dropped(.duplicate))
    }

    @Test func tamperedMaxHopsFailsSignature() throws {
        let net = FakeNetwork()
        net.add("B")
        net.add("A")
        var env = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2).envelope.forwarded(by: "A1A1")
        env.maxHops = 10   // safe tier cap is 3; also covered by signature
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .dropped(.badSignature))
    }

    @Test func tamperedPayloadFailsSignature() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        var env = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2).envelope.forwarded(by: "A1A1")
        env.payload = Data(repeating: 9, count: 120).base64EncodedString()
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .dropped(.badSignature))
    }

    @Test func relayMutableFieldsDoNotAffectSignature() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        var env = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2).envelope.forwarded(by: "A1A1")
        env.hopPath = ["Q1Q1"]
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .accepted(forwardedTo: 0, uploaded: false))
    }

    @Test func hopOverMaxIsRejected() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        var env = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2).envelope
        env.hopCount = 4; env.hopPath = ["a", "b", "c", "d"]
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .dropped(.hopLimit))
    }

    @Test func hopResetWithoutPathIsRejected() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        var env = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2).envelope
        env.hopCount = 2; env.hopPath = ["a"]
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .dropped(.pathMismatch))
        env.hopCount = 0; env.hopPath = []
        #expect(net.nodes["B"]!.receive(env.toBytes(), from: "x") == .dropped(.hopLimit), "a relayed copy always has hop_count >= 1")
    }

    @Test func expiredIsDropped() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        let m = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        net.nowMs += 3 * 3_600_000 + 1000
        #expect(net.nodes["B"]!.receive(m.envelope.forwarded(by: "A1").toBytes(), from: "x") == .dropped(.expired))
    }

    @Test func tierKindMismatchAndTtlAboveTableAreInvalidLimits() throws {
        let net = FakeNetwork()
        net.add("A"); net.add("B")
        var env = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2).envelope.forwarded(by: "A1")
        env.kind = "heartbeat"                       // kind=heartbeat iff tier=heartbeat; signature breaks first when not re-signed
        let r = net.nodes["B"]!.receive(env.toBytes(), from: "x")
        #expect(r == .dropped(.limits) || r == .dropped(.badSignature))
        #expect(MeshValidation.validate(env, limits: .default, nowMs: net.nowMs) != nil)
    }

    @Test func garbageIsMalformed() {
        let net = FakeNetwork()
        net.add("A")
        #expect(net.nodes["A"]!.receive(Data("not json".utf8), from: "X") == .dropped(.malformed))
        #expect(net.nodes["A"]!.receive(Data(#"{"hello":1}"#.utf8), from: "X") == .dropped(.malformed))
    }

    @Test func pruneRemovesExpired() throws {
        let net = FakeNetwork()
        net.add("A")
        let m = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        net.nowMs += 4 * 3_600_000
        net.nodes["A"]!.pruneExpired()
        #expect(net.has("A", m.id) == nil)
    }

    @Test func unregisteredSenderUsesInlineKeyRegisteredUsesDeviceId() throws {
        let net = FakeNetwork()
        net.add("A")
        let m1 = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        #expect(m1.envelope.senderKeyId == net.nodes["A"]!.senderPublicKey)
        #expect(m1.envelope.senderPublicKey == net.nodes["A"]!.senderPublicKey)
        net.configs["A"]!.deviceId = "0192a000-0000-7000-8000-0000000000d1"
        let m2 = try net.nodes["A"]!.originate(category: .safe, lat: 1, lng: 2)
        #expect(m2.envelope.senderKeyId == "0192a000-0000-7000-8000-0000000000d1")
        // a relay can still verify it thanks to the inline key
        net.add("B")
        #expect(net.nodes["B"]!.receive(m2.envelope.forwarded(by: "A1").toBytes(), from: "x") == .accepted(forwardedTo: 0, uploaded: false))
    }

    @Test func heartbeatEnvelopeIsHeartbeatTierWithTwoHops() throws {
        let net = FakeNetwork()
        net.add("A")
        let hb = try net.nodes["A"]!.originateHeartbeat(lat: 1, lng: 2, batteryPct: 40, charging: false, moving: false, seq: 3)
        #expect(hb.envelope.kind == "heartbeat" && hb.envelope.tier == "heartbeat")
        #expect(hb.envelope.maxHops == 2)
        #expect(hb.envelope.expiresAtMs - hb.envelope.createdAtMs == 30 * 60_000)
        let plain = try net.backend.decrypt(hb.envelope)
        #expect(plain["heartbeat"]?["seq"]?.intValue == 3)
        #expect(plain["heartbeat"]?["battery_pct"]?.intValue == 40)
        #expect(plain["heartbeat"]?["approx"]?["radius_m"]?.intValue == 1000)
    }
}

@Suite struct HopTableTests {
    @Test func contractDefaults() {
        let l = HopLimits.default
        let expect: [(Tier, Int, Int64)] = [(.critical, 10, 24 * 3600), (.high, 7, 12 * 3600), (.normal, 5, 6 * 3600),
                                            (.safe, 3, 3 * 3600), (.heartbeat, 2, 30 * 60)]
        for (t, hops, ttl) in expect {
            #expect(l.maxHops(t) == hops)
            #expect(l.ttlMs(t) == ttl * 1000)
        }
    }

    @Test func categoriesMapToTiersAndApiCategories() {
        #expect(Category.trapped.tier == .critical && Category.trapped.apiCategory == "trapped")
        #expect(Category.medical.tier == .critical && Category.medical.apiCategory == "injured")
        #expect(Category.waterMeds.tier == .high && Category.waterMeds.apiCategory == "need_water_meds")
        #expect(Category.checkin.tier == .normal && Category.checkin.apiCategory == "other" && Category.checkin.kind == .sos)
        #expect(Category.safe.tier == .safe && Category.safe.kind == .safe)
    }

    @Test func serverProvidedTablePreferredAndPersisted() throws {
        let kv = MemoryKeyValueStore()
        let cfg = BackendConfig(store: kv)
        #expect(cfg.hopLimits == .default)
        let b = TestBackend()
        let info = ServerInfo.fromJSON(JSONValue.parse("""
        {"server_time":"2026-11-07T16:00:00.000Z","encryption_public_key":"\(b.encPublicB64)","signing_public_key":"\(b.signPublicB64)",
         "hop_limits":[{"tier":"critical","max_hops":8,"ttl_seconds":3600},{"tier":"safe","max_hops":0,"ttl_seconds":1},{"tier":"bogus","max_hops":3,"ttl_seconds":3}],
         "heartbeat_interval_seconds":120,"silence_threshold_seconds":900,"gateway_upload_max_batch":50,"event":{"id":"x","name":"Flood"}}
        """)!)
        cfg.update(info, nowMs: 5)
        let fresh = BackendConfig(store: kv)          // reload from persisted values
        #expect(fresh.hopLimits.maxHops(.critical) == 8)
        #expect(fresh.hopLimits.ttlMs(.critical) == 3_600_000)
        #expect(fresh.hopLimits.maxHops(.safe) == 3, "invalid row ignored, default kept")
        #expect(fresh.heartbeatIntervalSeconds == 120)
        #expect(fresh.maxBatch == 50)
        #expect(fresh.eventActive)
        #expect(fresh.encryptionKeyStatus == .cached && fresh.encryptionKey == b.encPublicB64)
        #expect(fresh.signingKeyStatus == .cached)
    }

    @Test func routerUsesServerTableAndCap() throws {
        let net = FakeNetwork()
        net.add("A")
        net.configs["A"]!.update(ServerInfo(serverTimeMs: nil, encryptionPublicKey: nil, signingPublicKey: nil,
                                            hopLimits: HopLimits(rows: [.critical: (8, 3_600_000)]), eventActive: true, eventName: nil,
                                            checkinIntervalSeconds: nil, heartbeatIntervalSeconds: nil, silenceThresholdSeconds: nil,
                                            gatewayUploadMaxBatch: nil), nowMs: 1)
        let m = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        #expect(m.envelope.maxHops == 8)
        #expect(m.envelope.expiresAtMs - m.envelope.createdAtMs == 3_600_000)
        // the cap can only lower the table value and never applies to critical
        let n = try net.nodes["A"]!.originate(category: .other, lat: 1, lng: 2, nonCriticalHopCap: 9)
        #expect(n.envelope.maxHops == 5)
    }

    @Test func keyFallbackAndValidation() {
        let b = TestBackend()
        let cfg = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: b.encPublicB64)
        #expect(cfg.encryptionKeyStatus == .builtIn)
        let garbage = BackendConfig(store: MemoryKeyValueStore(), builtInEncryptionKey: "$(BEACON_ENC_PUBLIC_KEY)")
        #expect(garbage.encryptionKeyStatus == .none && garbage.encryptionKey == nil)
        // a garbage key from the server must not replace a good one
        let kv = MemoryKeyValueStore()
        let c = BackendConfig(store: kv, builtInEncryptionKey: b.encPublicB64)
        c.update(ServerInfo.fromJSON(JSONValue.parse(#"{"encryption_public_key":"AAAA","hop_limits":[]}"#)!), nowMs: 1)
        #expect(c.encryptionKeyStatus == .builtIn)
    }
}

@Suite struct BackendMessageHandlingTests {
    private func setup() throws -> (net: FakeNetwork, sos: StoredMessage) {
        let net = FakeNetwork()
        net.line(["A", "B", "C"])
        let sos = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        net.run()
        return (net, sos)
    }

    @Test func statusUpdateReachesTheAddressedPhoneOverTheMesh() throws {
        let (net, sos) = try setup()
        let m = net.backend.message(kind: "status_update", sosId: sos.id,
                                    body: ["status": .string("en_route"), "eta_minutes": .int(40), "message": .string("Help is on the way, ETA 40 min")],
                                    createdMs: net.nowMs)
        // a gateway (C) injects it; it travels C -> B -> A
        #expect(net.nodes["C"]!.inject(messages: [m], receipts: []) == 1)
        net.run()
        let st = try #require(net.has("A", sos.id)?.serverStatus)
        #expect(st.status == "en_route" && st.etaMinutes == 40 && st.reachedResponders)
        #expect(st.message == "Help is on the way, ETA 40 min")
        #expect(net.has("A", sos.id)?.uploaded == true)
        let item = try #require(net.nodes["A"]!.backendItems.first)
        #expect(item.verified && item.addressedToMe)
        // B only relayed it
        #expect(net.nodes["B"]!.backendItems.first?.addressedToMe == false)
        // hop bookkeeping: A got it after 2 transmissions
        if case .message(let got) = item.payload { #expect(got.hopCount == 2 && got.hopPath.count == 2) }
    }

    @Test func deliveredReceiptMarksReachedResponders() throws {
        let (net, sos) = try setup()
        let r = net.backend.receipt(sosId: sos.id, atMs: net.nowMs)
        net.nodes["C"]!.inject(messages: [], receipts: [r])
        net.run()
        let m = try #require(net.has("A", sos.id))
        #expect(m.serverStatus?.reachedResponders == true)
        #expect(m.uploaded)
    }

    @Test func checkinRequestSurfacesAPromptOnlyOnTheAddressedPhone() throws {
        let (net, sos) = try setup()
        var prompts: [String] = []
        net.nodes["A"]!.onCheckinRequest = { prompts.append(CheckinPrompt.from($0)?.checkinId ?? "?") }
        var other: [String] = []
        net.nodes["B"]!.onCheckinRequest = { _ in other.append("B") }
        let cm = net.backend.message(kind: "checkin_request", sosId: sos.id, checkinId: "0192a7f0-0000-7000-8000-0000000000c1",
                                     body: ["message": .string("Are you OK?"), "deadline_at": .string(Iso.format(net.nowMs + 900_000))],
                                     createdMs: net.nowMs)
        net.nodes["C"]!.inject(messages: [cm], receipts: [])
        net.run()
        #expect(prompts == ["0192a7f0-0000-7000-8000-0000000000c1"])
        #expect(other.isEmpty)
        #expect(net.nodes["A"]!.pendingCheckins.count == 1)
        #expect(net.nodes["B"]!.pendingCheckins.isEmpty)
        net.nodes["A"]!.markCheckinAnswered(checkinId: "0192a7f0-0000-7000-8000-0000000000c1")
        #expect(net.nodes["A"]!.pendingCheckins.isEmpty)
    }

    @Test func forgedSignatureIsDropped() throws {
        let (net, sos) = try setup()
        var m = net.backend.message(kind: "status_update", sosId: sos.id, body: ["status": .string("resolved")], createdMs: net.nowMs)
        m.body = .object(["status": .string("closed")])          // tampered after signing
        #expect(net.nodes["B"]!.receive(m.forwarded(by: "Q1").toJSON().serializedData(), from: "x") == .dropped(.badSignature))
        let evil = TestBackend().message(kind: "delivered", sosId: sos.id, body: [:], createdMs: net.nowMs)
        #expect(net.nodes["A"]!.receive(evil.forwarded(by: "Q1").toJSON().serializedData(), from: "x") == .dropped(.badSignature))
        #expect(net.has("A", sos.id)?.serverStatus == nil)
    }

    @Test func withoutSigningKeyItIsRelayedButNeverShown() throws {
        let net = FakeNetwork()
        net.add("A", withSigningKey: false)
        net.add("B", withSigningKey: false)
        net.link("A", "B")
        let sos = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        net.run()
        let m = net.backend.message(kind: "status_update", sosId: sos.id, body: ["status": .string("en_route")], createdMs: net.nowMs)
        net.nodes["B"]!.inject(messages: [m], receipts: [])      // injection verifies too: nothing to verify with
        #expect(net.nodes["B"]!.backendItems.count == 1 && net.nodes["B"]!.backendItems[0].verified == false)
        net.run()
        #expect(net.has("A", sos.id)?.serverStatus == nil, "unverified status must not be shown")
        #expect(net.nodes["A"]!.backendItems.first?.verified == false)
    }

    @Test func unverifiedItemIsActedOnceTheSigningKeyArrives() throws {
        let net = FakeNetwork()
        net.add("A", withSigningKey: false)
        net.add("B", withSigningKey: false)
        net.link("A", "B")
        let sos = try net.nodes["A"]!.originate(category: .trapped, lat: 1, lng: 2)
        net.run()
        let m = net.backend.message(kind: "status_update", sosId: sos.id, body: ["status": .string("en_route"), "eta_minutes": .int(9)], createdMs: net.nowMs)
        net.nodes["B"]!.inject(messages: [m], receipts: [])
        net.run()
        #expect(net.has("A", sos.id)?.serverStatus == nil)
        // A learns the signing key (server-info) and re-checks what it holds
        let info = ServerInfo(serverTimeMs: nil, encryptionPublicKey: nil, signingPublicKey: net.backend.signPublicB64, hopLimits: .default,
                              eventActive: false, eventName: nil, checkinIntervalSeconds: nil, heartbeatIntervalSeconds: nil,
                              silenceThresholdSeconds: nil, gatewayUploadMaxBatch: nil)
        net.configs["A"]!.update(info, nowMs: 1)
        net.nodes["A"]!.reverifyBackend()
        #expect(net.has("A", sos.id)?.serverStatus?.etaMinutes == 9)
        #expect(net.nodes["A"]!.backendItems.first?.verified == true)
    }

    @Test func buildDefaultKeysAreValidP256() {
        for k in [BackendBuildConfig.defaultEncryptionPublicKey, BackendBuildConfig.defaultSigningPublicKey] {
            #expect(MeshCrypto.isValidP256SPKI(Data(base64Encoded: k)!))
        }
        #expect(BackendBuildConfig.value("X", in: ["X": "$(X)"]) == "")
        #expect(BackendBuildConfig.backendHost == "hackutd.alecj.com")
    }

    @Test func dedupeExpiryAndHopChecks() throws {
        let (net, sos) = try setup()
        let m = net.backend.message(kind: "status_update", sosId: sos.id, body: ["status": .string("assigned")], createdMs: net.nowMs)
        let wire = m.forwarded(by: "Q1").toJSON().serializedData()
        #expect(net.nodes["B"]!.receive(wire, from: "x") == .accepted(forwardedTo: 1, uploaded: false) || net.nodes["B"]!.backendItems.count == 1)
        #expect(net.nodes["B"]!.receive(wire, from: "x") == .dropped(.duplicate))
        var expired = net.backend.message(kind: "status_update", sosId: sos.id, body: [:], createdMs: net.nowMs - 7 * 3_600_000)
        expired = expired.forwarded(by: "Q1")
        #expect(net.nodes["C"]!.receive(expired.toJSON().serializedData(), from: "x") == .dropped(.expired))
        var tooFar = net.backend.message(kind: "status_update", sosId: sos.id, body: [:], createdMs: net.nowMs)
        tooFar.hopCount = 6; tooFar.hopPath = Array(repeating: "Q", count: 6)
        #expect(net.nodes["C"]!.receive(tooFar.toJSON().serializedData(), from: "x") == .dropped(.hopLimit))
        var noPath = net.backend.message(kind: "status_update", sosId: sos.id, body: [:], createdMs: net.nowMs)
        noPath.hopCount = 2
        #expect(net.nodes["C"]!.receive(noPath.toJSON().serializedData(), from: "x") == .dropped(.pathMismatch))
    }

    @Test func storeAndForwardIncludesBackendMessagesEvenWhenOnline() throws {
        let net = FakeNetwork()
        net.add("G"); net.add("P")
        net.online = ["G"]
        let m = net.backend.message(kind: "status_update", sosId: Uuid7.generate(), body: ["status": .string("assigned")], createdMs: net.nowMs)
        net.nodes["G"]!.inject(messages: [m], receipts: [])
        net.link("G", "P")
        net.run()
        #expect(net.nodes["P"]!.backendItems.count == 1)
        if case .message(let got) = net.nodes["P"]!.backendItems[0].payload { #expect(got.hopCount == 1) }
    }

    @Test func wireDispatchDistinguishesTheThreeShapes() throws {
        let b = TestBackend()
        let m = b.message(kind: "delivered", sosId: Uuid7.generate(), body: [:], createdMs: 1).forwarded(by: "A1")
        let r = b.receipt(sosId: Uuid7.generate(), atMs: 1).forwarded(by: "A1")
        if case .backendMessage = MeshWire.decode(m.toJSON().serializedData()) {} else { Issue.record("message") }
        if case .receipt = MeshWire.decode(r.toJSON().serializedData()) {} else { Issue.record("receipt") }
        #expect(MeshWire.decode(Data(#"{"foo":1}"#.utf8)) == nil)
    }
}

@Suite struct FramingTests {
    @Test func chunkAndReassembleOutOfOrder() {
        let payload = Data((0..<1500).map { UInt8($0 % 251) })
        let frames = Framing.chunk(payload, transferId: 0xDEADBEEF, maxWriteLength: 182)
        #expect(frames.count == Int((1500.0 / 173.0).rounded(.up)))
        #expect(frames.allSatisfy { $0.count <= 182 })
        let r = Reassembler()
        var out: Data?
        for f in frames.reversed() { out = r.ingest(f, from: "p") ?? out }
        #expect(out == payload)
    }

    @Test func singleChunkHeaderBytes() {
        let frames = Framing.chunk(Data("hi".utf8), transferId: 1, maxWriteLength: 100)
        #expect(frames.count == 1)
        #expect(Array(frames[0].prefix(9)) == [0x01, 0, 0, 0, 1, 0, 0, 0, 1])
        #expect(Reassembler().ingest(frames[0], from: "p") == Data("hi".utf8))
    }

    @Test func stalePartialIsPurged() {
        let frames = Framing.chunk(Data(repeating: 7, count: 300), transferId: 9, maxWriteLength: 100)
        let r = Reassembler(timeout: 30)
        let t0 = Date()
        #expect(r.ingest(frames[0], from: "p", now: t0) == nil)
        for f in frames.dropFirst() { #expect(r.ingest(f, from: "p", now: t0.addingTimeInterval(31)) == nil) }
    }

    @Test func oversizedPayloadYieldsNoFramesInsteadOfCrashing() {
        #expect(Framing.chunk(Data(repeating: 1, count: 5000), transferId: 1, maxWriteLength: 20).isEmpty)
    }

    @Test func helloFramesAreNotEnvelopeFrames() {
        let hello = InstanceId.helloFrame(for: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")!
        #expect(hello.count == 17 && hello[0] == 0x02)
        #expect(Reassembler().ingest(hello, from: "p") == nil)
        #expect(InstanceId.parseHello(hello) == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        #expect(InstanceId.parseHello(Data([0x01]) + hello.dropFirst()) == nil)
    }

    @Test func instanceIdBytesAreRfc4122Order() {
        let id = "00112233-4455-6677-8899-aabbccddeeff"
        #expect(Array(InstanceId.bytes(of: id)!) == [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
        #expect(InstanceId.id(fromBytes: InstanceId.bytes(of: id)!) == id)
        #expect(InstanceId.id(fromBytes: Data(count: 15)) == nil)
    }
}

@Suite struct PeerRegistryTests {
    let me = "11111111-1111-1111-1111-111111111111"
    let peerA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    let peerB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

    @Test func acceptsNewPhone() {
        let r = PeerRegistry(ownId: me)
        #expect(r.identify(address: "AA:01", id: peerA) == .accept(id: peerA))
        #expect(r.count == 1)
        #expect(r.addressFor(id: peerA) == "AA:01")
    }

    @Test func samePhoneUnderRotatedAddressIsADuplicateNotAGhost() {
        let r = PeerRegistry(ownId: me)
        _ = r.identify(address: "AA:01", id: peerA)
        #expect(r.identify(address: "AA:02", id: peerA) == .duplicate(id: peerA, existingAddress: "AA:01"))
        #expect(r.count == 1)
        #expect(r.addressFor(id: peerA) == "AA:01")
        #expect(r.idFor(address: "AA:02") == nil)
    }

    @Test func identifyingTheSameLinkTwiceIsFine() {
        let r = PeerRegistry(ownId: me)
        _ = r.identify(address: "AA:01", id: peerA)
        #expect(r.identify(address: "AA:01", id: peerA) == .accept(id: peerA))
        #expect(r.count == 1)
    }

    @Test func ownIdIsRecognisedCaseInsensitively() {
        let r = PeerRegistry(ownId: me)
        #expect(r.identify(address: "AA:09", id: me.uppercased()) == .selfId)
        #expect(r.count == 0)
    }

    @Test func twoDifferentPhonesCountSeparately() {
        let r = PeerRegistry(ownId: me)
        _ = r.identify(address: "AA:01", id: peerA)
        _ = r.identify(address: "BB:01", id: peerB)
        #expect(r.count == 2)
        #expect(r.ids == [peerA, peerB])
    }

    @Test func releaseFreesThePhoneSoItCanReconnectOnANewAddress() {
        let r = PeerRegistry(ownId: me)
        _ = r.identify(address: "AA:01", id: peerA)
        #expect(r.release(address: "AA:01") == peerA)
        #expect(r.count == 0)
        #expect(r.identify(address: "AA:02", id: peerA) == .accept(id: peerA))
    }

    @Test func releasingADuplicateAddressDoesNotRemoveTheRealLink() {
        let r = PeerRegistry(ownId: me)
        _ = r.identify(address: "AA:01", id: peerA)
        _ = r.identify(address: "AA:02", id: peerA)
        #expect(r.release(address: "AA:02") == nil)
        #expect(r.count == 1)
    }

    @Test func legacyPeersKeyOnAddress() {
        let r = PeerRegistry(ownId: me)
        let id = PeerRegistry.legacyId("CC:01")
        #expect(id == "addr:CC:01")
        #expect(r.identify(address: "CC:01", id: id) == .accept(id: id))
    }
}
