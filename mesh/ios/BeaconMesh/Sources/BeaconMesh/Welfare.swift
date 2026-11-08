import Foundation

// Welfare check-ins (liveness layer B). The server asks a person with an OPEN SOS "are you still there?" and the person
// answers with one of three choices. Liveness itself (layer A) is the automatic heartbeat; this file has nothing to do with it.
// There is no alarm. A check-in that passes `deadline_at` unanswered stays the ONE active check-in of its case, now OVERDUE:
// the server creates no new one, it re-delivers the SAME checkin_id every `checkin_reminder_seconds`. So the app keeps exactly
// one notification per checkin_id, alerts again on every re-delivery, and also reminds locally while overdue.
// Pure logic only (no UserNotifications / UIKit); the Apple glue lives in WelfareNotificationCenter.swift.
// Never log tokens, case content or coordinates: log lines carry short ids only.

/// The contract's `CheckinResponse` values the app sends. Legacy `ok` / `need_help` / `other` are never sent.
public enum WelfareResponse {
    public static let stillHere = "still_here"
    public static let noLongerNeedHelp = "no_longer_need_help"
    public static let needUrgentHelp = "need_urgent_help"
    public static let all = [stillHere, noLongerNeedHelp, needUrgentHelp]

    /// Stored marker: the server no longer lists this check-in (answered elsewhere, missed, cancelled). Never sent.
    public static let serverCleared = "server_cleared"
    /// Stored marker: the case was resolved or the identity / profile was reset. Never sent.
    public static let cancelled = "cancelled"

    public static func isKnown(_ s: String) -> Bool { all.contains(s) }

    /// Replies to offer: the server's `choices` limited to the three known ones, in canonical order; none -> all three.
    public static func offered(_ choices: [String]) -> [String] {
        let o = all.filter { choices.contains($0) }
        return o.isEmpty ? all : o
    }

    public static func label(_ response: String) -> String {
        switch response {
        case stillHere: return "I'm still here"
        case noLongerNeedHelp: return "I no longer need help"
        case needUrgentHelp: return "I need urgent help"
        default: return response
        }
    }

    /// What the person is told right after answering.
    public static func confirmation(_ response: String) -> String {
        switch response {
        case noLongerNeedHelp: return "Marked as resolved. Stay safe."
        case needUrgentHelp: return "Responders are being told you need urgent help."
        default: return "Thanks. Responders know you are still here."
        }
    }
}

/// One welfare check-in on this phone, from any of the three channels (heartbeat reply / `GET /checkins/pending`, mesh
/// `checkin_request`). De-duplicated by `checkinId`. `alarm_at` from older servers is ignored on purpose.
public struct WelfareCheckin: Equatable, Identifiable {
    public static let defaultWindowMs: Int64 = 5 * 60_000

    public var checkinId: String
    public var sosId: String
    public var title: String?
    public var message: String?
    /// Offered replies, canonical order, never empty.
    public var choices: [String]
    public var attempt: Int
    public var tier: String?
    public var sentAtMs: Int64
    public var deadlineAtMs: Int64
    public var receivedAtMs: Int64
    /// The person's answer (a `WelfareResponse` value), or a marker (`serverCleared` / `cancelled`). nil = still open.
    public var response: String?
    public var answeredAtMs: Int64
    /// The server has the answer (or can never take it): no more sending.
    public var delivered: Bool
    public var replyAttempts: Int
    public var nextReplyAtMs: Int64
    /// A `checkin_reply` envelope was created for a gateway to carry.
    public var meshReplied: Bool
    /// Server `overdue` flag / `reminder_count` (or the `reminder` count of a mesh request).
    public var serverOverdue: Bool
    public var reminderCount: Int
    /// When this phone last alerted (posted / re-posted the notification) for this check-in.
    public var lastAlertAtMs: Int64

    public var id: String { checkinId }

