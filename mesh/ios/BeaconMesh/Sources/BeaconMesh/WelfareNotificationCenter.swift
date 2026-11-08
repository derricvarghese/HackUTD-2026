#if canImport(UserNotifications)
import Foundation
import UserNotifications

/// Apple glue for welfare check-in notifications (UserNotifications). Everything decided here comes from the pure
/// `WelfareNotificationModel` / `WelfareReminderPlanner`. NOT compiled in CI (no Apple toolchain on Linux): review in Xcode.
///
/// Rules: exactly ONE notification per check-in id (the request identifier is the check-in id; re-adding replaces it).
/// The reminder is the same single request: non-repeating at the deadline, then repeating (>= 60 s) once the app has run
/// overdue; each firing replaces the previous delivery. The notification has NO answer buttons: a tap opens the in-app
/// check-in screen (`WelfareSheet`), where the person taps one of the three answers. Time Sensitive interruption level is
/// requested (needs the Time Sensitive Notifications capability); no critical alerts, no alarm.
///
/// iOS limits: the app only runs in the background for Bluetooth and short wakeups, so a check-in can only be posted when the
/// app runs (BLE wake, foreground, heartbeat reply). Real push (APNs) is not set up.
public final class WelfareNotificationCenter: NSObject, WelfareNotifying, UNUserNotificationCenterDelegate {
    public static let shared = WelfareNotificationCenter()

    /// A notification was tapped: show the confirmation sheet for this check-in id. Set by the app once the UI can show it.
    /// A tap that arrives before this is set (cold launch) is kept in `pendingOpenId` and delivered as soon as it is set.
    public var onOpen: ((String) -> Void)? {
        didSet {
            guard let onOpen, let id = pendingOpenId else { return }
            pendingOpenId = nil
            onOpen(id)
        }
    }
    private var pendingOpenId: String?

    private let center = UNUserNotificationCenter.current()
    private static let idKey = "checkin_id"
    private static let sosKey = "sos_id"
    private static let kindKey = "kind"

    private override init() { super.init() }

    /// Call at launch, before the app finishes launching (the app's `init`): a notification tap that launched the app is
    /// delivered to this delegate only if it is already set. Calling it again is harmless.
    public func install() { center.delegate = self }

    /// Asks for alert + sound + timeSensitive the first time (call at the right moment: after the first SOS, not at launch).
    public func requestAuthorizationIfNeeded() {
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            var options: UNAuthorizationOptions = [.alert, .sound]
            if #available(iOS 15.0, *) {
                options.insert(.timeSensitive)
            }
            center.requestAuthorization(options: options) { _, _ in }
        }
    }

    // MARK: WelfareNotifying

    public func show(_ p: WelfareCheckin, nowMs: Int64) {
        guard let model = WelfareNotificationModel.build(p, nowMs: nowMs, timeText: Self.clockTime) else { return }
        let request = UNNotificationRequest(identifier: model.identifier, content: content(model), trigger: nil)
        center.add(request) { _ in }
        removeStrayDelivered(thread: model.identifier)
    }

    public func scheduleReminder(_ p: WelfareCheckin, plan: WelfareReminderPlan) {
        // Same identifier as the delivered notification: adding replaces the pending request, and a firing replaces the delivery.
        let id = p.checkinId
        center.removePendingNotificationRequests(withIdentifiers: [id])
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let trigger: UNNotificationTrigger
        let at: Int64
        switch plan {
        case .none: return
        case .atDeadline(let fireAt):
            at = fireAt
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, Double(fireAt - now) / 1000), repeats: false)
        case .repeating(let seconds):
            at = now
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: Double(max(seconds, WelfareReminderPlanner.minRepeatSeconds)), repeats: true)
        }
        // Overdue wording for both: the first fires at the deadline, the repeating ones after it.
        guard let model = WelfareNotificationModel.build(p, nowMs: max(at, p.deadlineAtMs), timeText: Self.clockTime) else { return }
        let request = UNNotificationRequest(identifier: id, content: content(model), trigger: trigger)
        center.add(request) { _ in }
    }

    public func cancel(_ checkinId: String) {
        let ids = [checkinId]
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    public func restore(open: [WelfareCheckin], nowMs: Int64) {
        let openIds = Set(open.map(\.checkinId))
        center.getDeliveredNotifications { [center] delivered in
            let stale = delivered.filter {
                Self.isWelfare($0.request.content) && !openIds.contains($0.request.content.threadIdentifier)
            }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: stale)
        }
        center.getPendingNotificationRequests { [center] pending in
            let stale = pending.filter {
                Self.isWelfare($0.content) && !openIds.contains($0.content.threadIdentifier)
            }.map(\.identifier)
            center.removePendingNotificationRequests(withIdentifiers: stale)
        }
        removeOlderDeliveredReminders()
    }

    // MARK: Content

    private func content(_ m: WelfareNotificationModel) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = m.title
        c.body = m.body
        c.sound = .default
        c.threadIdentifier = m.identifier
        c.userInfo = [Self.idKey: m.identifier, Self.sosKey: m.sosId, Self.kindKey: WelfareNotificationModel.kind]
        if m.timeSensitive, #available(iOS 15.0, *) { c.interruptionLevel = .timeSensitive }
        return c
    }

    /// True for the notifications this app posts for welfare check-ins (no category: the tap opens the in-app screen).
    private static func isWelfare(_ c: UNNotificationContent) -> Bool {
        (c.userInfo[kindKey] as? String) == WelfareNotificationModel.kind
    }

    private static func clockTime(_ ms: Int64) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    /// Earlier delivered reminders of the same check-in (different identifiers) are removed so only the newest stays.
    private func removeStrayDelivered(thread: String) {
        center.getDeliveredNotifications { [center] delivered in
            let mine = delivered.filter { $0.request.content.threadIdentifier == thread }.sorted { $0.date > $1.date }
            center.removeDeliveredNotifications(withIdentifiers: mine.dropFirst().map(\.request.identifier))
        }
    }

    private func removeOlderDeliveredReminders() {
        center.getDeliveredNotifications { [center] delivered in
            let groups = Dictionary(grouping: delivered.filter { Self.isWelfare($0.request.content) }) {
                $0.request.content.threadIdentifier
            }
            let old = groups.values.flatMap { $0.sorted { $0.date > $1.date }.dropFirst() }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: old)
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        removeStrayDelivered(thread: notification.request.content.threadIdentifier)
        return [.banner, .list, .sound]
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // Only the default tap (the notification body) is handled: it opens the in-app check-in screen. Nothing is answered here.
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let id = response.notification.request.content.userInfo[Self.idKey] as? String else { return }
        if let onOpen {
            onOpen(id)
        } else {
            pendingOpenId = id   // cold launch: the UI is not ready yet; delivered when `onOpen` is set
        }
    }
}
#endif
