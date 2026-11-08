@testable import BeaconMesh
import Foundation
import Testing

private let t0: Int64 = 1_794_067_200_000
private let cid = "0192a7f0-0000-7000-8000-0000000000c1"

final class FakeNotifier: WelfareNotifying {
    var shown: [(String, Int64)] = []          // (checkin id, time)
    var scheduled: [String: WelfareReminderPlan] = [:]
    var planCalls: [(String, WelfareReminderPlan)] = []
    var cancelled: [String] = []
    var restored: [String] = []
    func show(_ p: WelfareCheckin, nowMs: Int64) { shown.append((p.checkinId, nowMs)) }
    func scheduleReminder(_ p: WelfareCheckin, plan: WelfareReminderPlan) {
        planCalls.append((p.checkinId, plan))
        scheduled[p.checkinId] = plan == .none ? nil : plan
    }
    func cancel(_ checkinId: String) { cancelled.append(checkinId); scheduled[checkinId] = nil }
    func restore(open: [WelfareCheckin], nowMs: Int64) { restored = open.map(\.checkinId) }
}

private final class Clock { var ms = t0 }

private func checkin(_ id: String = cid, sos: String = "s1", deadline: Int64 = t0 + 300_000, reminder: Int = 0, overdue: Bool = false) -> WelfareCheckin {
    WelfareCheckin(checkinId: id, sosId: sos, sentAtMs: t0, deadlineAtMs: deadline, receivedAtMs: t0, serverOverdue: overdue, reminderCount: reminder)
}

private func make(_ clock: Clock = Clock(), store: WelfareStore = InMemoryWelfareStore(), reminder: Int = 300) -> (WelfareManager, FakeNotifier, Clock) {
    let n = FakeNotifier()
    let m = WelfareManager(store: store, notifier: n, now: { clock.ms }, reminderSeconds: { reminder })
    return (m, n, clock)
}

@Suite struct WelfareParsingTests {
    @Test func restCheckinParsesOverdueAndSkipsAnswered() {
        let o: JSONValue = .object(["id": .string(cid), "sos_id": .string("s1"), "kind": .string("welfare"), "channel": .string("app"),
                                    "sent_at": .string(Iso.format(t0)), "deadline_at": .string(Iso.format(t0 + 60_000)),
                                    "choices": .array([.string("need_urgent_help"), .string("still_here"), .string("bogus")]),
                                    "attempt": .int(2), "missed": .bool(true), "overdue": .bool(true), "reminder_count": .int(3),
                                    "alarm_at": .string(Iso.format(t0 + 1))])
        let c = CheckinParser.fromRest(o, nowMs: t0)!
        #expect(c.choices == ["still_here", "need_urgent_help"] && c.attempt == 2 && c.serverOverdue && c.reminderCount == 3)
        #expect(c.deadlineAtMs == t0 + 60_000 && c.isOpen && c.isOverdue(t0))
        var answered = o.objectValue!
        answered["responded_at"] = .string(Iso.format(t0))
        #expect(CheckinParser.fromRest(.object(answered), nowMs: t0) == nil)
        var other = o.objectValue!
        other["kind"] = .string("other")
        #expect(CheckinParser.fromRest(.object(other), nowMs: t0) == nil)
        #expect(CheckinParser.fromRest(.object(["id": .string("x")]), nowMs: t0) == nil)
    }

    @Test func defaultsWhenFieldsMissingAndRestArray() {
        let c = CheckinParser.fromRest(.object(["id": .string(cid), "sos_id": .string("s1"), "sent_at": .string(Iso.format(t0))]), nowMs: t0)!
        #expect(c.deadlineAtMs == t0 + 300_000 && c.choices == WelfareResponse.all && c.attempt == 1)
        #expect(CheckinParser.fromRestArray(nil, nowMs: t0).isEmpty)
    }

    @Test func backendMessageBodyParses() {
        let b = TestBackend()
        let m = b.message(kind: "checkin_request", sosId: "s1", checkinId: cid,
                          body: ["title": .string("Check in"), "message": .string("Are you OK?"),
                                 "choices": .array(WelfareResponse.all.map(JSONValue.string)),
                                 "deadline_at": .string(Iso.format(t0 + 120_000)), "attempt": .int(2), "tier": .string("critical"),
                                 "reminder": .int(4)], createdMs: t0)
        let c = CheckinParser.fromBackend(m, nowMs: t0 + 5)!
        #expect(c.title == "Check in" && c.message == "Are you OK?" && c.tier == "critical" && c.attempt == 2)
        #expect(c.deadlineAtMs == t0 + 120_000 && c.sentAtMs == t0 && c.reminderCount == 4)
        #expect(CheckinParser.fromBackend(b.message(kind: "status_update", sosId: "s1", body: [:], createdMs: t0), nowMs: t0) == nil)
        #expect(CheckinParser.fromBackend(b.message(kind: "checkin_request", sosId: "s1", body: [:], createdMs: t0), nowMs: t0) == nil, "needs a checkin id")
    }
}