    public init(checkinId: String, sosId: String, title: String? = nil, message: String? = nil, choices: [String] = WelfareResponse.all,
                attempt: Int = 1, tier: String? = nil, sentAtMs: Int64, deadlineAtMs: Int64, receivedAtMs: Int64,
                response: String? = nil, answeredAtMs: Int64 = 0, delivered: Bool = false, replyAttempts: Int = 0,
                nextReplyAtMs: Int64 = 0, meshReplied: Bool = false, serverOverdue: Bool = false, reminderCount: Int = 0,
                lastAlertAtMs: Int64 = 0) {
        self.serverOverdue = serverOverdue; self.reminderCount = max(reminderCount, 0); self.lastAlertAtMs = lastAlertAtMs
        self.checkinId = checkinId; self.sosId = sosId; self.title = title; self.message = message
        self.choices = WelfareResponse.offered(choices); self.attempt = max(attempt, 1); self.tier = tier
        self.sentAtMs = sentAtMs; self.deadlineAtMs = deadlineAtMs; self.receivedAtMs = receivedAtMs
        self.response = response; self.answeredAtMs = answeredAtMs; self.delivered = delivered
        self.replyAttempts = replyAttempts; self.nextReplyAtMs = nextReplyAtMs; self.meshReplied = meshReplied
    }

    /// Not answered, not cancelled. An open check-in stays open after its deadline (overdue) until answered or resolved.
    public var isOpen: Bool { response == nil }
    /// Past `deadline_at` (or flagged overdue by the server) and still open: reminders continue, wording changes.
    public func isOverdue(_ nowMs: Int64) -> Bool { response == nil && (serverOverdue || nowMs >= deadlineAtMs) }

    /// The person's real answer (not a marker).
    public var answer: String? { response.flatMap { WelfareResponse.isKnown($0) ? $0 : nil } }

    func toJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(checkinId), "sos_id": .string(sosId),
            "choices": .array(choices.map(JSONValue.string)), "attempt": .int(Int64(attempt)),
            "sent_at": .int(sentAtMs), "deadline_at": .int(deadlineAtMs), "received_at": .int(receivedAtMs),
            "answered_at": .int(answeredAtMs), "delivered": .bool(delivered), "reply_attempts": .int(Int64(replyAttempts)),
            "next_reply_at": .int(nextReplyAtMs), "mesh_replied": .bool(meshReplied),
            "overdue": .bool(serverOverdue), "reminders": .int(Int64(reminderCount)), "last_alert_at": .int(lastAlertAtMs),
        ]
        if let title { o["title"] = .string(title) }
        if let message { o["message"] = .string(message) }
        if let tier { o["tier"] = .string(tier) }
        if let response { o["response"] = .string(response) }
        return .object(o)
    }

    static func fromJSON(_ v: JSONValue) -> WelfareCheckin? {
        guard let id = v.optString("id"), let sos = v.optString("sos_id"), let sent = v["sent_at"]?.intValue,
              let dl = v["deadline_at"]?.intValue else { return nil }
        return WelfareCheckin(
            checkinId: id, sosId: sos, title: v.optString("title"), message: v.optString("message"),
            choices: stringList(v["choices"]), attempt: v["attempt"]?.intValue ?? 1, tier: v.optString("tier"),
            sentAtMs: Int64(sent), deadlineAtMs: Int64(dl), receivedAtMs: Int64(v["received_at"]?.intValue ?? 0),
            response: v.optString("response"), answeredAtMs: Int64(v["answered_at"]?.intValue ?? 0),
            delivered: v["delivered"]?.boolValue ?? false, replyAttempts: v["reply_attempts"]?.intValue ?? 0,
            nextReplyAtMs: Int64(v["next_reply_at"]?.intValue ?? 0), meshReplied: v["mesh_replied"]?.boolValue ?? false,
            serverOverdue: v["overdue"]?.boolValue ?? false, reminderCount: v["reminders"]?.intValue ?? 0,
            lastAlertAtMs: Int64(v["last_alert_at"]?.intValue ?? 0))
    }
}

/// Parses the delivery channels of a welfare check-in. Never throws; bad input yields nil / [].
public enum CheckinParser {
    /// A contract `Checkin` object (`pending_checkins`, `GET /checkins/pending`). Answered ones return nil; an overdue
    /// (`missed` / `overdue`) one is still open and kept.
    public static func fromRest(_ o: JSONValue, nowMs: Int64) -> WelfareCheckin? {
        guard o.objectValue != nil, let id = o.optString("id"), !id.isEmpty, let sos = o.optString("sos_id"), !sos.isEmpty else { return nil }
        if let kind = o.optString("kind"), kind != "welfare" { return nil }
        if o.optString("responded_at") != nil || o.optString("response") != nil { return nil }
        let sent = o.optString("sent_at").flatMap(Iso.parse) ?? nowMs
        let deadline = o.optString("deadline_at").flatMap(Iso.parse) ?? (sent + WelfareCheckin.defaultWindowMs)
        return WelfareCheckin(checkinId: id, sosId: sos, title: blankToNil(o.optString("title")),
                              message: blankToNil(o.optString("message")), choices: stringList(o["choices"]),
                              attempt: o["attempt"]?.intValue ?? 1, tier: blankToNil(o.optString("tier")),
                              sentAtMs: sent, deadlineAtMs: deadline, receivedAtMs: nowMs,
                              serverOverdue: o["overdue"]?.boolValue == true || o["missed"]?.boolValue == true,
                              reminderCount: o["reminder_count"]?.intValue ?? 0)
    }

