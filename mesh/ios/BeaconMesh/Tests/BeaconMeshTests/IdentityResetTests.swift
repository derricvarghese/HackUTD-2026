@testable import BeaconMesh
import Foundation
import Testing

private final class Log { var events: [String] = [] }

private final class FakeKeys: DeviceKeyRotating {
    let log: Log
    var fail = false
    var made: [P256Signer] = []
    init(_ log: Log) { self.log = log }
    func rotateSigningKey() throws -> MeshSigner {
        log.events.append("key")
        if fail { throw KeyFail.refused }
        let s = P256Signer(); made.append(s); return s
    }
    enum KeyFail: Error { case refused }
}

private final class FakeInstance: InstanceIdRotating {
    let log: Log
    var currentInstanceId = "11111111-aaaa-4bbb-8ccc-000000000001"
    init(_ log: Log) { self.log = log }
    func rotateInstanceId() -> String {
        log.events.append("instance")
        currentInstanceId = "22222222-aaaa-4bbb-8ccc-000000000002"
        return currentInstanceId
    }
}

private final class FakeProfile: ProfileResetting {
    let log: Log
    init(_ log: Log) { self.log = log }
    func resetForNewDevice() { log.events.append("profile") }
}

private struct Rig {
    let log = Log()
    let keys: FakeKeys
    let instance: FakeInstance
    let signer = RotatingSigner(P256Signer())
    let kv = MemoryKeyValueStore()
    let config: BackendConfig
    let resetter: IdentityResetter
    var restarted: [String] { restartLog.ids }
    let restartLog = RestartLog()
    final class RestartLog { var ids: [String] = [] }

    init() {
        keys = FakeKeys(log); instance = FakeInstance(log)
        config = BackendConfig(store: kv)
        config.deviceId = "0192a000-0000-7000-8000-0000000000d1"
        config.heartbeatSeq = 42
        config.lastHeartbeatAtMs = 9; config.lastUploadAtMs = 8; config.outboxCursor = "2026-11-01T00:00:00.000Z"
        let l = log, r = restartLog
        resetter = IdentityResetter(signer: signer, keys: keys, instance: instance, config: config, profile: FakeProfile(log),
                                    restartTransport: { id in l.events.append("transport"); r.ids.append(id) },
                                    cancelCheckins: { l.events.append("checkins") }, now: { 5 })
    }
}

@Suite struct IdentityResetTests {
    @Test func swapsKeyAndForgetsRegistration() throws {
        let r = Rig()
        let before = r.signer.publicKeyDER
        let res = try r.resetter.reset()
        #expect(r.signer.publicKeyDER != before)
        #expect(r.signer.publicKeyDER == r.keys.made[0].publicKeyDER)
        #expect(r.config.deviceId == nil && r.config.heartbeatSeq == 0 && r.config.outboxCursor == nil)
        #expect(r.config.lastHeartbeatAtMs == 0 && r.config.lastUploadAtMs == 0)
        #expect(res.oldKeyId != res.newKeyId && res.oldKeyId.count == 8 && res.newKeyId.count == 8)
        #expect(res.oldInstanceId == "11111111" && res.newInstanceId == "22222222")
        #expect(r.resetter.last == res && r.resetter.lastAtMs == 5)
    }

    @Test func sequenceAndTransportRestartUseTheNewId() throws {
        let r = Rig()
        try r.resetter.reset()
        #expect(r.log.events == ["key", "instance", "checkins", "profile", "transport"])
        #expect(r.restarted == ["22222222-aaaa-4bbb-8ccc-000000000002"])
    }

    @Test func keychainFailureChangesNothing() {
        let r = Rig()
        r.keys.fail = true
        let before = r.signer.publicKeyDER
        #expect(throws: (any Error).self) { try r.resetter.reset() }
        #expect(r.signer.publicKeyDER == before)
        #expect(r.config.deviceId != nil && r.config.heartbeatSeq == 42)
        #expect(r.log.events == ["key"] && r.restarted.isEmpty && r.resetter.last == nil)
        #expect(r.instance.currentInstanceId.hasPrefix("11111111"))
    }

    @Test func twoResetsGiveTwoDifferentIdentities() throws {
        let r = Rig()
        let a = try r.resetter.reset()
        let b = try r.resetter.reset()
        #expect(a.newKeyId != b.newKeyId)
        #expect(b.oldKeyId == a.newKeyId)
    }

    @Test func rotatingSignerSignsWithTheNewKeyEverywhere() throws {
        let r = Rig()
        let held: MeshSigner = r.signer      // what the router and the HTTP client hold
        try r.resetter.reset()
        let sig = try held.sign(Data("x".utf8))
        #expect(MeshCrypto.verify(publicKeyDER: r.keys.made[0].publicKeyDER, data: Data("x".utf8), signatureDER: sig))
    }

    @Test func registrationRaceIsDropped() async throws {
        // A POST /v1/devices that finishes after a reset must not store the old key's device id.
        let http = FakeHTTP()
        let signer = RotatingSigner(P256Signer())
        let cfg = BackendConfig(store: MemoryKeyValueStore())
        let client = BackendClient(baseURL: "https://x.test", http: http, signer: signer, config: cfg)
        http.handler = { _ in
            signer.replace(with: P256Signer())           // identity reset while the call is in flight
            return HTTPResponse(status: 201, data: JSONValue.object(["id": .string("0192a000-0000-7000-8000-0000000000d1")]).serializedData())
        }
        await #expect(throws: (any Error).self) { try await client.registerDevice(appVersion: nil) }
        #expect(cfg.deviceId == nil)
    }
}

@Suite struct ProfileResetForNewDeviceTests {
    @Test func profileIsKeptAndRePutToTheNewDevice() {
        var rec = ProfileRecord()
        var p = UserProfile(fullName: "Maria Elena Gonzalez"); p.birthYear = 1951
        rec.profile = p; rec.base = p; rec.consentVersion = "2026-11-v1"; rec.serverVersion = 7; rec.dirty = false
        rec.lastVerifiedAtMs = 99; rec.adoptionChecked = true
        let store = MemoryProfileStore(); store.save(rec)
        let cfg = BackendConfig(store: MemoryKeyValueStore())
        let client = BackendClient(baseURL: "https://x.test", http: FakeHTTP(), signer: P256Signer(), config: cfg)
        let engine = ProfileSyncEngine(client: client, config: cfg, store: store)
        engine.hop = { $0() }
        var kicks = 0
        engine.requestGatewayCycle = { kicks += 1 }
        engine.resetForNewDevice()
        let r = engine.record
        #expect(r.profile == p && r.serverVersion == 0 && r.base == nil && r.dirty && r.revision == 1)
        #expect(r.lastVerifiedAtMs == 0 && kicks == 1)
        #expect(store.load()?.serverVersion == 0)
    }

    @Test func noProfileStaysEmptyAndNothingToAdopt() {
        let store = MemoryProfileStore()
        let cfg = BackendConfig(store: MemoryKeyValueStore())
        let client = BackendClient(baseURL: "https://x.test", http: FakeHTTP(), signer: P256Signer(), config: cfg)
        let engine = ProfileSyncEngine(client: client, config: cfg, store: store)
        engine.resetForNewDevice()
        #expect(engine.record.profile == nil && !engine.record.dirty && engine.record.adoptionChecked)
    }
}