@Suite struct WelfareManagerTests {
    @Test func oneEntryPerCheckinIdAndOneNotification() {
        let (m, n, _) = make()
        #expect(m.ingest([checkin(), checkin()]).added == 1)
        #expect(m.all().count == 1 && n.shown.count == 1)
        #expect(m.pending().map(\.checkinId) == [cid])
    }

    @Test func reminderWithSameCheckinIdReplacesAndAlertsAgain() {
        let (m, n, c) = make()
        m.ingest([checkin()])
        c.ms += 310_000
        let r = m.ingest([checkin(reminder: 1, overdue: true)])
        #expect(r == WelfareManager.IngestResult(added: 0, reminded: 1, refreshed: 0))
        #expect(n.shown.map(\.0) == [cid, cid], "same identifier twice: the second replaces the first, never stacks")
        #expect(m.all().count == 1 && m.find(cid)?.reminderCount == 1 && m.find(cid)?.isOverdue(c.ms) == true)
    }

    @Test func simultaneousChannelsAlertOnce() {
        let (m, n, c) = make()
        m.ingest([checkin()])
        c.ms += 310_000
        m.ingest([checkin(reminder: 1, overdue: true)])
        c.ms += 2_000                                   // heartbeat reply and the poll of the same cycle
        let again = m.ingest([checkin(reminder: 1, overdue: true)])
        #expect(again.refreshed == 1 && again.reminded == 0 && n.shown.count == 2)
        c.ms += 1_000
        #expect(m.ingest([checkin(reminder: 2, overdue: true)]).reminded == 1, "a higher server reminder count always alerts")
    }

    @Test func answeredOrCancelledIsNeverReopened() {
        let (m, n, c) = make()
        m.ingest([checkin()])
        #expect(m.answer(cid, response: "bogus") == nil)
        #expect(m.answer(cid, response: WelfareResponse.stillHere)?.answer == "still_here")
        #expect(n.cancelled == [cid])
        c.ms += 400_000
        #expect(m.ingest([checkin(reminder: 1, overdue: true)]) == WelfareManager.IngestResult())
        #expect(m.pending().isEmpty && m.answer(cid, response: "still_here") == nil)
    }

    @Test func answerAfterDeadlineIsAccepted() {
        let (m, _, c) = make()
        m.ingest([checkin()])
        c.ms += 900_000
        #expect(m.pending().count == 1, "overdue is still open")
        let a = m.answer(cid, response: WelfareResponse.needUrgentHelp)
        #expect(a != nil && m.dueReplies().map(\.checkinId) == [cid], "late reply is still sent")
        c.ms += WelfareManager.replyGraceMs + 300_000
        #expect(m.dueReplies().isEmpty)
    }

    @Test func expiredNewCheckinIsIgnoredButOverdueRecentOneIsKept() {
        let (m, _, c) = make()
        c.ms = t0 + 3_600_000
        #expect(m.ingest([checkin()]).added == 1, "overdue by an hour: still the active check-in")
        c.ms = t0 + 2 * WelfareManager.retainMs
        #expect(m.ingest([checkin("other-id")]).added == 0)
    }

    @Test func resolvedCaseAndResetCancelEverything() {
        let (m, n, _) = make()
        m.ingest([checkin(cid, sos: "s1"), checkin("c2", sos: "s2")])
        m.cancelForSos("s1")
        #expect(m.pending().map(\.checkinId) == ["c2"] && n.cancelled == [cid])
        m.cancelAll()
        #expect(m.pending().isEmpty && n.cancelled.contains("c2") && n.scheduled["c2"] == nil)
        #expect(m.find("c2")?.response == WelfareResponse.cancelled)
    }

    @Test func reconcileClearsWhatTheServerNoLongerListsAfterGrace() {
        let (m, _, c) = make()
        m.ingest([checkin()])
        m.reconcile(serverPendingIds: [])
        #expect(m.pending().count == 1, "grace period")
        c.ms += 31_000
        m.reconcile(serverPendingIds: [cid])
        #expect(m.pending().count == 1)
        m.reconcile(serverPendingIds: [])
        #expect(m.pending().isEmpty && m.find(cid)?.response == WelfareResponse.serverCleared)
    }