    public static func fromRestArray(_ v: JSONValue?, nowMs: Int64) -> [WelfareCheckin] {
        (v?.arrayValue ?? []).compactMap { fromRest($0, nowMs: nowMs) }
    }

    /// A `BackendMessage kind=checkin_request`: body has title, message, choices, deadline_at, attempt, tier and, on a
    /// re-delivery of the same check-in, `reminder` (count). Each re-delivery is a new message id with the same checkin_id.
    public static func fromBackend(_ m: BackendMessage, nowMs: Int64) -> WelfareCheckin? {
        guard m.kind == "checkin_request", let id = m.checkinId, !id.isEmpty else { return nil }
        let b = m.body
        let sent = Iso.parse(m.createdAt) ?? nowMs
        let deadline = b.optString("deadline_at").flatMap(Iso.parse) ?? (sent + WelfareCheckin.defaultWindowMs)
        return WelfareCheckin(checkinId: id, sosId: m.sosId, title: blankToNil(b.optString("title")),
                              message: blankToNil(b.optString("message")), choices: stringList(b["choices"]),
                              attempt: b["attempt"]?.intValue ?? 1, tier: blankToNil(b.optString("tier")),
                              sentAtMs: sent, deadlineAtMs: deadline, receivedAtMs: nowMs,
                              reminderCount: b["reminder"]?.intValue ?? 0)
    }

    private static func blankToNil(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}

/// Retry schedule for an unsent reply: 5 s, 10 s, 20 s ... capped at 2 min (or the server's Retry-After if longer).
public enum ReplyBackoff {
    public static func delayMs(attempt: Int, retryAfterSeconds: Int? = nil) -> Int64 {
        let base = min(Int64(5_000) << Int64(min(max(attempt, 0), 5)), 120_000)
        return max(base, Int64(retryAfterSeconds ?? 0) * 1000)
    }
}

// MARK: - Notification model (pure)

/// What a check-in notification shows, independent of UserNotifications (unit-tested). The notification has no answer
/// buttons: a tap opens the in-app check-in screen, where the person picks one of the three answers.
public struct WelfareNotificationModel: Equatable {
    public static let defaultTitle = "Beacon is checking on you"
    public static let defaultBody = "Please tell responders how you are."
    public static let overdueTitle = "Check-in overdue"
    public static let overdueBody = "Please confirm you're okay: your check-in is overdue."
    /// Marker stored in the notification's userInfo, so the app recognises its own check-in notifications (never a category).
    public static let kind = "beacon.welfare"

    /// Notification request identifier = the check-in id. Re-adding it replaces the notification (never stacks).
    public var identifier: String
    public var sosId: String
    public var title: String
    public var body: String
    public var deadlineAtMs: Int64
    /// Past the deadline: overdue wording, no countdown, not auto-removed until answered or resolved.
    public var overdue: Bool
    /// Overdue, second or later attempt, or a critical case.
    public var urgent: Bool
    /// Always true: asks for `.timeSensitive` (needs the Time Sensitive Notifications capability; no critical alerts).
    public var timeSensitive: Bool

