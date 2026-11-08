@testable import BeaconMesh
import Foundation
import Testing

private final class FakeSender: ResponderLocationSending {
    var sent: [SharedPosition?] = []
    var failNext = 0
    var error: Error = ResponderError.offline("down")
    func sendLocation(_ position: SharedPosition?) async throws {
        if failNext > 0 { failNext -= 1; throw error }
        sent.append(position)
    }
}

private final class Clock { var ms: Int64 = 1_000_000 }

@MainActor private struct Rig {
    let clock = Clock()
    let sender = FakeSender()
    let sharer: ResponderLocationSharer
    init() {
        let c = clock
        sharer = ResponderLocationSharer(client: sender, now: { c.ms })
    }
    func advance(_ ms: Int64) { clock.ms += ms }
}

private let home = SharedPosition(lat: 32.9857, lng: -96.7502)
/// About 0.00009 degrees of latitude is 10 m.
private func north(_ p: SharedPosition, metres: Double) -> SharedPosition {
    SharedPosition(lat: p.lat + metres / 111_195.0, lng: p.lng)
}

@MainActor @Suite struct ResponderLocationSharerTests {
    @Test func distanceIsRoughlyRight() {
        let d = home.distanceM(to: north(home, metres: 100))
        #expect(abs(d - 100) < 1)
    }

    @Test func nothingBeforeStartAndFirstFixSendsImmediately() async {
        let r = Rig()
        r.sharer.update(home)
        await r.sharer.pump()
        #expect(r.sender.sent.isEmpty)
        r.sharer.start()
        r.sharer.update(home)
        await r.sharer.pump()
        #expect(r.sender.sent == [home])
    }

    @Test func movedFarEnoughSendsButNeverBeforeTenSeconds() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        let far = north(home, metres: 200)
        r.advance(5_000)
        r.sharer.update(far); await r.sharer.pump()
        #expect(r.sender.sent.count == 1)          // min interval
        #expect(r.sharer.nextWakeMs() == r.clock.ms + 5_000)
        r.advance(5_000); await r.sharer.pump()
        #expect(r.sender.sent == [home, far])
    }

    @Test func smallMovementWaitsForSixtySecondHeartbeat() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.advance(15_000)
        r.sharer.update(north(home, metres: 10)); await r.sharer.pump()
        #expect(r.sender.sent.count == 1)
        r.advance(44_000); await r.sharer.pump()
        #expect(r.sender.sent.count == 1)
        r.advance(1_000); await r.sharer.pump()
        #expect(r.sender.sent.count == 2)
        #expect(r.sender.sent.last == north(home, metres: 10))
    }

    @Test func staleFixIsNotResentAsHeartbeat() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.advance(200_000); await r.sharer.pump()
        #expect(r.sender.sent.count == 1)
    }

    @Test func onlyLatestFixIsKept() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.advance(10_000)
        r.sharer.update(north(home, metres: 100))
        r.sharer.update(north(home, metres: 300))
        r.sharer.update(north(home, metres: 500))
        await r.sharer.pump(); await r.sharer.pump()
        #expect(r.sender.sent == [home, north(home, metres: 500)])
    }

    @Test func offlineSendsNothingThenCatchesUpWithLatest() async {
        let r = Rig()
        r.sharer.start(); r.sharer.setOnline(false)
        r.sharer.update(home); await r.sharer.pump()
        r.advance(30_000)
        r.sharer.update(north(home, metres: 100)); await r.sharer.pump()
        #expect(r.sender.sent.isEmpty)
        r.sharer.setOnline(true); await r.sharer.pump()
        #expect(r.sender.sent == [north(home, metres: 100)])
    }

    @Test func failureBacksOffExponentiallyAndResets() async {
        let r = Rig()
        r.sender.failNext = 2
        r.sharer.start(); r.sharer.update(home)
        await r.sharer.pump()                       // fail 1 -> wait 10 s
        #expect(r.sharer.failures == 1 && r.sender.sent.isEmpty)
        r.advance(9_000); await r.sharer.pump()
        #expect(r.sharer.failures == 1)             // still backing off, no attempt
        r.advance(1_000); await r.sharer.pump()     // fail 2 -> wait 20 s
        #expect(r.sharer.failures == 2)
        r.advance(19_000); await r.sharer.pump()
        #expect(r.sender.sent.isEmpty)
        r.advance(1_000); await r.sharer.pump()
        #expect(r.sender.sent == [home] && r.sharer.failures == 0)
    }

    @Test func backoffIsCapped() async {
        let r = Rig()
        r.sender.failNext = 100
        r.sharer.start(); r.sharer.update(home)
        for _ in 0..<20 { await r.sharer.pump(); r.advance(300_000) }
        let wake = r.sharer.nextWakeMs()!
        #expect(wake - r.clock.ms <= 300_000)
    }

    @Test func stopClearsWithNullAndRetriesUntilItWorks() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.sender.failNext = 2
        r.sharer.stop()
        #expect(r.sharer.phase == .clearing)
        await r.sharer.pump()                        // fails
        #expect(r.sharer.phase == .clearing)
        r.advance(10_000); await r.sharer.pump()     // fails
        r.advance(20_000); await r.sharer.pump()     // works
        #expect(r.sharer.phase == .idle)
        #expect(r.sender.sent.count == 2 && r.sender.sent.last! == nil)
        r.advance(600_000); await r.sharer.pump()
        #expect(r.sender.sent.count == 2)            // no more traffic
    }

    @Test func stopBeforeAnySendNeedsNoClearAndStopsUpdates() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home)
        r.sharer.stop()
        #expect(r.sharer.phase == .idle)
        r.sharer.update(home); await r.sharer.pump()
        #expect(r.sender.sent.isEmpty)
    }

    @Test func clearWaitsWhileOffline() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.sharer.setOnline(false); r.sharer.stop()
        await r.sharer.pump()
        #expect(r.sharer.phase == .clearing)
        r.sharer.setOnline(true); await r.sharer.pump()
        #expect(r.sharer.phase == .idle && r.sender.sent.last! == nil)
    }

    @Test func permanentSignedOutDropsEverythingAndNotifies() async {
        let r = Rig()
        var lost = 0
        r.sharer.onSessionLost = { lost += 1 }
        r.sender.error = ResponderError.signedOut
        r.sender.failNext = 1
        r.sharer.start(); r.sharer.update(home)
        await r.sharer.pump()
        #expect(lost == 1 && r.sharer.phase == .idle)
        r.advance(100_000); await r.sharer.pump()
        #expect(r.sender.sent.isEmpty)
    }

    @Test func signedOutDuringClearAbandonsIt() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.sender.error = ResponderError.signedOut; r.sender.failNext = 1
        r.sharer.stop(); await r.sharer.pump()
        #expect(r.sharer.phase == .idle)
    }

    @Test func restartCancelsPendingClear() async {
        let r = Rig()
        r.sharer.start(); r.sharer.update(home); await r.sharer.pump()
        r.sharer.stop()
        r.sharer.start(); r.sharer.update(north(home, metres: 50))
        await r.sharer.pump()
        #expect(r.sender.sent == [home, north(home, metres: 50)])
    }
}