    @Test func persistenceSurvivesRestartWithoutDuplicates() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("welfare-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let c = Clock()
        let (m1, _, _) = make(c, store: FileWelfareStore(url: url))
        m1.ingest([checkin()])
        c.ms += 1_000
        _ = m1.answer(cid, response: WelfareResponse.stillHere)
        m1.ingest([checkin("c2")])
        let (m2, n2, _) = make(c, store: FileWelfareStore(url: url))
        #expect(m2.all().count == 2 && m2.find(cid)?.answer == "still_here")
        #expect(m2.pending().map(\.checkinId) == ["c2"])
        #expect(m2.ingest([checkin("c2")]).added == 0, "known after restart: not a new check-in")
        m2.wake()
        #expect(n2.restored == ["c2"] && n2.shown.count == 0, "wake never alerts by itself")
        #expect(n2.scheduled["c2"] != nil)
    }

    @Test func corruptOrForeignVersionStoreIsIgnored() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("welfare-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(#"{"version":99,"checkins":[{"id":"x"}]}"#.utf8).write(to: url)
        #expect(FileWelfareStore(url: url).all().isEmpty)
        try Data("garbage".utf8).write(to: url)
        #expect(FileWelfareStore(url: url).all().isEmpty)
    }
}

@Suite struct WelfareReminderTests {
    @Test func beforeDeadlineOneRequestAtTheDeadlineThenRepeatingOnceOverdue() {
        let p = checkin(deadline: t0 + 100_000)
        #expect(WelfareReminderPlanner.plan(p, nowMs: t0, reminderSeconds: 300) == .atDeadline(fireAtMs: t0 + 100_000))
        #expect(WelfareReminderPlanner.plan(p, nowMs: t0 + 100_000, reminderSeconds: 300) == .repeating(intervalSeconds: 300))
        #expect(WelfareReminderPlanner.plan(checkin(overdue: true), nowMs: t0, reminderSeconds: 300) == .repeating(intervalSeconds: 300), "server flag")
        var done = p
        done.response = "still_here"
        #expect(WelfareReminderPlanner.plan(done, nowMs: t0, reminderSeconds: 300) == .none)
    }

    @Test func repeatingIntervalIsFlooredAtSixtySeconds() {
        let p = checkin(deadline: t0)
        #expect(WelfareReminderPlanner.plan(p, nowMs: t0 + 1, reminderSeconds: 20) == .repeating(intervalSeconds: 60))
        #expect(WelfareReminderPlanner.plan(p, nowMs: t0 + 1, reminderSeconds: 60) == .repeating(intervalSeconds: 60))
        #expect(WelfareReminderPlanner.plan(p, nowMs: t0 + 1, reminderSeconds: 120) == .repeating(intervalSeconds: 120))
    }

    @Test func managerKeepsOneRequestPerCheckinAndUpgradesItWhenOverdue() {
        let (m, n, c) = make(reminder: 20)
        m.ingest([checkin(deadline: t0 + 60_000), checkin("c2", deadline: t0 + 60_000)])
        #expect(n.scheduled.count == 2 && n.scheduled[cid] == .atDeadline(fireAtMs: t0 + 60_000))
        c.ms += 70_000            // the app runs again after the deadline: the same identifier becomes the repeating request
        m.wake()
        #expect(n.scheduled[cid] == .repeating(intervalSeconds: 60) && n.scheduled.count == 2)
        m.ingest([checkin(reminder: 1, overdue: true)])          // a re-delivery replaces, it does not add
        #expect(n.scheduled.count == 2 && n.shown.filter { $0.0 == cid }.count == 2)
        _ = m.answer(cid, response: "still_here")
        #expect(n.scheduled[cid] == nil && n.scheduled["c2"] != nil)
    }

    @Test func foregroundHonoursTheExactReminderInterval() {
        let (m, n, c) = make(reminder: 20)
        m.ingest([checkin(deadline: t0 + 60_000)])
        c.ms += 30_000
        #expect(m.remindDueOverdue() == 0, "not overdue yet")
        c.ms += 40_000                  // overdue; last alert was 70 s ago
        #expect(m.remindDueOverdue() == 1 && n.shown.count == 2)
        c.ms += 19_000
        #expect(m.remindDueOverdue() == 0)
        c.ms += 1_000
        #expect(m.remindDueOverdue() == 1 && n.shown.map(\.0) == [cid, cid, cid])
        #expect(m.all().count == 1, "still one check-in, one identifier")
        _ = m.answer(cid, response: "still_here")
        c.ms += 60_000
        #expect(m.remindDueOverdue() == 0)
    }
}