    /// nil when the check-in is answered / cancelled. `nowMs` selects the wording (a reminder scheduled for later passes its
    /// fire time). `timeText` renders a deadline as a clock time ("4:35 PM").
    public static func build(_ p: WelfareCheckin, nowMs: Int64, timeText: (Int64) -> String) -> WelfareNotificationModel? {
        guard p.isOpen else { return nil }
        let overdue = p.isOverdue(nowMs)
        let body = overdue ? overdueBody : "\(p.message ?? defaultBody) Answer by \(timeText(p.deadlineAtMs))."
        return WelfareNotificationModel(
            identifier: p.checkinId, sosId: p.sosId, title: overdue ? overdueTitle : (p.title ?? defaultTitle), body: body,
            deadlineAtMs: p.deadlineAtMs, overdue: overdue, urgent: overdue || p.attempt > 1 || p.tier == "critical",
            timeSensitive: true)
    }
}

/// The ONE pending local request of a check-in (identifier = the check-in id, so it replaces the delivered notification and
/// never stacks). Before the deadline: a single non-repeating request at `deadline_at` carrying the overdue content. Once overdue
/// (the app has run since): a single repeating request. iOS requires repeating triggers to be >= 60 s.
public enum WelfareReminderPlan: Equatable {
    case none
    /// Non-repeating, fires at this epoch ms with the overdue wording.
    case atDeadline(fireAtMs: Int64)
    /// Repeating every `intervalSeconds` (>= 60), overdue wording; each firing replaces the previous delivery.
    case repeating(intervalSeconds: Int)
}

public enum WelfareReminderPlanner {
    /// Smallest repeating interval iOS accepts for `UNTimeIntervalNotificationTrigger(repeats: true)`.
    public static let minRepeatSeconds = 60

    /// Limitation: a repeating request only starts firing after being added, so it can only replace the `atDeadline` request when
    /// the app next runs. If the phone sleeps from the deadline on, only the single deadline notification shows until then.
    public static func plan(_ p: WelfareCheckin, nowMs: Int64, reminderSeconds: Int) -> WelfareReminderPlan {
        guard p.isOpen else { return .none }
        if p.isOverdue(nowMs) { return .repeating(intervalSeconds: max(reminderSeconds, minRepeatSeconds)) }
        return .atDeadline(fireAtMs: p.deadlineAtMs)
    }
}

// MARK: - Store

public protocol WelfareStore: AnyObject {
    func all() -> [WelfareCheckin]
    func save(_ c: WelfareCheckin)
    func remove(_ checkinId: String)
}

public final class InMemoryWelfareStore: WelfareStore {
    private var items: [String: WelfareCheckin] = [:]
    public init() {}
    public func all() -> [WelfareCheckin] { items.values.sorted { ($0.deadlineAtMs, $0.checkinId) < ($1.deadlineAtMs, $1.checkinId) } }
    public func save(_ c: WelfareCheckin) { items[c.checkinId] = c }
    public func remove(_ checkinId: String) { items.removeValue(forKey: checkinId) }
}

/// JSON-file store: `{"version":1,"checkins":[...]}`. Rows that fail to decode are skipped, a file of another version is
/// ignored (never fatal). Separate from the message store so a message-format bump never drops pending check-ins.
public final class FileWelfareStore: WelfareStore {
    public static let formatVersion = 1
    private let url: URL
    private let memory = InMemoryWelfareStore()

    public init(url: URL) {
        self.url = url
        guard let data = try? Data(contentsOf: url), let root = JSONValue.parse(data), root.objectValue != nil,
              root["version"]?.intValue == Self.formatVersion else { return }
        root["checkins"]?.arrayValue?.compactMap(WelfareCheckin.fromJSON).forEach(memory.save)
    }

    public static func defaultStore() -> FileWelfareStore {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return FileWelfareStore(url: dir.appendingPathComponent("beacon-welfare.json"))
    }

    public func all() -> [WelfareCheckin] { memory.all() }
    public func save(_ c: WelfareCheckin) { memory.save(c); flush() }
    public func remove(_ checkinId: String) { memory.remove(checkinId); flush() }

