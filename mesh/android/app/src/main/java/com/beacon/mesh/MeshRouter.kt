package com.beacon.mesh

import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.MeshSigner
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.Envelope
import com.beacon.mesh.protocol.MeshProtocol
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.protocol.Priority
import com.beacon.mesh.protocol.SignedHeader
import com.beacon.mesh.protocol.SosBody
import com.beacon.mesh.store.MessageStore
import com.beacon.mesh.store.StoredMessage
import java.util.Base64
import java.util.UUID

/** Anything that can push envelope bytes to a connected peer (BLE in the app, a fake in tests). */
interface MeshTransport {
    fun send(envelopeJson: ByteArray, peer: String)
}

sealed class ReceiveOutcome {
    data class Accepted(val forwardedTo: Int, val uploaded: Boolean) : ReceiveOutcome()
    data class Dropped(val reason: DropReason) : ReceiveOutcome()
}

/**
 * Platform-independent relay logic. Mirrors iOS `MeshRouter.swift`.
 * Not thread-safe: call it from one thread (the app uses the main looper).
 */
class MeshRouter(
    private val signer: MeshSigner,
    private val store: MessageStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    val relayId: String = MeshCrypto.relayId(signer.publicKeyDer)
    var transport: MeshTransport? = null
    /** True when this phone can reach the backend (gateway mode). */
    var isOnline: () -> Boolean = { false }
    /** Called with each message that should go to the backend. */
    var upload: (StoredMessage) -> Unit = {}
    var onChange: () -> Unit = {}
    var log: (String) -> Unit = {}

    private val peers = LinkedHashSet<String>()
    val connectedPeers: List<String> get() = peers.toList()

    val messages: List<StoredMessage> get() = store.all()

    // ---- Originate ----

    /** @param nonCriticalHopCap demo setting; replaces maxHops for every non-critical message. */
    fun originate(
        category: Category,
        text: String? = null,
        lat: Double? = null,
        lng: Double? = null,
        accuracy: Double? = null,
        people: Int? = null,
        nonCriticalHopCap: Int? = null,
    ): StoredMessage {
        val priority = category.priority
        var maxHops = priority.maxHops
        if (nonCriticalHopCap != null && priority != Priority.CRITICAL) {
            maxHops = nonCriticalHopCap.coerceIn(1, MeshProtocol.HARD_MAX_HOPS)
        }
        val created = now()
        val header = SignedHeader(
            v = MeshProtocol.VERSION,
            id = UUID.randomUUID().toString().lowercase(),
            pub = b64(signer.publicKeyDer),
            kind = category.kind,
            pri = priority.wire,
            maxHops = maxHops,
            createdAt = created,
            expiresAt = created + priority.ttlMs,
            body = SosBody(category.wire, text, lat, lng, accuracy, people),
        )
        val signedBytes = header.encoded()
        val env = Envelope(signed = b64(signedBytes), sig = b64(signer.sign(signedBytes)), hop = 0, path = emptyList())
        val msg = StoredMessage(header.id, env, header, created, uploaded = false, isOwn = true, fromPeer = null)
        store.save(msg)
        log("SOS ${short(header.id)} created: ${priority.wire}, maxHops $maxHops")

        if (isOnline()) {
            upload(msg)
        } else {
            val sent = peers.toList().count { sendForward(msg, it) }
            log("SOS ${short(header.id)} sent to $sent peer(s)")
        }
        onChange()
        return msg
    }

    // ---- Receive ----

    fun receive(envelopeJson: ByteArray, fromPeer: String): ReceiveOutcome {
        val env = Envelope.decode(envelopeJson)
        val signedBytes = env?.signedBytes
        val header = signedBytes?.let(SignedHeader::decode)
        if (env == null || signedBytes == null || header == null) return drop(DropReason.MALFORMED, "?", fromPeer)

        if (store.contains(header.id)) return ReceiveOutcome.Dropped(DropReason.DUPLICATE)
        MeshValidation.validate(env, header, signedBytes, now())?.let { return drop(it, header.id, fromPeer) }

        val msg = StoredMessage(header.id, env, header, now(), uploaded = false, isOwn = false, fromPeer = fromPeer)
        store.save(msg)
        log("RX ${short(header.id)} hop ${env.hop}/${header.maxHops} via ${env.path.joinToString("→")}")

        if (isOnline()) {
            upload(msg)
            onChange()
            return ReceiveOutcome.Accepted(forwardedTo = 0, uploaded = true)
        }

        var forwarded = 0
        if (msg.canForward) {
            forwarded = peers.toList().count { it != fromPeer && sendForward(msg, it) }
            log("FWD ${short(header.id)} → $forwarded peer(s) as hop ${env.hop + 1}")
        } else {
            log("HOLD ${short(header.id)}: hop limit ${header.maxHops} reached, stored only")
        }
        onChange()
        return ReceiveOutcome.Accepted(forwardedTo = forwarded, uploaded = false)
    }

    // ---- Links / connectivity ----

    fun peerConnected(peer: String) {
        peers.add(peer)
        onChange()
        if (isOnline()) return
        val t = now()
        val pending = store.all()
            .filter { it.canForward && it.header.expiresAt > t }
            .sortedBy { it.header.priority.rank }
        val sent = pending.count { sendForward(it, peer) }
        if (sent > 0) log("Store-and-forward: sent $sent held message(s) to new peer")
    }

    fun peerDisconnected(peer: String) {
        peers.remove(peer)
        onChange()
    }

    /** Call when the phone gains internet: become a gateway and flush everything held. */
    fun internetBecameAvailable() {
        val pending = store.all().filter { !it.uploaded }
        if (pending.isNotEmpty()) log("Gateway online: uploading ${pending.size} message(s)")
        pending.forEach(upload)
    }

    fun markUploaded(id: String) {
        store.markUploaded(id)
        onChange()
    }

    fun pruneExpired() {
        store.deleteExpired(now())
        onChange()
    }

    // ---- Private ----

    private fun sendForward(msg: StoredMessage, peer: String): Boolean {
        val t = transport ?: return false
        if (!msg.canForward) return false
        t.send(msg.envelope.forwarded(relayId).toBytes(), peer)
        return true
    }

    private fun drop(reason: DropReason, id: String, peer: String): ReceiveOutcome {
        log("DROP ${short(id)} from ${peer.take(8)}: ${reason.name.lowercase()}")
        return ReceiveOutcome.Dropped(reason)
    }

    private fun short(id: String) = id.take(8)
    private fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
}
