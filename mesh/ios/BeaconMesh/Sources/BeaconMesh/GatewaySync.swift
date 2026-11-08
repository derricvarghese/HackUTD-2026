import Foundation

/// Exponential backoff for failed backend work: 5 s, 10 s, 20 s ... capped at 5 min.
public struct Backoff: Equatable {
    public private(set) var failures = 0
    public init() {}
    public var delaySeconds: Int { failures == 0 ? 0 : min(300, 5 << min(failures - 1, 6)) }
    public mutating func fail(retryAfter: Int? = nil) -> Int {
        failures += 1
        return max(delaySeconds, retryAfter ?? 0)
    }
    public mutating func succeed() { failures = 0 }
}

public struct UploadResult: Equatable {
    public var atMs: Int64
    public var messageId: String
    public var ok: Bool
    public var detail: String?
}

public struct HeartbeatSample {
    public var lat: Double
    public var lng: Double
    public var batteryPct: Int?
    public var charging: Bool?
    public var moving: Bool?
    public init(lat: Double, lng: Double, batteryPct: Int? = nil, charging: Bool? = nil, moving: Bool? = nil) {
        self.lat = lat; self.lng = lng; self.batteryPct = batteryPct; self.charging = charging; self.moving = moving
    }
}

/// The online half of the phone: registration, server-info refresh, uploads with per-item handling, outbox polling,
/// status polling, heartbeats and check-in replies. Platform independent (connectivity is fed in via `reachable`).
///
/// Threading: every touch of `router` / `config` is bounced through `hop` (the main queue in the app, inline in tests).
/// The network awaits happen in between.
public final class GatewaySync {
    public let client: BackendClient
    public let router: MeshRouter
    public let config: BackendConfig

    /// Set by the connectivity monitor.
    public var reachable = false
    /// Demo switch: pretend there is no internet even when there is.
    public var forceOffline = false
    public var isOnline: Bool { reachable && !forceOffline }