    private func flush() {
        let root = JSONValue.object(["version": .int(Int64(Self.formatVersion)),
                                     "checkins": .array(memory.all().map { $0.toJSON() })])
        let data = root.serializedData()
        #if os(iOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: .atomic)
        #endif
    }
}

// MARK: - Manager

/// Posts and removes the local notification of a check-in (UserNotifications on Apple, a fake in tests).
public protocol WelfareNotifying: AnyObject {
    /// Post (or replace, same identifier) the notification of an open check-in, alerting with sound.
    func show(_ p: WelfareCheckin, nowMs: Int64)
    /// Replace the single pending request of this check-in (same identifier) according to `plan` (`.none` removes it).
    func scheduleReminder(_ p: WelfareCheckin, plan: WelfareReminderPlan)
    /// Remove every notification of this check-in: delivered, pending and scheduled reminders.
    func cancel(_ checkinId: String)
    /// App start: drop notifications of check-ins that are no longer open (the open ones stay as they are, no new alert).
    func restore(open: [WelfareCheckin], nowMs: Int64)
}

/// Lifecycle of welfare check-ins on this phone: one entry per `checkin_id` (de-duplicated across channels and restarts),
/// notified once, re-alerted on every re-delivery (reminder), overdue after the deadline until answered or resolved.
/// Not thread-safe: drive it from one queue (the app uses the main queue).
public final class WelfareManager {
    /// A fresh check-in is not cleared by a poll that raced with its delivery.
    public static let reconcileGraceMs: Int64 = 30_000
    /// An open check-in the server never clears is given up this long after its deadline; answered rows are pruned too.
    public static let retainMs: Int64 = 24 * 3_600_000
    /// An answer is still sent (late answers are accepted) this long after the deadline.
    public static let replyGraceMs: Int64 = 60 * 60_000

    public struct IngestResult: Equatable {
        public var added = 0
        /// Known open check-ins delivered again (a reminder): the notification was replaced and alerted again.
        public var reminded = 0
        /// Known open check-ins delivered again too soon to alert again (several channels at once); data refreshed.
        public var refreshed = 0
    }

    private let store: WelfareStore
    public weak var notifier: WelfareNotifying?
    private let now: () -> Int64
    public var log: (String) -> Void
    /// `checkin_reminder_seconds` from /server-info (default 300).
    public var reminderSeconds: () -> Int
    public var onChange: (() -> Void)?

    public init(store: WelfareStore, notifier: WelfareNotifying? = nil, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                reminderSeconds: @escaping () -> Int = { 300 }, log: @escaping (String) -> Void = { _ in }) {
        self.store = store; self.notifier = notifier; self.now = now; self.reminderSeconds = reminderSeconds; self.log = log
    }

    private var reminderMs: Int64 { Int64(max(reminderSeconds(), 1)) * 1000 }
    /// Two deliveries of the same check-in closer than this count as one alert (heartbeat reply + poll in one cycle).
    private var realertMinMs: Int64 { max(reminderMs / 2, 1000) }

    public func all() -> [WelfareCheckin] { store.all() }
    /// Open check-ins (overdue ones included), earliest deadline first.
    public func pending() -> [WelfareCheckin] { store.all().filter(\.isOpen).sorted { $0.deadlineAtMs < $1.deadlineAtMs } }
    public func find(_ id: String) -> WelfareCheckin? { store.all().first { $0.checkinId == id } }

    /// Takes check-ins from any channel. De-duplicated on `checkin_id` (never on the backend message id): a known open one
    /// delivered again is a reminder, so its notification is replaced and alerts again; answered / cancelled ones are ignored.
    @discardableResult
    public func ingest(_ items: [WelfareCheckin]) -> IngestResult {
        let t = now()
        var result = IngestResult()
        for p in items {
            guard p.response == nil else { continue }
            if var cur = find(p.checkinId) {
                guard cur.response == nil else { continue }          // answered or cancelled: never reopen
                let moreReminders = p.reminderCount > cur.reminderCount
                cur.title = p.title ?? cur.title
                cur.message = p.message ?? cur.message
                cur.choices = p.choices
                cur.attempt = max(cur.attempt, p.attempt)
                cur.tier = p.tier ?? cur.tier
                cur.deadlineAtMs = p.deadlineAtMs
                cur.serverOverdue = cur.serverOverdue || p.serverOverdue
                cur.reminderCount = max(cur.reminderCount, p.reminderCount)
                if moreReminders || t - cur.lastAlertAtMs >= realertMinMs {
                    cur.reminderCount = max(cur.reminderCount, 1)
                    cur.lastAlertAtMs = t
                    store.save(cur)
                    notifier?.show(cur, nowMs: t)
                    scheduleReminders(for: cur)
                    log("Check-in \(cur.checkinId.prefix(8)) reminder")
                    result.reminded += 1
                } else {
                    store.save(cur)
                    result.refreshed += 1
                }
            } else {
                guard t < p.deadlineAtMs + Self.retainMs else { continue }
                var n = p
                n.lastAlertAtMs = t
                store.save(n)
                log("Check-in \(n.checkinId.prefix(8)) received (attempt \(n.attempt))")
                notifier?.show(n, nowMs: t)
                scheduleReminders(for: n)
                result.added += 1
            }
        }
        if result != IngestResult() { onChange?() }
        return result
    }

