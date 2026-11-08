import Foundation

/// Anything that can push frame payload bytes to a connected peer (BLE in the app, a fake in tests).
public protocol MeshTransport: AnyObject {
    func send(_ json: Data, to peer: String)
}

public enum ReceiveOutcome: Equatable {
    case accepted(forwardedTo: Int, uploaded: Bool)
    case dropped(DropReason)
}

public enum MeshError: Error, Equatable {
    /// No backend encryption key (cached or built in). Messages are never sent in plaintext, so nothing is created.
    case noBackendKey
    /// Contract payloads need coordinates (`MeshPayload.lat/lng`, `routing.approx`).
    case noLocation
    case encryptionFailed
    case signingFailed
}

/// Platform-independent relay logic for the contract wire format (MeshEnvelope, BackendMessage, DeliveredReceipt).
/// Not thread-safe: drive it from one queue (the app uses the main queue).
public final class MeshRouter {
    public let relayId: String
    public weak var transport: MeshTransport?
    /// True when this phone can reach the backend (gateway mode).
    public var isOnline: () -> Bool
    /// Called with each message that should go to the backend.
    public var upload: (StoredMessage) -> Void
    public var onChange: (() -> Void)?
    public var log: (String) -> Void = { _ in }
    /// A check-in request addressed to one of our SOS arrived (mesh or injected). The UI should prompt the user.
    public var onCheckinRequest: ((StoredBackend) -> Void)?
    /// A status update / delivered notice for one of our SOS was applied.
    public var onStatusApplied: ((StoredMessage) -> Void)?
    /// Identity hint for new sos/safe envelopes (`MeshPayload.profile_summary`); nil = none. Never logged.
    public var profileSummary: () -> JSONValue? = { nil }

    public private(set) var connectedPeers: [String] = []

    private let signer: MeshSigner
    private let store: MessageStore
    public let config: BackendConfig
    private let now: () -> Int64

    public init(signer: MeshSigner,
                store: MessageStore,
                config: BackendConfig,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                isOnline: @escaping () -> Bool = { false },
                upload: @escaping (StoredMessage) -> Void = { _ in }) {
        self.signer = signer
        self.store = store
        self.config = config
        self.now = now
        self.isOnline = isOnline
        self.upload = upload
        self.relayId = MeshCrypto.relayId(publicKeyDER: signer.publicKeyDER)
    }

    public var messages: [StoredMessage] { store.all() }
    public var backendItems: [StoredBackend] { store.allBackend() }
    public var senderPublicKey: String { signer.publicKeyBase64 }

    /// Messages that still need uploading: not uploaded, not permanently rejected, not expired.
    public var pendingUploads: [StoredMessage] {
        let t = now()
        return store.all().filter { !$0.uploaded && $0.rejectedReason == nil && $0.expiresAtMs > t }
    }

    /// Check-in requests addressed to us that are still open.
    public var pendingCheckins: [StoredBackend] {
        let t = now()
        return store.allBackend().filter {
            guard case .message(let m) = $0.payload else { return false }
            return m.kind == "checkin_request" && $0.addressedToMe && $0.verified && !$0.answered && $0.expiresAtMs > t
        }
    }

    // MARK: Originate

    /// Creates, encrypts, signs, stores and sends a new SOS / safe message.
    /// - Parameter nonCriticalHopCap: demo setting; lowers max_hops for every non-critical message (the server allows
    ///   anything from 1 up to the tier cap).
    @discardableResult
    public func originate(category: Category, text: String? = nil, lat: Double?, lng: Double?, accuracy: Double? = nil,
                          people: Int? = nil, nonCriticalHopCap: Int? = nil) throws -> StoredMessage {
        guard let lat, let lng else { throw MeshError.noLocation }
        let payload = MeshPayload.sos(category: category, text: text, lat: lat, lng: lng, accuracy: accuracy, people: people,
                                      profileSummary: profileSummary())
        let own = OwnInfo(category: category.rawValue, text: text, people: people, lat: lat, lng: lng, accuracy: accuracy)
        let msg = try build(kind: category.kind, tier: category.tier, payload: payload,
                            routing: Routing.build(lat: lat, lng: lng, category: category.apiCategory),
                            hopCap: category.tier == .critical ? nil : nonCriticalHopCap, own: own)
        dispatchNew(msg, label: "SOS")
        return msg
    }

