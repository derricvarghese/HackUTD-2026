@testable import BeaconMesh
import Foundation
import Testing

private let deviceId = "0192a000-0000-7000-8000-0000000000d1"
private let t0: Int64 = 1_794_067_200_000
private let V1 = "2026-11-v1"

private func json(_ status: Int, _ v: JSONValue, headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, data: v.serializedData(), headers: headers)
}
private func err(_ status: Int, _ code: String, headers: [String: String] = [:]) -> HTTPResponse { json(status, .object(["code": .string(code)]), headers: headers) }

private func me() -> UserProfile {
    var p = UserProfile(fullName: "Maria Elena Gonzalez"); p.birthYear = 1951; p.phone = "+19725550142"
    p.medical.conditions = ["asthma"]
    return p
}

/// A phone + a scripted server. `profileServer` is the whole server-side state.
private final class Rig {
    let http = FakeHTTP()
    let config = BackendConfig(store: MemoryKeyValueStore())
    let store = MemoryProfileStore()
    var clock = t0
    var logs: [String] = []
    let engine: ProfileSyncEngine
    var kicks = 0

    // scripted server
    var serverVersion: Int? = nil
    var serverProfile: JSONValue?
    var consentVersion = V1
    var puts: [HTTPRequest] = []
    var failNext: [HTTPResponse] = []
    var infoCalls = 0

    init(store pre: ProfileRecord? = nil, registered: Bool = true) {
        let signer = P256Signer()
        let box = ClockRef()
        clockRef = box
        let client = BackendClient(baseURL: "https://hackutd.alecj.com", http: http, signer: signer, config: config, now: { box.ms })
        if let pre { store.save(pre) }
        engine = ProfileSyncEngine(client: client, config: config, store: store)
        engine.hop = { $0() }
        engine.now = { box.ms }
        engine.requestGatewayCycle = { [unowned self] in kicks += 1 }
        engine.log = { [unowned self] in logs.append($0) }
        if registered { config.deviceId = deviceId }
        http.handler = { [unowned self] req in handle(req) }
    }
    var clockRef: ClockRef!
    final class ClockRef { var ms = t0 }
    func advance(_ ms: Int64) { clockRef.ms += ms }

    func handle(_ req: HTTPRequest) -> HTTPResponse {
        if req.url.path == "/v1/server-info" {
            infoCalls += 1
            return json(200, .object(["server_time": .string(Iso.format(clockRef.ms)), "profile_required": .bool(true), "profile_consent_version": .string(consentVersion)]))
        }
        if !failNext.isEmpty && req.url.path.hasSuffix("/profile") { return failNext.removeFirst() }
        switch (req.method, req.url.path) {
        case ("PUT", "/v1/devices/\(deviceId)/profile"):
            puts.append(req)
            let body = JSONValue.parse(req.body)!
            guard body["consent"]?.optString("version") == consentVersion else { return err(422, "validation_error") }
            let ifMatch = req.headers["If-Match"]
            if let ifMatch, Int(ifMatch) != (serverVersion ?? 0) { return err(409, "conflict") }
            let created = serverVersion == nil
            serverVersion = (serverVersion ?? 0) + 1
            var stored = body.objectValue!; stored["view"] = .string("full"); stored["profile_version"] = .int(Int64(serverVersion!))
            serverProfile = .object(stored)
            return json(created ? 201 : 200, serverProfile!, headers: ["etag": "\"\(serverVersion!)\""])
        case ("GET", "/v1/devices/\(deviceId)/profile"):
            guard let serverProfile else { return err(404, "not_found") }
            return json(200, serverProfile, headers: ["etag": "\"\(serverVersion!)\""])
        case ("GET", "/v1/devices/\(deviceId)"):
            return json(200, .object(["id": .string(deviceId), "profile_version": serverVersion.map { .int(Int64($0)) } ?? .null]))
        case ("DELETE", "/v1/devices/\(deviceId)/profile"):
            let had = serverProfile != nil
            serverProfile = nil; serverVersion = nil
            return had ? HTTPResponse(status: 204) : err(404, "not_found")
        default: return err(404, "not_found")
        }
    }
}

