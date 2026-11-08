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
    /// Welfare check-ins: fed from the heartbeat reply, `GET /checkins/pending` and (via the router) mesh requests.
    public var welfare: WelfareManager?
    /// Offline retry queue for photos attached to SOS cases.
    public var imageQueue: CaseImageUploadQueue?
    /// Interface type of the current network path (set by the connectivity monitor); feeds `HeartbeatCreate.network`.
    public var interface: NetworkInterfaceKind = .unknown
    /// Profile sync runs inside the same online cycle (after registration and uploads); it has its own backoff and never fails the cycle.
    public var profileSync: ProfileSyncEngine?

    /// Callbacks (called on `hop`'s queue).
    public var onUploadResult: ((UploadResult) -> Void)?
    public var onStateChange: (() -> Void)?

    public private(set) var lastError: String?
    public private(set) var lastCycleAtMs: Int64 = 0
    public private(set) var backoff = Backoff()
    public private(set) var nextAttemptAtMs: Int64 = 0

    private var running = false
    private var forceHeartbeat = false
    private var heartbeatInFlight = false
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
                await flushQueuedImages()
                try await pollOutbox()
                try await pollStatuses()
                try await pollCheckins()
            } catch { stepError = error }
            // Automatic liveness: never skipped because a step above failed. Also carries pending check-ins back.
            _ = await heartbeatIfDue()
            await flushCheckinReplies()
            await profileSync?.runCycle()
            if let stepError { throw stepError }
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

    /// Uploads photos attached to SOS cases that were queued offline.
    func flushQueuedImages() async {
        guard let imageQueue else { return }
        _ = await imageQueue.flush { [weak self] item in
            guard let self else { return .retry(afterSeconds: nil) }
            do {
                let res = try await self.client.uploadCaseImage(sosId: item.sosId, imageId: item.id, data: item.data, caption: item.caption)
                if res.status == 200 || res.status == 201 {
                    self.log("Uploaded photo \(item.id.prefix(8)) for case \(item.sosId.prefix(8))")
                    return .success(CaseImageMeta.fromJSON(res.json))
                } else if res.status == 409 || res.status == 413 || res.status == 415 || res.status == 422 {
                    self.log("Dropped photo \(item.id.prefix(8)) (HTTP \(res.status))")
                    return .drop(status: res.status, message: res.json.optString("message"))
                } else if res.status == 429 {
                    return .retry(afterSeconds: res.retryAfter)
                } else {
                    return .retry(afterSeconds: nil)
                }
            } catch {
                return .retry(afterSeconds: nil)
            }
        }
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
        let items = try await client.pendingCheckins()
        await main { [self] in
            welfare?.ingest(items)
            welfare?.reconcile(serverPendingIds: Set(items.map(\.checkinId)))
        }
    }

    // MARK: Heartbeats

    /// Ask for a heartbeat right now (an SOS was just created). Safe to call from any place on the hop queue.
    public func requestHeartbeat() {
        forceHeartbeat = true
        Task { await heartbeatIfDue() }
    }

    private struct HeartbeatPlan {
        var sample: HeartbeatSample
        var seq: Int
        var intervalSeconds: Int
        var extras: HeartbeatExtras
    }

    /// The automatic liveness beacon. Online: POST /v1/heartbeats (transport `direct`); offline or on a network failure: a
    /// `kind=heartbeat` mesh envelope (transport `mesh`). Sent whenever due, with or without an active event and while an SOS
    /// is open. `force` (also set by `requestHeartbeat`) skips the interval, e.g. when connectivity returns. Without any
    /// location fix there is nothing to send.
    @discardableResult
    public func heartbeatIfDue(force: Bool = false) async -> Bool {
        let plan: HeartbeatPlan? = await main { [self] in
            guard !heartbeatInFlight else { return nil }
            let s = sample()
            let interval = config.heartbeatIntervalSeconds
            guard let s, Heartbeat.shouldSend(nowMs: now(), lastSentMs: config.lastHeartbeatAtMs, intervalSeconds: interval,
                                              force: force || forceHeartbeat, hasLocation: true) else { return nil }
            heartbeatInFlight = true
            forceHeartbeat = false
            let extras = HeartbeatExtras(
                transport: nil, network: Heartbeat.networkKind(reachable: isOnline, interface: interface),
                peersNearby: router.connectedPeers.count, gateway: isOnline,
                openSosIds: Heartbeat.openSosIds(router.messages, nowMs: now(), ownPublicKey: router.senderPublicKey))
            return HeartbeatPlan(sample: s, seq: config.heartbeatSeq + 1, intervalSeconds: interval, extras: extras)
        }
        guard let plan else { return false }
        let sent = await sendHeartbeat(plan)
        await main { [self] in heartbeatInFlight = false }
        return sent
    }

    private func sendHeartbeat(_ plan: HeartbeatPlan) async -> Bool {
        let s = plan.sample, seq = plan.seq
        if isOnline, await main({ [self] in config.deviceId != nil }) {
            var extras = plan.extras
            extras.transport = "direct"
            let body = MeshPayload.heartbeatBody(sentAtMs: now(), lat: s.lat, lng: s.lng, batteryPct: s.batteryPct,
                                                  charging: s.charging, moving: s.moving, seq: seq, extras: extras)
            do {
                let reply = try await client.sendHeartbeat(body)
                await main { [self] in
                    config.heartbeatSeq = seq
                    config.lastHeartbeatAtMs = now()
                    if let active = reply.eventActive { config.setEventActive(active) }
                    log("Heartbeat #\(seq) sent")
                    welfare?.ingest(reply.pendingCheckins)
                    onStateChange?()
                }
                return true
            } catch {
                if let be = error as? BackendError, case .http(404, _, _) = be {
                    // Neither an active event nor an open SOS for this device: nothing to keep alive. Try again later.
                    await main { [self] in
                        config.setEventActive(false)
                        let delay = Heartbeat.retryDelayAfterNotFound(intervalSeconds: plan.intervalSeconds, hasOpenSos: !plan.extras.openSosIds.isEmpty)
                        config.lastHeartbeatAtMs = now() - Int64(plan.intervalSeconds - delay) * 1000
                        onStateChange?()
                    }
                    return false
                }
                await main { [self] in log("Heartbeat failed (\(describe(error))); sending over the mesh") }
            }
        }
        return await main { [self] in
            do {
                var extras = plan.extras
                extras.transport = "mesh"
                _ = try router.originateHeartbeat(lat: s.lat, lng: s.lng, batteryPct: s.batteryPct, charging: s.charging,
                                                  moving: s.moving, seq: seq, extras: extras)
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

    // MARK: Welfare check-in replies

    public enum ReplyOutcome: Equatable {
        /// The server has the answer (200).
        case delivered
        /// 409 (already answered / expired) or 404: nothing more to send.
        case cleared
        /// Offline: a `checkin_reply` mesh envelope was created for a gateway to carry.
        case meshSent
        /// Network / 5xx / 429 (or no location for the envelope): retried with backoff until the deadline.
        case retryLater
        /// Rejected for good (other 4xx).
        case rejected
        /// Unknown check-in, an invalid response, or already answered.
        case ignored
    }

    /// The person answered. Marks it answered locally at once (notification removed), shows the case as resolved for
    /// `no_longer_need_help`, then delivers: PATCH /v1/checkins/{id} when online, a `checkin_reply` envelope otherwise.
    @discardableResult
    public func answerCheckin(_ checkinId: String, response: String) async -> ReplyOutcome {
        let accepted: Bool = await main { [self] in
            guard let done = welfare?.answer(checkinId, response: response) else { return false }
            if response == WelfareResponse.noLongerNeedHelp { router.markResolvedLocally(sosId: done.sosId) }
            return true
        }
        guard accepted else { return .ignored }
        return await deliverReply(checkinId)
    }

    /// Sends (or re-sends) the stored answer of a check-in.
    @discardableResult
    public func deliverReply(_ checkinId: String) async -> ReplyOutcome {
        typealias Job = (WelfareCheckin, String, Bool)
        let job: Job? = await main { [self] in
            guard let p = welfare?.find(checkinId), let response = p.answer, !p.delivered else { return nil }
            return (p, response, isOnline && config.deviceId != nil)
        }
        guard let (p, response, online) = job else { return .ignored }
        if online {
            do {
                try await client.respondCheckin(id: checkinId, response: response, text: nil)
                await main { [self] in markReplyDone(checkinId); router.markCheckinAnswered(checkinId: checkinId); log("Check-in answered online") }
                return .delivered
            } catch let e as BackendError {
                if case .http(let status, _, let retryAfter) = e {
                    if status == 409 || status == 404 {
                        await main { [self] in markReplyDone(checkinId); router.markCheckinAnswered(checkinId: checkinId) }
                        return .cleared
                    }
                    if status >= 400 && status < 500 && status != 429 && status != 401 {
                        await main { [self] in markReplyDone(checkinId); log("Check-in reply rejected (HTTP \(status))") }
                        return .rejected
                    }
                    await main { [self] in scheduleReplyRetry(checkinId, retryAfter: retryAfter) }
                } else {
                    await main { [self] in scheduleReplyRetry(checkinId, retryAfter: nil) }
                }
            } catch {
                await main { [self] in scheduleReplyRetry(checkinId, retryAfter: nil) }
            }
            // The server may be unreachable although the network looks fine: let a gateway carry it too.
            if !p.meshReplied, await sendReplyOverMesh(checkinId, response) { return .retryLater }
            return .retryLater
        }
        return await sendReplyOverMesh(checkinId, response) ? .meshSent : .retryLater
    }

    /// Re-tries answers that did not reach the server yet (due ones only, never after the deadline). Called on each cycle/tick.
    public func flushCheckinReplies() async {
        let due: [(String, Bool)] = await main { [self] in (welfare?.dueReplies() ?? []).map { ($0.checkinId, $0.meshReplied) } }
        let online = await main { [self] in isOnline && config.deviceId != nil }
        for (id, meshReplied) in due where online || !meshReplied { _ = await deliverReply(id) }
    }

    private func markReplyDone(_ id: String) {
        guard var p = welfare?.find(id) else { return }
        p.delivered = true
        welfare?.update(p)
    }

    private func scheduleReplyRetry(_ id: String, retryAfter: Int?) {
        guard var p = welfare?.find(id) else { return }
        p.replyAttempts += 1
        p.nextReplyAtMs = now() + ReplyBackoff.delayMs(attempt: p.replyAttempts, retryAfterSeconds: retryAfter)
        welfare?.update(p)
    }

    /// Creates the `checkin_reply` envelope (tier normal) once. false when it could not be made (no location / key yet).
    private func sendReplyOverMesh(_ id: String, _ response: String) async -> Bool {
        await main { [self] in
            guard var p = welfare?.find(id) else { return false }
            if p.meshReplied { return true }
            let fix = sample()
            do {
                _ = try router.originateCheckinReply(checkinId: id, response: response, text: nil, lat: fix?.lat, lng: fix?.lng)
                p.meshReplied = true
                welfare?.update(p)
                log("Check-in reply sent over the mesh")
                return true
            } catch {
                if p.nextReplyAtMs <= now() { p.nextReplyAtMs = now() + 30_000; welfare?.update(p) }
                log("Check-in reply not sent over the mesh yet: \(error)")
                return false
            }
        }
    }
}
