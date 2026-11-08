#if canImport(UserNotifications)
import Foundation
import UserNotifications

/// Apple glue for welfare check-in notifications (UserNotifications). Everything decided here comes from the pure
/// `WelfareNotificationModel` / `WelfareReminderPlanner`. NOT compiled in CI (no Apple toolchain on Linux): review in Xcode.
///
/// Rules: exactly ONE notification per check-in id (the request identifier is the check-in id; re-adding replaces it).
/// The reminder is the same single request: non-repeating at the deadline, then repeating (>= 60 s) once the app has run
/// overdue; each firing replaces the previous delivery. Three actions: "I'm still here" and "I no longer need help" run in the background
/// (the reply is sent without opening the app), "I need urgent help" opens the app. Time Sensitive interruption level is
/// requested (needs the Time Sensitive Notifications capability); no critical alerts, no alarm.
///
/// iOS limits: the app only runs in the background for Bluetooth and short wakeups, so a check-in can only be posted when the
/// app runs (BLE wake, foreground, heartbeat reply). Real push (APNs) is not set up.
public final class WelfareNotificationCenter: NSObject, WelfareNotifying, UNUserNotificationCenterDelegate {
    public static let shared = WelfareNotificationCenter()

    /// (checkin id, response) from an action button. Called off the main queue.
    public var onAnswer: ((String, String) async -> Void)?
    /// A notification was tapped: show the confirmation sheet for this check-in id.
    public var onOpen: ((String) -> Void)?

    private let center = UNUserNotificationCenter.current()
    private static let idKey = "checkin_id"
    private static let sosKey = "sos_id"

    private override init() { super.init() }

    /// Call once at launch (the delegate must be set before the app finishes launching to see action responses).
    public func install() { center.delegate = self }

    /// Asks for alert + sound the first time (call at the right moment: after the first SOS, not at launch).
    public func requestAuthorizationIfNeeded() {
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    // MARK: WelfareNotifying

    public func show(_ p: WelfareCheckin, nowMs: Int64) {
        guard let model = WelfareNotificationModel.build(p, nowMs: nowMs, timeText: Self.clockTime) else { return }
        let request = UNNotificationRequest(identifier: model.identifier, content: content(model), trigger: nil)
        register(model) { [center] in
            center.add(request) { _ in }
            self.removeStrayDelivered(thread: model.identifier)
        }
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
        register(model) { [center] in center.add(request) { _ in } }
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
                $0.request.content.categoryIdentifier.hasPrefix(WelfareNotificationModel.categoryPrefix)
                    && !openIds.contains($0.request.content.threadIdentifier)
            }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: stale)
        }
        center.getPendingNotificationRequests { [center] pending in
            let stale = pending.filter {
                $0.content.categoryIdentifier.hasPrefix(WelfareNotificationModel.categoryPrefix)
                    && !openIds.contains($0.content.threadIdentifier)
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
        c.categoryIdentifier = m.categoryId
        c.threadIdentifier = m.identifier
        c.userInfo = [Self.idKey: m.identifier, Self.sosKey: m.sosId]
        if m.timeSensitive, #available(iOS 15.0, *) { c.interruptionLevel = .timeSensitive }
        return c
    }

    /// Registers the category of this notification (merged with the existing ones), then runs `then`.
    private func register(_ m: WelfareNotificationModel, then: @escaping () -> Void) {
        let actions = m.actions.map {
            UNNotificationAction(identifier: $0.identifier, title: $0.title, options: $0.foreground ? [.foreground] : [])
        }
        let category = UNNotificationCategory(identifier: m.categoryId, actions: actions, intentIdentifiers: [], options: [])
        center.getNotificationCategories { [center] existing in
            var all = existing.filter { $0.identifier != m.categoryId }
            all.insert(category)
            center.setNotificationCategories(all)
            then()
        }
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
            let groups = Dictionary(grouping: delivered.filter {
                $0.request.content.categoryIdentifier.hasPrefix(WelfareNotificationModel.categoryPrefix)
            }) { $0.request.content.threadIdentifier }
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
        let info = response.notification.request.content.userInfo
        guard let id = info[Self.idKey] as? String else { return }
        let action = response.actionIdentifier
        if action == UNNotificationDefaultActionIdentifier {
            onOpen?(id)
        } else if WelfareResponse.isKnown(action) {
            // Runs in the background for the two calm replies; the system keeps the app alive until this returns.
            await onAnswer?(id, action)
        }
    }
}
#endif
