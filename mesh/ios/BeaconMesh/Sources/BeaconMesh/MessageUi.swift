import Foundation

/// How a message looks to the user, derived from the stored state. Pure logic (unit tested); the UI only formats it.
public enum MessageStatus: Equatable {
    /// Own message, no phone in range yet: waiting in the local store.
    case queued
    /// Own message handed to nearby phones.
    case relayed(peers: Int)
    /// Own message, internet available, upload in progress or about to start.
    case sending
    /// Reached the backend, i.e. responders.
    case reachedResponders
    /// Backend status: assigned | en_route | on_scene | resolved | closed | merged (+ ETA when known).
    case progress(status: String, etaMinutes: Int?, message: String?)
    /// Received from the mesh and still being passed on.
    case relaying
    /// Received, hop limit reached: kept only, not forwarded.
    case held
    /// The server rejected the upload (bad_signature, expired, ...).
    case rejected(reason: String)
}

public struct MessageItem: Equatable, Identifiable {
    public var id: String
    public var shortId: String
    public var category: Category?
    public var categoryWire: String
    public var kind: String
    public var critical: Bool
    public var text: String?
    public var people: Int?
    public var createdAtMs: Int64
    public var receivedAtMs: Int64
    public var expiresAtMs: Int64
    public var isOwn: Bool
    public var uploaded: Bool
    public var hop: Int
    public var maxHops: Int
    /// Relay ids from origin to the last transmitter.
    public var path: [String]
    public var status: MessageStatus
    public var canForward: Bool
}

public enum MessageUi {
    public static func map(_ m: StoredMessage, online: Bool = false) -> MessageItem {
        let cat = m.own.flatMap { Category(rawValue: $0.category) } ?? Category.fromWire(m.envelope.category)
        return MessageItem(
            id: m.id, shortId: String(m.id.prefix(8)), category: cat,
            categoryWire: m.own?.category ?? m.envelope.category ?? m.envelope.kind, kind: m.envelope.kind,
            critical: m.envelope.tier == Tier.critical.rawValue, text: m.own?.text, people: m.own?.people,
            createdAtMs: m.envelope.createdAtMs, receivedAtMs: m.receivedAt, expiresAtMs: m.envelope.expiresAtMs,
            isOwn: m.isOwn, uploaded: m.uploaded, hop: m.envelope.hopCount, maxHops: m.envelope.maxHops,
            path: m.envelope.hopPath, status: status(m, online: online), canForward: m.canForward)
    }

    public static func status(_ m: StoredMessage, online: Bool) -> MessageStatus {
        if let reason = m.rejectedReason { return .rejected(reason: reason) }
        if m.isOwn, let s = m.serverStatus, s.status != "reported" {
            return .progress(status: s.status, etaMinutes: s.etaMinutes, message: s.message)
        }
        if m.uploaded || m.serverStatus?.reachedResponders == true { return .reachedResponders }
        if m.isOwn {
            if online { return .sending }
            return m.sentToPeers > 0 ? .relayed(peers: m.sentToPeers) : .queued
        }
        return m.canForward ? .relaying : .held
    }

    public enum Age: Equatable { case now, minutes(Int), hours(Int), days(Int) }

    public static func age(fromMs: Int64, nowMs: Int64) -> Age {
        let s = max(0, (nowMs - fromMs) / 1000)
        switch s {
        case ..<60: return .now
        case ..<3600: return .minutes(Int(s / 60))
        case ..<86_400: return .hours(Int(s / 3600))
        default: return .days(Int(s / 86_400))
        }
    }

    public enum Filter: CaseIterable { case all, mine, received, held }

    public static func filter(_ items: [MessageItem], _ f: Filter) -> [MessageItem] {
        switch f {
        case .all: return items
        case .mine: return items.filter { $0.isOwn }
        case .received: return items.filter { !$0.isOwn }
        case .held: return items.filter { !$0.uploaded }
        }
    }

    /// Messages still waiting for a gateway (the "held offline" count).
    public static func heldOffline(_ items: [MessageItem]) -> Int { items.filter { !$0.uploaded }.count }
}

/// The hold-to-send haptic ramp: intensity builds from `start` to 1 over the hold time. Shared by CoreHaptics
/// control points and the UIKit fallback ticks, so both feel the same.
public struct HoldRamp: Equatable {
    public var duration: Double
    public var start: Double
    /// >1 makes the build-up accelerate towards the end.
    public var curve: Double

    public init(duration: Double = 1.5, start: Double = 0.12, curve: Double = 1.6) {
        self.duration = duration; self.start = start; self.curve = curve
    }

    public func intensity(at t: Double) -> Double {
        let x = min(max(t / duration, 0), 1)
        return min(1, start + (1 - start) * pow(x, curve))
    }

    /// (time, intensity) control points for a CHHapticParameterCurve.
    public func controlPoints(count: Int = 8) -> [(time: Double, value: Double)] {
        (0..<max(count, 2)).map { i in
            let t = duration * Double(i) / Double(max(count, 2) - 1)
            return (t, intensity(at: t))
        }
    }
}