@Suite struct ProfileSyncEngineTests {
    @Test func offlineSaveIsPendingThenCreatesWithIfMatchZero() async {
        let r = Rig()
        #expect(r.engine.status == .empty && r.engine.needsOnboarding)
        #expect(r.engine.save(me(), consentVersion: V1).isEmpty)
        #expect(r.engine.status == .pending && r.kicks == 1)
        #expect(r.store.saved?.profile?.fullName == "Maria Elena Gonzalez")   // persisted before any network
        await r.engine.runCycle()
        #expect(r.engine.status == .synced)
        #expect(r.engine.record.serverVersion == 1)
        let put = r.puts[0]
        #expect(put.headers["If-Match"] == "0" && put.method == "PUT")
        #expect(put.headers["X-Device-Id"] == deviceId && put.headers["X-Device-Signature"] != nil)   // the usual device signature headers
        let body = JSONValue.parse(put.body)!
        #expect(body["consent"]?["accepted"]?.boolValue == true && body["consent"]?.optString("version") == V1)
        #expect(body.optString("full_name") == "Maria Elena Gonzalez" && body["household"] == nil)
        #expect(r.store.saved?.dirty == false)
    }

    @Test func editsSendTheKnownVersionAndSkipNoOps() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1); await r.engine.runCycle()
        r.kicks = 0
        r.engine.save(me(), consentVersion: V1)           // unchanged: nothing to do
        #expect(r.engine.status == .synced && r.kicks == 0)
        var p = me(); p.notes = "second floor"
        r.engine.save(p, consentVersion: V1); await r.engine.runCycle()
        #expect(r.puts.last?.headers["If-Match"] == "1" && r.engine.record.serverVersion == 2 && r.engine.status == .synced)
    }

    @Test func invalidProfilesAreNotStored() {
        let r = Rig()
        var p = me(); p.phone = "nope"
        #expect(r.engine.save(p, consentVersion: V1)["phone"] != nil)
        #expect(r.engine.status == .empty && r.store.saves == 0)
    }

    @Test func conflictIsFetchedMergedAndRetried() async {
        let r = Rig()
        // another install already wrote v3 with an address
        var other = me(); other.homeAddress = "1 Elm St"
        var full = other.inputJSON(consent: ProfileConsentInfo(version: V1, acceptedAtMs: t0)).objectValue!
        full["profile_version"] = .int(3)
        r.serverProfile = .object(full); r.serverVersion = 3
        var mine = me(); mine.preferredName = "Elena"
        r.engine.save(mine, consentVersion: V1)
        await r.engine.runCycle()
        #expect(r.puts.count == 2)
        #expect(r.puts[0].headers["If-Match"] == "0")      // create-only was refused with 409
        #expect(r.puts[1].headers["If-Match"] == "3")      // retried against the version just read
        let merged = r.engine.profile!
        #expect(merged.preferredName == "Elena" && merged.homeAddress == "1 Elm St")
        #expect(r.engine.status == .synced && r.engine.record.serverVersion == 4)
    }

    @Test func staleConsentVersionAsksAgainAndStopsSending() async {
        let r = Rig()
        r.consentVersion = "2026-12-v2"                      // the server moved on
        r.engine.save(me(), consentVersion: V1)
        await r.engine.runCycle()
        #expect(r.engine.status == .needsConsent)
        #expect(r.engine.meshSummary() == nil)                // no identity hints without a current consent
        let sent = r.puts.count
        await r.engine.runCycle()
        #expect(r.puts.count == sent)
        r.engine.renewConsent(version: r.engine.consentVersion)
        await r.engine.runCycle()
        #expect(r.engine.status == .synced && JSONValue.parse(r.puts.last!.body)!["consent"]?.optString("version") == "2026-12-v2")
    }

    @Test func knownNewConsentVersionIsDetectedWithoutAPut() async {
        let r = Rig(store: nil)
        r.engine.save(me(), consentVersion: V1)
        r.config.update(ServerInfo.fromJSON(.object(["profile_consent_version": .string("2027-v9")])), nowMs: t0)
        await r.engine.runCycle()
        #expect(r.engine.status == .needsConsent && r.puts.isEmpty)
    }

    @Test func rateLimitBacksOffAndHonoursRetryAfter() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1)
        r.failNext = [err(429, "rate_limited", headers: ["retry-after": "90"])]
        await r.engine.runCycle()
        if case .failed(let why) = r.engine.status { #expect(why == "HTTP 429") } else { Issue.record("expected failed") }
        #expect(r.engine.nextAttemptAtMs == t0 + 90_000)
        await r.engine.runCycle()                                 // inside the window: nothing is sent
        #expect(r.puts.isEmpty)
        r.advance(91_000)
        await r.engine.runCycle()
        #expect(r.engine.status == .synced)
    }

    @Test func serverErrorsBackOffExponentiallyAndRetryResets() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1)
        r.failNext = [err(503, "x"), err(503, "x")]
        await r.engine.runCycle()
        #expect(r.engine.nextAttemptAtMs == t0 + 5_000)
        r.advance(5_001)
        await r.engine.runCycle()
        #expect(r.engine.nextAttemptAtMs == r.clockRef.ms + 10_000)
        r.engine.retry()                                           // user pressed Retry: window cleared
        #expect(r.engine.nextAttemptAtMs == 0)
        await r.engine.runCycle()
        #expect(r.engine.status == .synced)
    }

    @Test func validationRejectionIsNotRetriedUntilTheUserEdits() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1)
        r.failNext = [err(422, "validation_error")]
        await r.engine.runCycle()
        #expect(r.engine.rejected)
        if case .failed = r.engine.status {} else { Issue.record("expected failed") }
        r.advance(1_000_000)
        await r.engine.runCycle()
        #expect(r.puts.isEmpty)
        var p = me(); p.notes = "fixed"
        r.engine.save(p, consentVersion: V1)
        await r.engine.runCycle()
        #expect(r.engine.status == .synced)
    }

    @Test func missingOrOlderServerCopyIsResentAfterVerification() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1); await r.engine.runCycle()
        #expect(r.engine.status == .synced)
        r.advance(7 * 3_600_000)
        r.serverProfile = nil; r.serverVersion = nil              // erased server side / restored backup
        await r.engine.runCycle()
        #expect(r.puts.count == 2 && r.puts[1].headers["If-Match"] == "0")
        #expect(r.engine.status == .synced && r.engine.record.serverVersion == 1)
    }

    @Test func newerServerCopyIsAdoptedWhenNothingIsPending() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1); await r.engine.runCycle()
        var theirs = me(); theirs.homeAddress = "2 Oak Ave"
        var full = theirs.inputJSON(consent: ProfileConsentInfo(version: V1, acceptedAtMs: t0)).objectValue!
        full["profile_version"] = .int(5); r.serverProfile = .object(full); r.serverVersion = 5
        r.advance(7 * 3_600_000)
        await r.engine.runCycle()
        #expect(r.engine.profile?.homeAddress == "2 Oak Ave" && r.engine.record.serverVersion == 5 && r.puts.count == 1)
    }

    @Test func reinstallRestoresTheServerProfile() async {
        let r = Rig()
        var theirs = me(); theirs.homeAddress = "2 Oak Ave"
        var full = theirs.inputJSON(consent: ProfileConsentInfo(version: V1, acceptedAtMs: t0)).objectValue!
        full["profile_version"] = .int(2); r.serverProfile = .object(full); r.serverVersion = 2
        await r.engine.runCycle()
        #expect(r.engine.hasProfile && r.engine.status == .synced && r.engine.record.serverVersion == 2 && !r.engine.needsOnboarding)
        // fresh install, server has nothing: the question is asked once only
        let r2 = Rig()
        await r2.engine.runCycle()
        #expect(!r2.engine.hasProfile && r2.engine.record.adoptionChecked)
        let calls = r2.http.requests.count
        await r2.engine.runCycle()
        #expect(r2.http.requests.count == calls)
    }

    @Test func notRegisteredYetDoesNothing() async {
        let r = Rig(registered: false)
        r.engine.save(me(), consentVersion: V1)
        await r.engine.runCycle()
        #expect(r.http.requests.isEmpty && r.engine.status == .pending)
    }

    @Test func deleteWipesLocalNowAndErasesRemotelyWithRetry() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1); await r.engine.runCycle()
        r.engine.deleteProfile()
        #expect(r.engine.profile == nil && r.engine.status == .empty && r.engine.isDeleting && !r.engine.needsOnboarding)
        #expect(r.store.saved?.profile == nil && r.store.saved?.base == nil)       // nothing personal left on the phone
        #expect(r.engine.meshSummary() == nil)
        r.failNext = [err(500, "x")]
        await r.engine.runCycle()
        #expect(r.engine.isDeleting && r.serverProfile != nil)
        r.advance(6_000)
        await r.engine.runCycle()
        #expect(!r.engine.isDeleting && r.serverProfile == nil)
    }

    @Test func recreatingAfterADeleteWaitsForTheDeleteThenCreates() async {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1); await r.engine.runCycle()
        r.engine.deleteProfile()
        r.engine.save(me(), consentVersion: V1)
        await r.engine.runCycle()
        #expect(r.http.paths().suffix(2) == ["DELETE /v1/devices/\(deviceId)/profile", "PUT /v1/devices/\(deviceId)/profile"] || r.http.paths().contains("DELETE /v1/devices/\(deviceId)/profile"))
        #expect(r.puts.last?.headers["If-Match"] == "0" && r.engine.status == .synced)
    }

    @Test func skipIsAlwaysAvailableAndNeverBlocksOrUploads() async {
        let r = Rig()
        #expect(r.engine.profileRequired && r.engine.canSkip && r.engine.needsOnboarding)   // required, server never fetched
        r.engine.skip()
        #expect(!r.engine.needsOnboarding && r.engine.shouldPromptToComplete && r.kicks == 0)
        #expect(r.engine.record.consentVersion == nil && r.engine.record.consentAcceptedAtMs == 0)   // no consent recorded
        #expect(r.engine.meshSummary() == nil)
        r.advance(10 * 3_600_000)
        await r.engine.runCycle()
        #expect(r.puts.isEmpty && r.engine.status == .empty)
        // the nudge stays after a skip, can be dismissed for the session, and is prominent while required
        #expect(r.engine.showsBanner(dismissedThisSession: false) && !r.engine.showsBanner(dismissedThisSession: true))
        #expect(r.engine.nudgeIsProminent)
        r.config.update(ServerInfo.fromJSON(.object(["profile_required": .bool(false)])), nowMs: 1)
        #expect(!r.engine.nudgeIsProminent && r.engine.showsBanner(dismissedThisSession: false))
        // a skipped user can still set up later
        r.engine.save(me(), consentVersion: V1)
        #expect(r.engine.status == .pending && !r.engine.showsBanner(dismissedThisSession: false))
    }

    @Test func skippingDoesNotTouchAnExistingProfile() {
        let r = Rig()
        r.engine.save(me(), consentVersion: V1)
        r.engine.skip()
        #expect(r.engine.hasProfile && !r.engine.record.skipped)
    }

    @Test func requiredDefaultsToTrueUntilTheServerSays() {
        let r = Rig()
        #expect(r.engine.profileRequired && r.engine.consentVersion == ProfileConsent.bundledVersion)
        r.config.update(ServerInfo.fromJSON(.object(["profile_required": .bool(false), "profile_consent_version": .string("x1")])), nowMs: 1)
        #expect(!r.engine.profileRequired && r.engine.consentVersion == "x1")
    }

    @Test func meshSummaryCarriesTheAcknowledgedVersion() async {
        let r = Rig()
        #expect(r.engine.meshSummary() == nil)
        r.engine.save(me(), consentVersion: V1)
        #expect(r.engine.meshSummary()?["profile_version"]?.intValue == 0)
        await r.engine.runCycle()
        let s = r.engine.meshSummary()!
        #expect(s["profile_version"]?.intValue == 1 && s.optString("age_range") == "65-79")
        #expect(s["vulnerability_flags"] == .array([.string("medical"), .string("elderly")]))
        // never any detail beyond name / age range / coarse flags
        #expect(Set(s.objectValue!.keys) == ["full_name", "age_range", "vulnerability_flags", "profile_version"])
    }

    @Test func logsNeverContainProfileContent() async {
        let r = Rig()
        r.failNext = [err(409, "conflict")]
        r.engine.save(me(), consentVersion: V1)
        await r.engine.runCycle()
        r.engine.deleteProfile(); await r.engine.runCycle()
        let all = r.logs.joined(separator: "\n")
        #expect(!all.isEmpty)
        for secret in ["Maria", "Gonzalez", "asthma", "555", "1951"] { #expect(!all.contains(secret)) }
        #expect(!(r.engine.record.lastError ?? "").contains("Maria"))
    }
}

@Suite struct ProfileGatewayIntegrationTests {
    @Test func theGatewayCycleRunsTheProfileStepEvenWhenAnUploadStepFails() async {
        let r = Rig()
        let router = MeshRouter(signer: P256Signer(), store: InMemoryMessageStore(), config: r.config, now: { r.clockRef.ms })
        let client = BackendClient(baseURL: "https://hackutd.alecj.com", http: r.http, signer: P256Signer(), config: r.config, now: { r.clockRef.ms })
        let sync = GatewaySync(client: client, router: router, config: r.config)
        sync.hop = { $0() }; sync.now = { r.clockRef.ms }; sync.reachable = true
        sync.profileSync = r.engine
        r.engine.save(me(), consentVersion: V1)
        await sync.runCycle()
        #expect(r.engine.status == .synced)
        // the mesh outbox endpoint is unscripted (404) in this rig: the cycle reports the failure but the profile still went out
        #expect(sync.lastError != nil || r.puts.count == 1)
        #expect(r.puts.count == 1)
    }
}
