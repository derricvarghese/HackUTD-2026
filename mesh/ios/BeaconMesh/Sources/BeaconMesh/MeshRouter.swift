import Foundation

/// Anything that can push envelope bytes to a connected peer (BLE in the app, a fake in tests).
public protocol MeshTransport: AnyObject {
    func send(_ envelopeJSON: Data, to peer: String)
}

public enum ReceiveOutcome: Equatable {
    case accepted(forwardedTo: Int, uploaded: Bool)
    case dropped(DropReason)
}

/// Platform-independent relay logic. Mirrors android `MeshRouter.kt` line for line.
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

    public private(set) var connectedPeers: [String] = []

    private let signer: MeshSigner
    private let store: MessageStore
    private let now: () -> Int64

    public init(signer: MeshSigner,
                store: MessageStore,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                isOnline: @escaping () -> Bool = { false },
                upload: @escaping (StoredMessage) -> Void = { _ in }) {
        self.signer = signer
        self.store = store
        self.now = now
        self.isOnline = isOnline
        self.upload = upload
        self.relayId = MeshCrypto.relayId(publicKeyDER: signer.publicKeyDER)
    }

    public var messages: [StoredMessage] { store.all() }

    // MARK: Originate

    /// Creates, signs, stores and sends a new message.
    /// - Parameter nonCriticalHopCap: demo setting; replaces maxHops for every non-critical message.
    @discardableResult
    public func originate(category: Category, text: String? = nil, lat: Double? = nil, lng: Double? = nil,
                          accuracy: Double? = nil, people: Int? = nil,
                          nonCriticalHopCap: Int? = nil) throws -> StoredMessage {
        let priority = category.priority
        var maxHops = priority.maxHops
        if let cap = nonCriticalHopCap, priority != .critical {
            maxHops = min(max(cap, 1), MeshProtocol.hardMaxHops)
        }
        let created = now()
        let header = SignedHeader(
            v: MeshProtocol.version,
            id: UUID().uuidString.lowercased(),
            pub: signer.publicKeyDER.base64EncodedString(),
            kind: category.kind.rawValue,
            pri: priority.rawValue,
            maxHops: maxHops,
            createdAt: created,
            expiresAt: created + priority.ttlMs,
            body: SosBody(category: category.rawValue, text: text, lat: lat, lng: lng, acc: accuracy, people: people)
        )
        let signedBytes = try header.encoded()
        let sig = try signer.sign(signedBytes)
        let env = Envelope(signed: signedBytes.base64EncodedString(), sig: sig.base64EncodedString(), hop: 0, path: [])
        let msg = StoredMessage(id: header.id, envelope: env, header: header, receivedAt: created,
                                uploaded: false, isOwn: true, fromPeer: nil)
        store.save(msg)
        log("SOS \(header.id.prefix(8)) created: \(priority.rawValue), maxHops \(maxHops)")

        if isOnline() {
            upload(msg)
        } else {
            let sent = connectedPeers.filter { sendForward(msg, to: $0) }.count
            log("SOS \(header.id.prefix(8)) sent to \(sent) peer(s)")
        }
        onChange?()
        return msg
    }

    // MARK: Receive

    @discardableResult
    public func receive(_ envelopeJSON: Data, from peer: String) -> ReceiveOutcome {
        guard let env = Envelope.decode(envelopeJSON), let signedBytes = env.signedBytes,
              let header = SignedHeader.decode(signedBytes)
        else { return drop(.malformed, id: "?", peer: peer) }

        if store.contains(header.id) { return .dropped(.duplicate) }
        if let reason = MeshValidation.validate(env, header: header, signedBytes: signedBytes, nowMs: now()) {
            return drop(reason, id: header.id, peer: peer)
        }

        let msg = StoredMessage(id: header.id, envelope: env, header: header, receivedAt: now(),
                                uploaded: false, isOwn: false, fromPeer: peer)
        store.save(msg)
        log("RX \(header.id.prefix(8)) hop \(env.hop)/\(header.maxHops) via \(env.path.joined(separator: "→"))")

        if isOnline() {
            upload(msg)
            onChange?()
            return .accepted(forwardedTo: 0, uploaded: true)
        }

        var forwarded = 0
        if msg.canForward {
            forwarded = connectedPeers.filter { $0 != peer && sendForward(msg, to: $0) }.count
            log("FWD \(header.id.prefix(8)) → \(forwarded) peer(s) as hop \(env.hop + 1)")
        } else {
            log("HOLD \(header.id.prefix(8)): hop limit \(header.maxHops) reached, stored only")
        }
        onChange?()
        return .accepted(forwardedTo: forwarded, uploaded: false)
    }

    // MARK: Links / connectivity

    public func peerConnected(_ peer: String) {
        if !connectedPeers.contains(peer) { connectedPeers.append(peer) }
        onChange?()
        guard !isOnline() else { return }
        let t = now()
        let pending = store.all()
            .filter { $0.canForward && $0.header.expiresAt > t }
            .sorted { $0.header.priority.rank < $1.header.priority.rank }
        let sent = pending.filter { sendForward($0, to: peer) }.count
        if sent > 0 { log("Store-and-forward: sent \(sent) held message(s) to new peer") }
    }

    public func peerDisconnected(_ peer: String) {
        connectedPeers.removeAll { $0 == peer }
        onChange?()
    }

    /// Call when the phone gains internet: become a gateway and flush everything held.
    public func internetBecameAvailable() {
        let pending = store.all().filter { !$0.uploaded }
        if !pending.isEmpty { log("Gateway online: uploading \(pending.count) message(s)") }
        pending.forEach(upload)
    }

    public func markUploaded(_ id: String) {
        store.markUploaded(id)
        onChange?()
    }

    public func pruneExpired() {
        store.deleteExpired(nowMs: now())
        onChange?()
    }

    // MARK: Private

    private func sendForward(_ msg: StoredMessage, to peer: String) -> Bool {
        guard let transport, msg.canForward, let data = try? msg.envelope.forwarded(by: relayId).jsonData()
        else { return false }
        transport.send(data, to: peer)
        return true
    }

    private func drop(_ reason: DropReason, id: String, peer: String) -> ReceiveOutcome {
        log("DROP \(id.prefix(8)) from \(peer.prefix(8)): \(reason.rawValue)")
        return .dropped(reason)
    }
}