    /// Reply to a check-in request over the mesh (`kind=checkin_reply`, normal tier). `response`: ok | need_help | other.
    @discardableResult
    public func originateCheckinReply(checkinId: String, response: String, text: String? = nil, lat: Double?, lng: Double?,
                                      nonCriticalHopCap: Int? = nil) throws -> StoredMessage {
        guard let lat, let lng else { throw MeshError.noLocation }
        let payload = MeshPayload.checkinReply(checkinId: checkinId, response: response, text: text)
        let msg = try build(kind: .checkinReply, tier: .normal, payload: payload,
                            routing: Routing.build(lat: lat, lng: lng, category: nil), hopCap: nonCriticalHopCap,
                            own: OwnInfo(category: "checkin_reply", text: text))
        dispatchNew(msg, label: "Check-in reply")
        return msg
    }

    /// A liveness ping as a `kind=heartbeat` envelope (tier heartbeat, 2 hops, 30 min), for phones without internet.
    @discardableResult
    public func originateHeartbeat(lat: Double?, lng: Double?, batteryPct: Int?, charging: Bool?, moving: Bool?,
                                   seq: Int) throws -> StoredMessage {
        guard let lat, let lng else { throw MeshError.noLocation }
        let payload = MeshPayload.heartbeat(sentAtMs: now(), lat: lat, lng: lng, batteryPct: batteryPct, charging: charging,
                                            moving: moving, seq: seq)
        let msg = try build(kind: .heartbeat, tier: .heartbeat, payload: payload,
                            routing: Routing.build(lat: lat, lng: lng, category: nil), hopCap: nil,
                            own: OwnInfo(category: "heartbeat"))
        dispatchNew(msg, label: "Heartbeat")
        return msg
    }

    /// Encrypts `payload` to the backend key and signs the envelope. Throws `MeshError.noBackendKey` without a key.
    func build(kind: EnvelopeKind, tier: Tier, payload: JSONValue, routing: JSONValue, hopCap: Int?, own: OwnInfo?) throws -> StoredMessage {
        guard let encB64 = config.encryptionKey, let encDER = Data(base64Encoded: encB64) else { throw MeshError.noBackendKey }
        let limits = config.hopLimits
        var maxHops = limits.maxHops(tier)
        if let hopCap { maxHops = min(maxHops, min(max(hopCap, 1), MeshProtocol.hardMaxHops)) }
        let created = now()
        let id = Uuid7.generate(nowMs: created)
        let cipher: Data
        do { cipher = try Ecies.encrypt(payload.serializedData(), recipientSPKI: encDER) } catch { throw MeshError.encryptionFailed }
        let registered = config.deviceId
        let senderKeyId = registered ?? signer.publicKeyBase64
        let createdAt = Iso.format(created)
        let expiresAt = Iso.format(created + limits.ttlMs(tier))
        let payloadB64 = cipher.base64EncodedString()
        let signature: String
        do {
            let part = try MeshEnvelope.signedPart(id: id, senderKeyId: senderKeyId, kind: kind.rawValue, tier: tier.rawValue,
                                                   maxHops: maxHops, expiresAt: expiresAt, createdAt: createdAt,
                                                   routing: routing, payload: payloadB64)
            signature = try signer.signBase64(part)
        } catch { throw MeshError.signingFailed }
        // The public key always travels inline so that relays can verify the signature even for registered devices.
        let env = MeshEnvelope(id: id, senderKeyId: senderKeyId, senderPublicKey: signer.publicKeyBase64, kind: kind.rawValue,
                               tier: tier.rawValue, maxHops: maxHops, hopCount: 0, hopPath: [], expiresAt: expiresAt,
                               createdAt: createdAt, routing: routing, payload: payloadB64, signature: signature)
        let msg = StoredMessage(id: id, envelope: env, receivedAt: created, isOwn: true, own: own)
        store.save(msg)
        return msg
    }