@Suite struct WelfareNotificationModelTests {
    private func time(_ ms: Int64) -> String { "T\(ms - t0)" }

    @Test func beforeDeadlineHasCountdownAndIsTimeSensitive() throws {
        let m = try #require(WelfareNotificationModel.build(checkin(), nowMs: t0, timeText: time))
        #expect(m.identifier == cid && !m.overdue && m.timeSensitive)
        #expect(m.title == "Beacon is checking on you" && m.body.hasSuffix("Answer by T300000."))
    }

    @Test func serverTextIsUsed() throws {
        var p = checkin()
        p.title = "Check in"; p.message = "Are you OK?"; p.choices = ["need_urgent_help", "still_here"]
        let m = try #require(WelfareNotificationModel.build(p, nowMs: t0, timeText: time))
        #expect(m.title == "Check in" && m.body.hasPrefix("Are you OK?"))
        #expect(m.identifier == cid)
    }

    @Test func overdueWordingHasNoCountdownAndIsUrgent() throws {
        let m = try #require(WelfareNotificationModel.build(checkin(), nowMs: t0 + 400_000, timeText: time))
        #expect(m.overdue && m.urgent && m.body == "Please confirm you're okay: your check-in is overdue.")
        #expect(!m.body.contains("Answer by") && m.identifier == cid)
        #expect(WelfareNotificationModel.build(checkin(overdue: true), nowMs: t0, timeText: time)?.overdue == true, "server flag")
    }

    @Test func answeredHasNoNotification() {
        var p = checkin()
        p.response = "still_here"
        #expect(WelfareNotificationModel.build(p, nowMs: t0, timeText: time) == nil)
    }

    @Test func confirmationTexts() {
        #expect(WelfareResponse.confirmation(WelfareResponse.noLongerNeedHelp) == "Marked as resolved. Stay safe.")
        #expect(ReplyBackoff.delayMs(attempt: 1) == 10_000 && ReplyBackoff.delayMs(attempt: 9) == 120_000)
        #expect(ReplyBackoff.delayMs(attempt: 0, retryAfterSeconds: 300) == 300_000)
    }
}

@Suite struct HeartbeatBuilderTests {
    @Test func extrasAreWrittenAndCapped() {
        let ids = (0..<30).map { _ in Uuid7.generate() }
        let body = MeshPayload.heartbeatBody(sentAtMs: t0, lat: 32.9857, lng: -96.7501, batteryPct: 120, charging: true, moving: false, seq: 4,
                                             extras: HeartbeatExtras(transport: "direct", network: "wifi", peersNearby: 3, gateway: true,
                                                                     openSosIds: ids + [ids[0]]))
        #expect(body["transport"]?.stringValue == "direct" && body["network"]?.stringValue == "wifi")
        #expect(body["peers_nearby"]?.intValue == 3 && body["gateway"]?.boolValue == true && body["battery_pct"]?.intValue == 100)
        #expect(body["open_sos_ids"]?.arrayValue?.count == 20)
        #expect(body["open_sos_ids"]?.arrayValue?.compactMap(\.stringValue) == Array(ids.prefix(20)))
    }

    @Test func invalidValuesAndEmptyExtrasAreOmitted() {
        let body = MeshPayload.heartbeatBody(sentAtMs: t0, lat: 1, lng: 2, batteryPct: nil, charging: nil, moving: nil, seq: 1,
                                             extras: HeartbeatExtras(transport: "carrier-pigeon", network: "5g", peersNearby: -2))
        #expect(body["transport"] == nil && body["network"] == nil && body["open_sos_ids"] == nil && body["gateway"] == nil)
        #expect(body["peers_nearby"]?.intValue == 0)
        #expect(MeshPayload.heartbeatBody(sentAtMs: t0, lat: 1, lng: 2, batteryPct: nil, charging: nil, moving: nil, seq: 1)["transport"] == nil)
    }

    @Test func networkKindFromInterface() {
        #expect(Heartbeat.networkKind(reachable: false, interface: .wifi) == "none")
        #expect(Heartbeat.networkKind(reachable: true, interface: .wifi) == "wifi")
        #expect(Heartbeat.networkKind(reachable: true, interface: .cellular) == "cellular")
        #expect(Heartbeat.networkKind(reachable: true, interface: .other) == "unknown")
    }