@Suite struct ResponderClientLocationTests {
    private func client(_ http: FakeHTTP) -> ResponderClient {
        let tokens = ResponderTokens(accessToken: "AT", refreshToken: "RT", accessExpiresAtMs: Int64.max / 2,
                                     account: ResponderAccount(id: "r-1", username: "u", name: "U", role: "responder"))
        return ResponderClient(baseURL: "https://example.test/v1/", http: http, store: InMemoryResponderTokenStore(tokens))
    }

    @Test func patchesLocationThenNull() async throws {
        let http = FakeHTTP()
        http.handler = { _ in HTTPResponse(status: 200, data: Data("{}".utf8)) }
        let c = client(http)
        try await c.sendLocation(SharedPosition(lat: 1.5, lng: -2.25))
        try await c.sendLocation(nil)
        #expect(http.paths() == ["PATCH /v1/responders/r-1", "PATCH /v1/responders/r-1"])
        #expect(http.requests[0].headers["Authorization"] == "Bearer AT")
        #expect(http.requests[0].headers["X-Beacon-Client"] == "app")
        #expect(http.requests[1].headers["X-Beacon-Client"] == "app")
        let b0 = JSONValue.parse(http.requests[0].body)!
        #expect(b0["location"]?["lat"]?.doubleValue == 1.5 && b0["location"]?["lng"]?.doubleValue == -2.25)
        let b1 = JSONValue.parse(http.requests[1].body)!
        #expect(b1["location"] == JSONValue.null)
    }

    @Test func availableAndServerErrors() async throws {
        let http = FakeHTTP()
        http.handler = { _ in HTTPResponse(status: 200, data: Data("{}".utf8)) }
        let c = client(http)
        try await c.setAvailable(false)
        #expect(JSONValue.parse(http.requests[0].body)?["available"]?.boolValue == false)
        #expect(c.account?.available == false)
        http.handler = { _ in HTTPResponse(status: 403, data: Data("{}".utf8)) }
        await #expect(throws: ResponderError.forbidden) { try await c.sendLocation(nil) }
    }
}