    private func dispatchNew(_ msg: StoredMessage, label: String) {
        log("\(label) \(msg.id.prefix(8)) created: \(msg.envelope.tier), maxHops \(msg.envelope.maxHops)")
        if isOnline() {
            upload(msg)
        } else {
            let sent = connectedPeers.filter { sendForward(msg, to: $0) }.count
            store.update(msg.id) { $0.sentToPeers = sent }
            log("\(label) \(msg.id.prefix(8)) sent to \(sent) peer(s)")
        }
        onChange?()
    }

    // MARK: Receive

    @discardableResult
    public func receive(_ data: Data, from peer: String) -> ReceiveOutcome {
        guard let wire = MeshWire.decode(data) else { return drop(.malformed, id: "?", peer: peer) }
        switch wire {
        case .envelope(let env): return receiveEnvelope(env, from: peer)
        case .backendMessage(let m): return receiveBackendMessage(m, from: peer)
        case .receipt(let r): return receiveReceipt(r, from: peer)
        }
    }

    private func receiveEnvelope(_ env: MeshEnvelope, from peer: String) -> ReceiveOutcome {
        if store.contains(env.id) { return .dropped(.duplicate) }
        if let reason = MeshValidation.validate(env, limits: config.hopLimits, nowMs: now()) {
            return drop(reason, id: env.id, peer: peer)
        }
        let msg = StoredMessage(id: env.id, envelope: env, receivedAt: now(), isOwn: false, fromPeer: peer)
        store.save(msg)
        log("RX \(env.id.prefix(8)) hop \(env.hopCount)/\(env.maxHops) via \(env.hopPath.joined(separator: "→"))")

        if isOnline() {
            upload(msg)
            onChange?()
            return .accepted(forwardedTo: 0, uploaded: true)
        }

        var forwarded = 0
        if msg.canForward {
            forwarded = connectedPeers.filter { $0 != peer && sendForward(msg, to: $0) }.count
            log("FWD \(env.id.prefix(8)) → \(forwarded) peer(s) as hop \(env.hopCount + 1)")
        } else {
            log("HOLD \(env.id.prefix(8)): hop limit \(env.maxHops) reached, stored only")
        }
        onChange?()
        return .accepted(forwardedTo: forwarded, uploaded: false)
    }

    private func receiveBackendMessage(_ m: BackendMessage, from peer: String) -> ReceiveOutcome {
        if store.containsBackend(m.id) { return .dropped(.duplicate) }
        let t = now()
        guard Uuid7.isUUID(m.id), Uuid7.isUUID(m.sosId), Iso.parse(m.createdAt) != nil, m.expiresAtMs > 0 else {
            return drop(.malformed, id: m.id, peer: peer)
        }
        if t > m.expiresAtMs { return drop(.expired, id: m.id, peer: peer) }
        if let r = MeshValidation.hopsOk(hopCount: m.hopCount, maxHops: m.maxHops, pathCount: m.hopPath.count) {
            return drop(r, id: m.id, peer: peer)
        }
        guard let verified = verifyBackend(m) else { return drop(.badSignature, id: m.id, peer: peer) }
        let item = StoredBackend(id: m.id, payload: .message(m), receivedAt: t, expiresAtMs: m.expiresAtMs, verified: verified)
        return acceptBackend(item, from: peer)
    }

    private func receiveReceipt(_ r: DeliveredReceipt, from peer: String) -> ReceiveOutcome {
        let key = "receipt:" + r.id
        if store.containsBackend(key) { return .dropped(.duplicate) }
        let t = now()
        guard Uuid7.isUUID(r.id), Iso.parse(r.deliveredAt) != nil else { return drop(.malformed, id: r.id, peer: peer) }
        if let reason = MeshValidation.hopsOk(hopCount: r.hopCount, maxHops: r.maxHops, pathCount: r.hopPath.count) {
            return drop(reason, id: r.id, peer: peer)
        }
        guard let verified = verifyReceipt(r) else { return drop(.badSignature, id: r.id, peer: peer) }
        let item = StoredBackend(id: key, payload: .receipt(r), receivedAt: t, expiresAtMs: t + MeshProtocol.backendTtlMs, verified: verified)
        return acceptBackend(item, from: peer)
    }

    /// nil = bad signature (drop), false = no signing key known yet (relay, but never show), true = verified.
    private func verifyBackend(_ m: BackendMessage) -> Bool? {
        guard let key = config.signingKey else { return false }
        guard let part = try? m.signedPart(), MeshCrypto.verifyB64(publicKeySPKI: key, text: part, signature: m.signature) else { return nil }
        return true
    }

