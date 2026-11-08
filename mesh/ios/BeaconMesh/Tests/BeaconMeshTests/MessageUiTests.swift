@testable import BeaconMesh
import Foundation
import Testing

@Suite struct MessageUiTests {
    private func own(_ f: (inout StoredMessage) -> Void = { _ in }) throws -> StoredMessage {
        let net = FakeNetwork()
        net.add("A")
        var m = try net.nodes["A"]!.originate(category: .trapped, text: "roof", lat: 1, lng: 2, people: 2)
        f(&m)
        return m
    }

    @Test func ownMessageLifecycle() throws {
        #expect(try MessageUi.status(own(), online: false) == .queued)
        #expect(try MessageUi.status(own { $0.sentToPeers = 3 }, online: false) == .relayed(peers: 3))
        #expect(try MessageUi.status(own(), online: true) == .sending)
        #expect(try MessageUi.status(own { $0.uploaded = true }, online: true) == .reachedResponders)
        let st = SosStatus(status: "en_route", reachedResponders: true, etaMinutes: 40, message: "Help is on the way, ETA 40 min", updatedAtMs: 1)
        #expect(try MessageUi.status(own { $0.uploaded = true; $0.serverStatus = st }, online: false)
                == .progress(status: "en_route", etaMinutes: 40, message: "Help is on the way, ETA 40 min"))
        let reported = SosStatus(status: "reported", reachedResponders: true, updatedAtMs: 1)
        #expect(try MessageUi.status(own { $0.serverStatus = reported }, online: false) == .reachedResponders)
        #expect(try MessageUi.status(own { $0.rejectedReason = "expired" }, online: true) == .rejected(reason: "expired"))
    }

    @Test func receivedMessageStates() throws {
        var m = try own { $0.isOwn = false }
        #expect(MessageUi.status(m, online: false) == .relaying)
        m.envelope.hopCount = m.envelope.maxHops
        #expect(MessageUi.status(m, online: false) == .held)
    }

    @Test func itemMappingUsesLocalPlaintextOnlyForOwn() throws {
        let item = MessageUi.map(try own())
        #expect(item.category == .trapped && item.text == "roof" && item.people == 2 && item.critical && item.maxHops == 10)
        let relayed = MessageUi.map(try own { $0.isOwn = false; $0.own = nil })
        #expect(relayed.text == nil && relayed.category == .trapped, "category comes from the readable routing block")
    }

    @Test func ageAndFilters() throws {
        #expect(MessageUi.age(fromMs: 0, nowMs: 30_000) == .now)
        #expect(MessageUi.age(fromMs: 0, nowMs: 5 * 60_000) == .minutes(5))
        #expect(MessageUi.age(fromMs: 0, nowMs: 3 * 3_600_000) == .hours(3))
        #expect(MessageUi.age(fromMs: 0, nowMs: 2 * 86_400_000) == .days(2))
        let a = MessageUi.map(try own()), b = MessageUi.map(try own { $0.isOwn = false; $0.uploaded = true })
        #expect(MessageUi.filter([a, b], .mine).count == 1 && MessageUi.filter([a, b], .received).count == 1)
        #expect(MessageUi.heldOffline([a, b]) == 1)
    }

    @Test func holdRampBuildsMonotonicallyToFullIntensity() {
        let r = HoldRamp()
        #expect(abs(r.intensity(at: 0) - r.start) < 1e-9)
        #expect(r.intensity(at: r.duration) == 1)
        let pts = r.controlPoints()
        #expect(pts.count == 8 && pts.first!.time == 0 && abs(pts.last!.time - 1.5) < 1e-9)
        #expect(zip(pts, pts.dropFirst()).allSatisfy { $0.value <= $1.value })
        #expect(r.intensity(at: 99) == 1 && r.intensity(at: -1) == r.start)
    }
}
