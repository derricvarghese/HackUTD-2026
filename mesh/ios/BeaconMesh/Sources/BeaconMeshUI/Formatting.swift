#if canImport(UIKit) && canImport(SwiftUI)
import BeaconMesh
import SwiftUI

/// `Category` alone is ambiguous with the Objective-C runtime type that Foundation re-exports on Apple platforms.
typealias Category = BeaconMesh.Category

/// Text, icon and colour for the contract statuses. Kept free of view code so it is easy to read.
enum StatusStyle {
    static func text(_ s: MessageStatus) -> String {
        switch s {
        case .queued: return "Queued, waiting for a phone nearby"
        case .relayed(let n): return n == 1 ? "Relayed via 1 phone" : "Relayed via \(n) phones"
        case .sending: return "Sending to responders"
        case .reachedResponders: return "Reached responders"
        case .progress(let status, let eta, let message):
            if let message, !message.isEmpty { return message }
            let base = statusName(status)
            return eta.map { "\(base), ETA \($0) min" } ?? base
        case .relaying: return "Passing it on"
        case .held: return "Hop limit reached, kept here"
        case .rejected(let reason): return "Not accepted: \(reason.replacingOccurrences(of: "_", with: " "))"
        }
    }

    static func statusName(_ status: String) -> String {
        switch status {
        case "assigned": return "Help assigned"
        case "en_route": return "Help is on the way"
        case "on_scene": return "Help is on scene"
        case "resolved": return "Resolved"
        case "closed": return "Closed"
        case "merged": return "Merged with another report"
        default: return "Reached responders"
        }
    }

    static func symbol(_ s: MessageStatus) -> String {
        switch s {
        case .queued: return "clock"
        case .relayed: return "dot.radiowaves.left.and.right"
        case .sending: return "arrow.up.circle"
        case .reachedResponders: return "checkmark.circle.fill"
        case .progress(let status, _, _): return status == "resolved" || status == "closed" ? "checkmark.seal.fill" : "figure.run.circle.fill"
        case .relaying: return "arrow.triangle.branch"
        case .held: return "pause.circle"
        case .rejected: return "exclamationmark.triangle.fill"
        }
    }

    static func color(_ s: MessageStatus) -> Color {
        switch s {
        case .reachedResponders, .progress: return .green
        case .rejected: return .red
        case .queued, .held: return .orange
        default: return .blue
        }
    }
}

enum Fmt {
    static func age(fromMs: Int64, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        switch MessageUi.age(fromMs: fromMs, nowMs: nowMs) {
        case .now: return "just now"
        case .minutes(let m): return "\(m) min ago"
        case .hours(let h): return "\(h) h ago"
        case .days(let d): return "\(d) d ago"
        }
    }

    static func time(_ d: Date?) -> String {
        guard let d else { return "never" }
        return d.formatted(date: .omitted, time: .standard)
    }

    static func categoryName(_ item: MessageItem) -> String {
        switch item.categoryWire {
        case "trapped": return "Trapped"
        case "injured": return "Injured"
        case "medical": return "Medical"
        case "water_meds", "need_water_meds": return "Water or medicine"
        case "safe": return "I'm safe"
        case "checkin": return "Check-in"
        case "checkin_reply": return "Check-in reply"
        case "other": return item.kind == "sos" ? "Other" : "Message"
        default: return item.categoryWire.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

extension Category {
    var title: String {
        switch self {
        case .trapped: return "Trapped"
        case .injured: return "Injured"
        case .medical: return "Medical"
        case .waterMeds: return "Water or meds"
        case .checkin: return "Check-in"
        case .other: return "Other"
        case .safe: return "I'm safe"
        }
    }

    var symbol: String {
        switch self {
        case .trapped: return "figure.fall"
        case .injured: return "cross.case.fill"
        case .medical: return "heart.text.square.fill"
        case .waterMeds: return "drop.fill"
        case .checkin: return "bell.badge.fill"
        case .other: return "ellipsis.circle.fill"
        case .safe: return "checkmark.shield.fill"
        }
    }

    var color: Color {
        switch tier {
        case .critical: return .red
        case .high: return .orange
        case .safe: return .green
        default: return .blue
        }
    }

    /// Critical and high alerts need a deliberate hold to avoid pocket sends.
    var requiresHold: Bool { tier == .critical || tier == .high }
}

extension KeyStatus {
    var label: String {
        switch self {
        case .none: return "Missing"
        case .builtIn: return "Built in"
        case .cached: return "From server"
        }
    }
}
#endif