    private func verifyReceipt(_ r: DeliveredReceipt) -> Bool? {
        guard let key = config.signingKey else { return false }
        guard let part = try? r.signedPart(), MeshCrypto.verifyB64(publicKeySPKI: key, text: part, signature: r.signature) else { return nil }
        return true
    }

    private func acceptBackend(_ item0: StoredBackend, from peer: String?) -> ReceiveOutcome {
        var item = item0
        item.addressedToMe = item.verified && applyToOwn(item)
        store.saveBackend(item)
        log("RX backend \(item.id.prefix(8)) \(describe(item))\(item.addressedToMe ? " (for me)" : "")")
        var forwarded = 0
        if item.canForward {
            forwarded = connectedPeers.filter { $0 != peer && sendBackend(item, to: $0) }.count
        }
        onChange?()
        if item.addressedToMe, case .message(let m) = item.payload, m.kind == "checkin_request" { onCheckinRequest?(item) }
        return .accepted(forwardedTo: forwarded, uploaded: false)
    }

    /// Applies a verified backend item to one of our SOS. Returns true if it is addressed to us.
    private func applyToOwn(_ item: StoredBackend) -> Bool {
        guard let sos = store.all().first(where: { $0.id == item.sosId && $0.isOwn }) else { return false }
        switch item.payload {
        case .receipt:
            applyStatus(SosStatus(status: sos.serverStatus?.status ?? "reported", reachedResponders: true,
                                  etaMinutes: sos.serverStatus?.etaMinutes, message: sos.serverStatus?.message,
                                  updatedAtMs: sos.serverStatus?.updatedAtMs ?? now()), to: sos.id, keepNewer: true, markDelivered: true)
        case .message(let m):
            switch m.kind {
            case "delivered", "status_update":
                let b = m.body
                let st = SosStatus(status: b.optString("status") ?? (m.kind == "delivered" ? "reported" : sos.serverStatus?.status ?? "reported"),
                                   reachedResponders: true, etaMinutes: b["eta_minutes"]?.intValue,
                                   message: b.optString("message"), updatedAtMs: Iso.parse(m.createdAt) ?? now())
                applyStatus(st, to: sos.id, keepNewer: true, markDelivered: true)
            default: break   // checkin_request is surfaced through onCheckinRequest
            }
        }
        return true
    }

    /// Records a victim-facing status for an own SOS (from the mesh or from GET /sos/{id}/status).
    /// `keepNewer`: ignore a status older than what we already have.
    public func applyStatus(_ st: SosStatus, to sosId: String, keepNewer: Bool = true, markDelivered: Bool = false) {
        var applied = false
        store.update(sosId) { m in
            if keepNewer, let cur = m.serverStatus, cur.updatedAtMs > st.updatedAtMs, cur.status != "reported" { return }
            m.serverStatus = st
            if markDelivered && st.reachedResponders { m.uploaded = true }
            applied = true
        }
        if applied {
            if let m = store.all().first(where: { $0.id == sosId }) { onStatusApplied?(m) }
            onChange?()
        }
    }

    // MARK: Backend injection (gateway)

    /// A gateway hands messages it fetched from the backend (outbox / batch response) to the mesh: they are verified,
    /// stored, applied if addressed to us, and pushed to every connected peer. Returns the number newly accepted.
    @discardableResult
    public func inject(messages: [BackendMessage], receipts: [DeliveredReceipt]) -> Int {
        var accepted = 0
        let t = now()
        for m in messages where !store.containsBackend(m.id) {
            guard Uuid7.isUUID(m.id), m.expiresAtMs > t, let verified = verifyBackend(m) else { continue }
            let item = StoredBackend(id: m.id, payload: .message(m), receivedAt: t, expiresAtMs: m.expiresAtMs, verified: verified)
            if case .accepted = acceptBackend(item, from: nil) { accepted += 1 }
        }
        for r in receipts where !store.containsBackend("receipt:" + r.id) {
            guard Uuid7.isUUID(r.id), let verified = verifyReceipt(r) else { continue }
            let item = StoredBackend(id: "receipt:" + r.id, payload: .receipt(r), receivedAt: t,
                                     expiresAtMs: t + MeshProtocol.backendTtlMs, verified: verified)
            if case .accepted = acceptBackend(item, from: nil) { accepted += 1 }
        }
        if accepted > 0 { log("Injected \(accepted) backend message(s) into the mesh") }
        return accepted
    }

