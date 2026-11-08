import Foundation

// Pure-logic throttle / backoff / clear state machine for a responder sharing their position with dispatch
// (`PATCH /v1/responders/{id}` {location:{lat,lng}}, `null` to stop). No CoreLocation, no clock, no network
// in here: the app feeds fixes in, a clock and a sending protocol are injected, tests use fakes.
//
// Rules: send when the position moved >= 25 m since the last send, or 60 s after the last send (never more than
// once per 10 s). Failures back off exponentially. Nothing is sent while offline; only the latest fix is kept.
// Stopping (switch off, sign out, ...) sends `location: null`, retrying until it works, unless the session is
// gone for good. Coordinates are never logged by this type.

public struct SharedPosition: Equatable {
    public var lat: Double
    public var lng: Double
    public init(lat: Double, lng: Double) { self.lat = lat; self.lng = lng }

    /// Great-circle distance in metres.
    public func distanceM(to o: SharedPosition) -> Double {
        let r = 6_371_000.0
        let p1 = lat * .pi / 180, p2 = o.lat * .pi / 180
        let dp = (o.lat - lat) * .pi / 180, dl = (o.lng - lng) * .pi / 180
        let a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * r * atan2(a.squareRoot(), (1 - a).squareRoot())
    }
}

public struct LocationSharePolicy: Equatable {
    public var minDistanceM = 25.0
    public var minIntervalMs: Int64 = 10_000
    public var maxIntervalMs: Int64 = 60_000
    /// A fix older than this is not re-sent as a heartbeat (dashboards grey out stale positions).
    public var maxFixAgeMs: Int64 = 180_000
    public var backoffBaseMs: Int64 = 10_000
    public var backoffMaxMs: Int64 = 300_000
    public init() {}
}

/// What the app uses to talk to the server. `nil` clears the stored position. Throw `ResponderError.signedOut`
/// when the session is gone for good; any other error is treated as transient.
public protocol ResponderLocationSending: AnyObject {
    func sendLocation(_ position: SharedPosition?) async throws
}

@MainActor
public final class ResponderLocationSharer {
    public enum Phase: Equatable { case idle, sharing, clearing }

    public private(set) var phase: Phase = .idle
    public private(set) var failures = 0
    /// Called when the session turned out to be gone for good; sharing is already off.
    public var onSessionLost: (() -> Void)?

    private let client: ResponderLocationSending
    private let now: () -> Int64
    private let policy: LocationSharePolicy
    private var latest: SharedPosition?
    private var latestAtMs: Int64 = 0
    private var lastSent: SharedPosition?
    private var lastSentAtMs: Int64?
    private var backoffUntilMs: Int64 = 0
    private var online = true
    private var inFlight = false

    public init(client: ResponderLocationSending, now: @escaping () -> Int64, policy: LocationSharePolicy = LocationSharePolicy()) {
        self.client = client; self.now = now; self.policy = policy
    }

    public var isSharing: Bool { phase == .sharing }

    // MARK: Inputs

    /// Begin sharing (only call after a successful sign-in this session). Cancels a pending clear.
    public func start() {
        guard phase != .sharing else { return }
        phase = .sharing
        latest = nil; lastSent = nil; lastSentAtMs = nil
        failures = 0; backoffUntilMs = 0
    }

    /// A new fix. Only the latest one is kept.
    public func update(_ position: SharedPosition) {
        guard phase == .sharing else { return }
        latest = position
        latestAtMs = now()
    }

    public func setOnline(_ value: Bool) { online = value }

    /// Stop sharing. With `clear` the stored position is removed on the server (`location: null`), retried until it
    /// works. Without it the state is simply dropped (the session is gone, or nothing was ever sent).
    public func stop(clear: Bool = true) {
        guard phase == .sharing else { return }
        let needsClear = clear && (lastSentAtMs != nil || inFlight)
        latest = nil
        phase = needsClear ? .clearing : .idle
        if needsClear { backoffUntilMs = min(backoffUntilMs, now()) }
        if !needsClear { reset() }
    }

    /// Give up on a pending clear (sign out finished, nothing can be sent any more).
    public func abandon() {
        phase = .idle
        reset()
    }

    // MARK: Driving

    /// When `pump()` next has something to do, or nil. Lets the app sleep instead of polling.
    public func nextWakeMs() -> Int64? {
        let t = now()
        switch phase {
        case .idle: return nil
        case .clearing: return max(t, backoffUntilMs)
        case .sharing:
            guard let latest else { return nil }
            var due = max(backoffUntilMs, lastSentAtMs.map { $0 + policy.minIntervalMs } ?? 0)
            if let lastSent, lastSentAtMs != nil, latest.distanceM(to: lastSent) < policy.minDistanceM {
                due = max(due, (lastSentAtMs ?? 0) + policy.maxIntervalMs)
            }
            return max(t, due)
        }
    }

    /// Performs at most one due send. Call after any input and whenever `nextWakeMs()` passes.
    public func pump() async {
        guard !inFlight, online else { return }
        let t = now()
        switch phase {
        case .idle:
            return
        case .clearing:
            guard t >= backoffUntilMs else { return }
            inFlight = true
            let ok = await attempt(nil)
            inFlight = false
            if phase == .clearing, ok { abandon() }
        case .sharing:
            guard let p = latest, t >= backoffUntilMs else { return }
            if let at = lastSentAtMs {
                if t - at < policy.minIntervalMs { return }
                let moved = lastSent.map { p.distanceM(to: $0) >= policy.minDistanceM } ?? true
                if !moved {
                    if t - at < policy.maxIntervalMs { return }
                    if t - latestAtMs > policy.maxFixAgeMs { return }
                }
            }
            inFlight = true
            let ok = await attempt(p)
            inFlight = false
            if ok, phase == .sharing {
                lastSent = p
                lastSentAtMs = t
            } else if ok, phase == .clearing {
                // Stopped while this send was in flight: it landed after the stop, so the clear is still needed.
                lastSentAtMs = t
            }
        }
    }

    // MARK: Private

    private func attempt(_ p: SharedPosition?) async -> Bool {
        do {
            try await client.sendLocation(p)
            failures = 0
            backoffUntilMs = 0
            return true
        } catch let e as ResponderError where e == .signedOut {
            phase = .idle
            reset()
            onSessionLost?()
            return false
        } catch {
            failures += 1
            let shift = Int64(min(failures - 1, 16))
            backoffUntilMs = now() + min(policy.backoffBaseMs << shift, policy.backoffMaxMs)
            return false
        }
    }

    private func reset() {
        latest = nil; lastSent = nil; lastSentAtMs = nil
        failures = 0; backoffUntilMs = 0
    }
}