    /// After a successful `GET /checkins/pending` (which lists overdue ones too): open local check-ins the server no longer
    /// lists are over (answered elsewhere, resolved). Mesh-only ones younger than the grace period stay.
    public func reconcile(serverPendingIds: Set<String>) {
        let t = now()
        var changed = false
        for p in store.all() where p.response == nil && !serverPendingIds.contains(p.checkinId) && t - p.receivedAtMs > Self.reconcileGraceMs {
            finish(p, marker: WelfareResponse.serverCleared)
            changed = true
        }
        if changed { onChange?() }
    }

    /// The person answered (also after the deadline): mark it locally right away, remove every notification and reminder.
    /// nil when unknown, already answered or `response` is not one of the three choices.
    @discardableResult
    public func answer(_ id: String, response: String) -> WelfareCheckin? {
        guard WelfareResponse.isKnown(response), let p = find(id), p.response == nil else { return nil }
        var done = p
        done.response = response
        done.answeredAtMs = now()
        done.nextReplyAtMs = 0
        store.save(done)
        notifier?.cancel(id)
        log("Check-in \(id.prefix(8)) answered locally")
        onChange?()
        return done
    }

    /// The case was resolved (status update, own `no_longer_need_help`): nothing left to ask for this SOS.
    public func cancelForSos(_ sosId: String) {
        var changed = false
        for p in store.all() where p.sosId == sosId && p.response == nil { finish(p, marker: WelfareResponse.cancelled); changed = true }
        if changed { onChange?() }
    }

    /// Identity / profile reset: every open check-in, its notification and its reminders go.
    public func cancelAll() {
        var changed = false
        for p in store.all() {
            if p.response == nil { finish(p, marker: WelfareResponse.cancelled); changed = true }
            else if !p.delivered { var d = p; d.delivered = true; store.save(d); changed = true }
            notifier?.cancel(p.checkinId)
        }
        if changed { onChange?() }
    }

    /// App start / foreground / any wake: prune, give up on ancient open ones, let the notifier clean up, and re-plan the local
    /// reminder chain of every open check-in (so reminders go on even if no server message arrives). Never alerts by itself.
    public func wake() {
        let t = now()
        for p in store.all() {
            if t > p.deadlineAtMs + Self.retainMs {
                if p.response == nil { notifier?.cancel(p.checkinId) }
                store.remove(p.checkinId)
            }
        }
        notifier?.restore(open: pending(), nowMs: t)
        for p in pending() { scheduleReminders(for: p) }
        onChange?()
    }

    public func restore() { wake() }

    /// Answered check-ins whose reply still has to reach the server and whose retry time has come. Late answers are sent
    /// too, up to `replyGraceMs` after the deadline.
    public func dueReplies() -> [WelfareCheckin] {
        let t = now()
        return store.all().filter { $0.answer != nil && !$0.delivered && t < $0.deadlineAtMs + Self.replyGraceMs && $0.nextReplyAtMs <= t }
    }

    public func update(_ p: WelfareCheckin) { store.save(p); onChange?() }

    /// The foreground path honours the exact `checkin_reminder_seconds` (the repeating request is floored at 60 s): every open
    /// overdue check-in not alerted for one interval is re-posted (same identifier, replaces). Returns how many.
    @discardableResult
    public func remindDueOverdue() -> Int {
        let t = now()
        var n = 0
        for p in store.all() where p.isOverdue(t) && t - p.lastAlertAtMs >= reminderMs {
            var d = p
            d.lastAlertAtMs = t
            d.reminderCount += 1
            store.save(d)
            notifier?.show(d, nowMs: t)
            n += 1
        }
        if n > 0 { onChange?() }
        return n
    }

    private func scheduleReminders(for p: WelfareCheckin) {
        notifier?.scheduleReminder(p, plan: WelfareReminderPlanner.plan(p, nowMs: now(), reminderSeconds: reminderSeconds()))
    }

    private func finish(_ p: WelfareCheckin, marker: String) {
        var d = p
        d.response = marker
        d.answeredAtMs = now()
        d.delivered = true
        store.save(d)
        notifier?.cancel(p.checkinId)
    }
}