    /// Call after the signing key changed (fresh /server-info): items that were relayed unverified are checked again
    /// and acted upon if they now verify and concern one of our SOS. Items that fail verification are discarded.
    public func reverifyBackend() {
        var changed = false
        for item in store.allBackend() where !item.verified {
            let ok: Bool?
            switch item.payload {
            case .message(let m): ok = verifyBackend(m)
            case .receipt(let r): ok = verifyReceipt(r)
            }
            guard let ok, ok else { continue }          // nil would be a bad signature: keep (it expires), never act
            var v = item
            v.verified = true
            v.addressedToMe = applyToOwn(v)
            store.updateBackend(item.id) { $0.verified = true; $0.addressedToMe = v.addressedToMe }
            changed = true
            if v.addressedToMe, case .message(let m) = v.payload, m.kind == "checkin_request" { onCheckinRequest?(v) }
        }
        if changed { onChange?() }
    }

    public func markCheckinAnswered(checkinId: String) {
        for item in store.allBackend() {
            if case .message(let m) = item.payload, m.checkinId == checkinId { store.updateBackend(item.id) { $0.answered = true } }
        }
        onChange?()
    }

    // MARK: Links / connectivity

    public func peerConnected(_ peer: String) {
        if !connectedPeers.contains(peer) { connectedPeers.append(peer) }
        onChange?()
        let t = now()
        // Backend messages and receipts are tiny and useful to everyone nearby, so they are pushed even when online.
        let held = store.allBackend().filter { $0.canForward && $0.expiresAtMs > t }
        let sentBackend = held.filter { sendBackend($0, to: peer) }.count
        if sentBackend > 0 { log("Store-and-forward: sent \(sentBackend) backend message(s) to new peer") }
        guard !isOnline() else { return }
        let pending = store.all()
            .filter { $0.canForward && $0.expiresAtMs > t }
            .sorted { ($0.tier.rank, $0.receivedAt) < ($1.tier.rank, $1.receivedAt) }
        let sent = pending.filter { sendForward($0, to: peer) }.count
        if sent > 0 { log("Store-and-forward: sent \(sent) held message(s) to new peer") }
    }

    public func peerDisconnected(_ peer: String) {
        connectedPeers.removeAll { $0 == peer }
        onChange?()
    }

    /// Call when the phone gains internet: become a gateway and flush everything held.
    public func internetBecameAvailable() {
        let pending = pendingUploads
        if !pending.isEmpty { log("Gateway online: uploading \(pending.count) message(s)") }
        pending.forEach(upload)
    }

    public func markUploaded(_ id: String) {
        store.update(id) { $0.uploaded = true; $0.rejectedReason = nil }
        onChange?()
    }

    /// The server rejected this envelope for a permanent reason; it will not be retried.
    public func markRejected(_ id: String, reason: String) {
        store.update(id) { $0.rejectedReason = reason }
        onChange?()
    }

    public func pruneExpired() {
        store.deleteExpired(nowMs: now())
        onChange?()
    }

    // MARK: Private

    private func sendForward(_ msg: StoredMessage, to peer: String) -> Bool {
        guard let transport, msg.canForward else { return false }
        transport.send(msg.envelope.forwarded(by: relayId).toBytes(), to: peer)
        return true
    }

    private func sendBackend(_ item: StoredBackend, to peer: String) -> Bool {
        guard let transport, item.canForward else { return false }
        transport.send(item.forwardedJSON(by: relayId), to: peer)
        return true
    }

    private func describe(_ item: StoredBackend) -> String {
        switch item.payload {
        case .message(let m): return m.kind
        case .receipt: return "receipt"
        }
    }

    private func drop(_ reason: DropReason, id: String, peer: String) -> ReceiveOutcome {
        log("DROP \(id.prefix(8)) from \(peer.prefix(8)): \(reason.rawValue)")
        return .dropped(reason)
    }
}