    @Test func sendRuleIgnoresTheEventButNeedsALocation() {
        #expect(Heartbeat.shouldSend(nowMs: t0, lastSentMs: 0, intervalSeconds: 300, force: false, hasLocation: true))
        #expect(!Heartbeat.shouldSend(nowMs: t0 + 299_000, lastSentMs: t0, intervalSeconds: 300, force: false, hasLocation: true))
        #expect(Heartbeat.shouldSend(nowMs: t0 + 300_000, lastSentMs: t0, intervalSeconds: 300, force: false, hasLocation: true))
        #expect(Heartbeat.shouldSend(nowMs: t0 + 1, lastSentMs: t0, intervalSeconds: 300, force: true, hasLocation: true))
        #expect(!Heartbeat.shouldSend(nowMs: t0, lastSentMs: 0, intervalSeconds: 300, force: true, hasLocation: false))
        #expect(Heartbeat.retryDelayAfterNotFound(intervalSeconds: 300, hasOpenSos: true) == 60)
        #expect(Heartbeat.retryDelayAfterNotFound(intervalSeconds: 300, hasOpenSos: false) == 300)
    }

    @Test func intervalComesFromServerInfoWithDefault() {
        let c = BackendConfig(store: MemoryKeyValueStore())
        #expect(c.heartbeatIntervalSeconds == 300 && c.checkinReminderSeconds == 300)
        c.update(ServerInfo.fromJSON(.object(["heartbeat_interval_seconds": .int(120), "checkin_reminder_seconds": .int(20)])), nowMs: t0)
        #expect(c.heartbeatIntervalSeconds == 120 && c.checkinReminderSeconds == 20)
    }
}

@Suite struct WelfareRouterTests {
    private func setup() throws -> (FakeNetwork, StoredMessage, WelfareManager, FakeNotifier) {
        let net = FakeNetwork()
        net.line(["A", "B"])
        let sos = try net.nodes["A"]!.originate(category: .trapped, lat: dallas.lat, lng: dallas.lng)
        net.run()
        let n = FakeNotifier()
        let m = WelfareManager(store: InMemoryWelfareStore(), notifier: n, now: { net.nowMs })
        net.nodes["A"]!.welfare = m
        return (net, sos, m, n)
    }

    private func request(_ net: FakeNetwork, _ sos: StoredMessage, reminder: Int) -> BackendMessage {
        net.backend.message(kind: "checkin_request", sosId: sos.id, checkinId: cid,
                            body: ["title": .string("t"), "message": .string("m"), "choices": .array(WelfareResponse.all.map(JSONValue.string)),
                                   "deadline_at": .string(Iso.format(net.nowMs + 300_000)), "attempt": .int(1), "tier": .string("critical"),
                                   "reminder": .int(Int64(reminder))], createdMs: net.nowMs)
    }

    @Test func meshRequestAndItsRepeatedDeliveriesShareOneCheckin() throws {
        let (net, sos, m, n) = try setup()
        net.nodes["B"]!.inject(messages: [request(net, sos, reminder: 0)], receipts: [])
        net.run()
        #expect(m.pending().count == 1 && n.shown.count == 1)
        // same checkin_id, NEW message id, reminder 1: not a duplicate
        net.nowMs += 20_000
        net.nodes["B"]!.inject(messages: [request(net, sos, reminder: 1)], receipts: [])
        net.run()
        #expect(m.all().count == 1 && n.shown.count == 2 && m.find(cid)?.reminderCount == 1)
    }

    @Test func requestForSomeoneElsesSosIsNotSurfaced() throws {
        let (net, sos, _, _) = try setup()
        let n = FakeNotifier()
        let mb = WelfareManager(store: InMemoryWelfareStore(), notifier: n, now: { net.nowMs })
        net.nodes["B"]!.welfare = mb
        net.nodes["A"]!.inject(messages: [request(net, sos, reminder: 0)], receipts: [])
        net.run()
        #expect(mb.all().isEmpty && n.shown.isEmpty)
    }

    @Test func resolvedStatusUpdateCancelsOpenCheckins() throws {
        let (net, sos, m, n) = try setup()
        net.nodes["B"]!.inject(messages: [request(net, sos, reminder: 0)], receipts: [])
        net.run()
        let upd = net.backend.message(kind: "status_update", sosId: sos.id, body: ["status": .string("resolved"), "message": .string("Marked as resolved. Stay safe.")], createdMs: net.nowMs + 1000)
        net.nowMs += 2000
        net.nodes["B"]!.inject(messages: [upd], receipts: [])
        net.run()
        #expect(m.pending().isEmpty && n.cancelled.contains(cid))
    }
}