    public var appVersion: String? = nil
    public var hop: (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) }
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public var log: (String) -> Void = { _ in }
    public var sample: () -> HeartbeatSample? = { nil }
    /// Profile sync runs inside the same online cycle (after registration and uploads); it has its own backoff and never fails the cycle.
    public var profileSync: ProfileSyncEngine?

    /// Callbacks (called on `hop`'s queue).
    public var onUploadResult: ((UploadResult) -> Void)?
    public var onCheckins: (([CheckinPrompt]) -> Void)?
    public var onStateChange: (() -> Void)?

    public private(set) var lastError: String?
    public private(set) var lastCycleAtMs: Int64 = 0
    public private(set) var backoff = Backoff()
    public private(set) var nextAttemptAtMs: Int64 = 0

    private var running = false
    private let infoRefreshMs: Int64 = 10 * 60_000

    public init(client: BackendClient, router: MeshRouter, config: BackendConfig) {
        self.client = client
        self.router = router
        self.config = config
    }

    private func main<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { c in hop { c.resume(returning: work()) } }
    }

    /// Kick a cycle (no-op while one runs or when offline). `force` ignores the backoff window.
    public func requestCycle(force: Bool = false) {
        guard isOnline, !running else { return }
        if !force, now() < nextAttemptAtMs { return }
        running = true
        Task { [weak self] in
            await self?.runCycle()
            self?.hop { self?.running = false }
        }
    }

    /// One full online pass. Never throws; failures set the backoff.
    public func runCycle() async {
        guard isOnline else { return }
        do {
            try await refreshInfoIfStale()
            try await ensureRegistered()
            // SOS traffic first; the profile step runs even when one of these fails so a bad batch cannot starve it.
            var stepError: Error?
            do {
                try await flushUploads()
                try await pollOutbox()
                try await pollStatuses()
                try await pollCheckins()
            } catch { stepError = error }
            await profileSync?.runCycle()
            if let stepError { throw stepError }
            _ = await heartbeatIfDue()
            await main { [self] in
                backoff.succeed()
                lastError = nil
                lastCycleAtMs = now()
                nextAttemptAtMs = 0
                onStateChange?()
            }
        } catch {
            await main { [self] in
                let retry: Int?
                if let be = error as? BackendError, case .http(_, _, let ra) = be { retry = ra } else { retry = nil }
                let delay = backoff.fail(retryAfter: retry)
                lastError = describe(error)
                nextAttemptAtMs = now() + Int64(delay) * 1000
                log("Backend sync failed (\(describe(error))); retry in \(delay) s")
                onStateChange?()
            }
        }
    }

    private func describe(_ e: Error) -> String {
        switch e as? BackendError {
        case .http(let s, let c, _)?: return "HTTP \(s)\(c.map { " \($0)" } ?? "")"
        case .transport(let m)?: return m
        case .notRegistered?: return "not registered"
        case .badResponse?: return "bad response"
        case nil: return "\(e)"
        }
    }

    // MARK: Steps

    func refreshInfoIfStale() async throws {
        let stale = await main { [self] in now() - config.lastInfoAtMs > infoRefreshMs || config.encryptionKeyStatus != .cached }
        guard stale else { return }
        let info = try await client.fetchServerInfo()
        await main { [self] in
            log("Server info refreshed (event \(info.eventActive ? "active" : "none"))")
            router.reverifyBackend()
            onStateChange?()
        }
    }

    func ensureRegistered() async throws {
        let has = await main { [self] in config.deviceId != nil }
        guard !has else { return }
        let id = try await client.registerDevice(appVersion: appVersion)
        await main { [self] in log("Device registered \(id.prefix(8))"); onStateChange?() }
    }

    func flushUploadsForTest() async { try? await flushUploads() }

    func flushUploads() async throws {
        let pending = await main { [self] in router.pendingUploads }
        guard !pending.isEmpty else { return }
        var batchable: [StoredMessage] = []
        for msg in pending {
            if await tryDirect(msg) { continue }
            batchable.append(msg)
        }
        let size = await main { [self] in config.maxBatch }
        var index = 0
        while index < batchable.count {
            let chunk = Array(batchable[index..<min(index + size, batchable.count)])
            index += size
            do {
                let resp = try await client.uploadBatch(chunk)
                await main { [self] in handleBatch(resp, sent: chunk) }
            } catch let e as BackendError {
                await main { [self] in
                    chunk.forEach { onUploadResult?(UploadResult(atMs: now(), messageId: $0.id, ok: false, detail: describe(e))) }
                }
                throw e
            }
        }
    }

    /// Own SOS / safe messages go straight to POST /v1/sos while we have internet. Returns true when handled.
    private func tryDirect(_ msg: StoredMessage) async -> Bool {
        guard msg.isOwn, msg.envelope.kind == "sos" || msg.envelope.kind == "safe", let own = msg.own,
              own.lat != nil, own.lng != nil, let cat = Category.fromWire(own.category) else { return false }
        do {
            let created = try await client.createSos(id: msg.id, category: own.category, own: own,
                                                     createdAtMs: msg.envelope.createdAtMs, apiCategory: cat.apiCategory)
            await main { [self] in
                router.markUploaded(msg.id)
                config.lastUploadAtMs = now()
                log("UPLOAD \(msg.id.prefix(8)) ok (direct, \(created ? "created" : "replay"))")
                onUploadResult?(UploadResult(atMs: now(), messageId: msg.id, ok: true, detail: nil))
            }
            return true
        } catch {
            // Fall back to the batch endpoint with the signed envelope (same id, idempotent).
            await main { [self] in log("Direct SOS \(msg.id.prefix(8)) failed (\(describe(error))); trying batch") }
            return false
        }
    }

    func handleBatch(_ resp: BatchResponse, sent: [StoredMessage]) {
        let t = now()
        for r in resp.results {
            switch r.status {
            case "created", "duplicate":
                router.markUploaded(r.id)
                config.lastUploadAtMs = t
                log("UPLOAD \(r.id.prefix(8)) ok (\(r.status))")
                onUploadResult?(UploadResult(atMs: t, messageId: r.id, ok: true, detail: nil))
            default:
                let reason = r.reason ?? "rejected"
                // rate_limited is transient: keep it queued. Everything else is a permanent verdict.
                if reason != "rate_limited" { router.markRejected(r.id, reason: reason) }
                log("UPLOAD \(r.id.prefix(8)) rejected: \(reason)")
                onUploadResult?(UploadResult(atMs: t, messageId: r.id, ok: false, detail: reason))
            }
        }
        router.inject(messages: resp.messages, receipts: resp.receipts)
        onStateChange?()
    }

    func pollOutbox() async throws {
        let msgs = try await client.fetchOutbox()
        guard !msgs.isEmpty else { return }
        _ = await main { [self] in router.inject(messages: msgs, receipts: []) }
    }

    /// GET /sos/{id}/status for own, uploaded, unfinished cases (newest 10).
    func pollStatuses() async throws {
        let ids: [String] = await main { [self] in
            router.messages.filter {
                $0.isOwn && $0.uploaded && ($0.envelope.kind == "sos" || $0.envelope.kind == "safe")
                    && !["resolved", "closed", "merged"].contains($0.serverStatus?.status ?? "")
            }.sorted { $0.receivedAt > $1.receivedAt }.prefix(10).map(\.id)
        }
        for id in ids {
            do {
                let st = try await client.sosStatus(id: id)
                await main { [self] in router.applyStatus(st, to: id, keepNewer: true) }
            } catch let e as BackendError {
                if case .http(let s, _, _) = e, s == 404 || s == 403 || s == 422 { continue }
                throw e
            }
        }
    }

    func pollCheckins() async throws {
        let prompts = try await client.pendingCheckins()
        await main { [self] in onCheckins?(prompts) }
    }

    // MARK: Heartbeats

    /// Called by the node's timer. Online: POST /v1/heartbeats. Offline: a `kind=heartbeat` mesh envelope.
    /// Does nothing when no event is active (per the last cached /server-info), when not due, or without a location.
    @discardableResult
    public func heartbeatIfDue() async -> Bool {
        let due: (HeartbeatSample, Int)? = await main { [self] in
            guard config.eventActive else { return nil }
            let interval = Int64(config.heartbeatIntervalSeconds) * 1000
            guard now() - config.lastHeartbeatAtMs >= interval, let s = sample() else { return nil }
            return (s, config.heartbeatSeq + 1)
        }
        guard let (s, seq) = due else { return false }
        if isOnline, await main({ [self] in config.deviceId != nil }) {
            let body = MeshPayload.heartbeatBody(sentAtMs: now(), lat: s.lat, lng: s.lng, batteryPct: s.batteryPct,
                                                  charging: s.charging, moving: s.moving, seq: seq)
            do {
                let reply = try await client.sendHeartbeat(body)
                await main { [self] in
                    config.heartbeatSeq = seq
                    config.lastHeartbeatAtMs = now()
                    if let active = reply.eventActive { config.setEventActive(active) }
                    log("Heartbeat #\(seq) sent")
                    onStateChange?()
                }
                return true
            } catch {
                if let be = error as? BackendError, case .http(404, _, _) = be { await main { [self] in config.setEventActive(false) }; return false }
                await main { [self] in log("Heartbeat failed (\(describe(error))); sending over the mesh") }
            }
        }
        return await main { [self] in
            do {
                _ = try router.originateHeartbeat(lat: s.lat, lng: s.lng, batteryPct: s.batteryPct, charging: s.charging,
                                                  moving: s.moving, seq: seq)
                config.heartbeatSeq = seq
                config.lastHeartbeatAtMs = now()
                onStateChange?()
                return true
            } catch {
                log("Heartbeat not sent: \(error)")
                return false
            }
        }
    }

    /// Heartbeat sent just before the event is considered over is irrelevant; this is only for tests/UI.
    public func resetHeartbeatTimer() { config.lastHeartbeatAtMs = 0 }

    // MARK: Check-in replies

    /// Reply to a check-in: PATCH /checkins/{id} when online, otherwise a signed `checkin_reply` envelope.
    public func reply(to prompt: CheckinPrompt, response: String, text: String?, lat: Double?, lng: Double?) async throws {
        if isOnline, await main({ [self] in config.deviceId != nil }) {
            do {
                try await client.respondCheckin(id: prompt.checkinId, response: response, text: text)
                await main { [self] in router.markCheckinAnswered(checkinId: prompt.checkinId); log("Check-in answered online") }
                return
            } catch let e as BackendError where !e.isRetryable {
                // 404/409 etc: nothing more to do online; fall through would create a pointless duplicate
                if case .http(409, _, _) = e { await main { [self] in router.markCheckinAnswered(checkinId: prompt.checkinId) }; return }
                throw e
            } catch { /* network trouble: use the mesh path below */ }
        }
        try await mainThrowing { [self] in
            _ = try router.originateCheckinReply(checkinId: prompt.checkinId, response: response, text: text, lat: lat, lng: lng)
            router.markCheckinAnswered(checkinId: prompt.checkinId)
        }
    }
}

extension GatewaySync {
    fileprivate func mainThrowing(_ work: @escaping () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            hop { do { try work(); c.resume() } catch { c.resume(throwing: error) } }
        }
    }
}
