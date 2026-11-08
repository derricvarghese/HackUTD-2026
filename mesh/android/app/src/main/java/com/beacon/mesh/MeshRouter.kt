package com.beacon.mesh

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.MeshSigner
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DeliveredReceipt
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.protocol.MeshProtocol
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.protocol.Priority
import com.beacon.mesh.protocol.Routing
import com.beacon.mesh.protocol.Uuid7
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.InboxItem
import com.beacon.mesh.store.MessageStore
import com.beacon.mesh.store.RemoteStatus
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.welfare.CheckinParser
import org.json.JSONObject
import java.util.Base64

/** Anything that can push mesh bytes (envelope / backend message / receipt JSON) to a connected peer. */
interface MeshTransport {
    fun send(envelopeJson: ByteArray, peer: String)
}

sealed class ReceiveOutcome {
    data class Accepted(val forwardedTo: Int, val uploaded: Boolean) : ReceiveOutcome()
    data class Dropped(val reason: DropReason) : ReceiveOutcome()
}

/** Why a message could not be created. Nothing is ever sent in clear as a fallback. */
enum class SendError { NO_BACKEND_KEY, NO_LOCATION, ENCRYPTION_FAILED }

class SendException(val error: SendError) : Exception(error.name)

/**
 * Platform-independent relay logic for contract (v2) messages. Mirrors iOS `MeshRouter.swift` once iOS is migrated.
 * Not thread-safe: call it from one thread (the app uses the main looper).
 */
class MeshRouter(
    private val signer: MeshSigner,
    private val store: MessageStore,
    private val config: BackendConfig,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** Both follow the signer, so a device identity reset (new key) changes them at once. */
    val relayId: String get() = MeshCrypto.relayId(signer.publicKeyDer)
    val ownPublicKey: String get() = b64(signer.publicKeyDer)
    var transport: MeshTransport? = null
    /** True when this phone can reach the backend (gateway mode). */
    var isOnline: () -> Boolean = { false }
    /**
     * `MeshPayload.profile_summary` for own sos/safe messages (name, age range, coarse flags, last acked profile_version), or null
     * when the user has no profile. This is the ONLY profile data that may enter a mesh message.
     */
    var profileSummary: () -> JSONObject? = { null }
    /** Called with each own/received message that should go to the backend (the gateway decides how). */
    var upload: (StoredMessage) -> Unit = {}
    var onChange: () -> Unit = {}
    /**
     * A verified `checkin_request` addressed to one of our SOS. The node routes it to the welfare manager (notification);
     * without a sink it is only stored (JVM tests).
     */
    var checkinSink: ((CheckinPrompt) -> Unit)? = null
    /** The backend says one of our SOS is resolved (status_update / polled status): cancel its welfare check-ins. */
    var onSosResolved: (String) -> Unit = {}
    var log: (String) -> Unit = {}

    private val peers = LinkedHashSet<String>()
    val connectedPeers: List<String> get() = peers.toList()

    /** Device id -> public key, learned from envelopes that carry both (lets later key-less copies be verified). */
    private val knownKeys = HashMap<String, String>()

    val messages: List<StoredMessage> get() = store.all()
    val checkinPrompts: List<CheckinPrompt> get() = store.prompts()
    /** Backend messages / receipts currently held for relaying. */
    val heldBackendItems: Int get() = store.inbox().size

    // ---- Originate ----

    /** @param nonCriticalHopCap demo setting; lowers max_hops for every non-critical message (never raises it). */
    @Throws(SendException::class)
    fun originate(
        category: Category,
        text: String? = null,
        lat: Double? = null,
        lng: Double? = null,
        accuracy: Double? = null,
        people: Int? = null,
        nonCriticalHopCap: Int? = null,
        imageCount: Int? = null,
    ): StoredMessage {
        if (lat == null || lng == null) throw SendException(SendError.NO_LOCATION)
        val payload = JSONObject().apply {
            put("lat", lat); put("lng", lng)
            accuracy?.let { put("accuracy_m", it) }
            put("category", category.apiCategory)
            text?.let { put("text", it) }
            people?.let { if (it >= 1) put("people_count", it) }
            if (category == Category.TRAPPED) put("trapped", true)
            if (category == Category.INJURED || category == Category.MEDICAL) put("injured", true)
            if (category.kind == "sos" || category.kind == "safe") profileSummary()?.let { put("profile_summary", it) }
            if (imageCount != null && imageCount > 0) {
                put("image_count", imageCount.coerceIn(0, 50))
                put("has_images", true)
            }
        }
        val msg = create(
            kind = category.kind, tier = category.priority, apiCategory = category.apiCategory,
            payload = payload, routing = Routing.build(lat, lng, category.apiCategory), hopCap = nonCriticalHopCap,
        )
        log("SOS ${short(msg.id)} created: ${msg.envelope.tier}, max_hops ${msg.envelope.maxHops}")
        dispatchOwn(msg)
        return msg
    }

    /** Answer a welfare check-in over the mesh (`kind=checkin_reply`, tier normal, `payload.response` = the CheckinResponse value). */
    @Throws(SendException::class)
    fun originateCheckinReply(prompt: CheckinPrompt, response: String, text: String? = null, nonCriticalHopCap: Int? = null): StoredMessage {
        val sos = store.all().firstOrNull { it.id == prompt.sosId && it.ownPayload != null }
        val p = sos?.ownPayload?.let { JSONObject(it) }
        val lat = p?.optDouble("lat", Double.NaN) ?: Double.NaN
        val lng = p?.optDouble("lng", Double.NaN) ?: Double.NaN
        if (lat.isNaN() || lng.isNaN()) throw SendException(SendError.NO_LOCATION)
        val payload = JSONObject().put("checkin_id", prompt.checkinId).put("response", response)
        text?.let { payload.put("text", it) }
        val msg = create("checkin_reply", Priority.NORMAL, null, payload, Routing.build(lat, lng, null), nonCriticalHopCap)
        if (store.prompts().firstOrNull { it.checkinId == prompt.checkinId }?.response == null) store.answerPrompt(prompt.checkinId, response)
        log("CHECKIN reply ${short(msg.id)} ($response)")
        dispatchOwn(msg)
        return msg
    }

    /** Heartbeat envelope (tier heartbeat: 2 hops, 30 min). [payload] is `{heartbeat:{sent_at, approx, ...}}`. */
    @Throws(SendException::class)
    fun originateHeartbeat(payload: JSONObject, approxLat: Double, approxLng: Double): StoredMessage {
        val routing = JSONObject().put(
            "approx", JSONObject().put("lat", approxLat).put("lng", approxLng).put("radius_m", 1000)
        )
        val msg = create("heartbeat", Priority.HEARTBEAT, null, payload, routing, null)
        log("HEARTBEAT ${short(msg.id)} via mesh")
        dispatchOwn(msg, quiet = true)
        return msg
    }

    /** Builds, encrypts, signs and stores one envelope. Fails closed: no backend key means no message. */
    private fun create(kind: String, tier: Priority, apiCategory: String?, payload: JSONObject, routing: JSONObject, hopCap: Int?): StoredMessage {
        val backendKey = config.encryptionKey ?: throw SendException(SendError.NO_BACKEND_KEY)
        val plain = payload.toString()
        val cipher = try {
            Ecies.encrypt(plain.toByteArray(Charsets.UTF_8), Base64.getDecoder().decode(backendKey))
        } catch (e: Exception) {
            throw SendException(SendError.ENCRYPTION_FAILED)
        }
        val limits = config.hopLimits
        var maxHops = limits.maxHops(tier)
        if (hopCap != null && tier != Priority.CRITICAL && tier != Priority.HEARTBEAT) {
            maxHops = minOf(maxHops, hopCap.coerceIn(1, MeshProtocol.HARD_MAX_HOPS))
        }
        val created = now()
        val unsigned = MeshEnvelope(
            id = Uuid7.generate(created),
            senderKeyId = config.deviceId ?: ownPublicKey,
            // Always carried (the contract only requires it for unregistered devices) so that relays, which do not
            // know the device id, can verify the signature. The server ignores it for registered devices.
            senderPublicKey = ownPublicKey,
            kind = kind, tier = tier.wire, maxHops = maxHops, hopCount = 0, hopPath = emptyList(),
            expiresAt = Iso.format(created + limits.ttlMs(tier)), createdAt = Iso.format(created),
            routing = routing, payload = b64(cipher), signature = "",
        )
        val env = unsigned.copy(signature = b64(signer.sign(unsigned.signedPart().toByteArray(Charsets.UTF_8))))
        val msg = StoredMessage(env.id, env, created, uploaded = false, isOwn = true, fromPeer = null, ownPayload = plain)
        store.save(msg)
        return msg
    }

    private fun dispatchOwn(msg: StoredMessage, quiet: Boolean = false) {
        if (isOnline()) {
            upload(msg)
        } else {
            val sent = peers.toList().count { sendForward(msg, it) }
            if (!quiet) log("${short(msg.id)} sent to $sent peer(s)")
        }
        onChange()
    }

    // ---- Receive ----

    fun receive(bytes: ByteArray, fromPeer: String): ReceiveOutcome {
        val o = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (e: Exception) { return drop(DropReason.MALFORMED, "?", fromPeer) }
        return when {
            o.has("sender_key_id") -> receiveEnvelope(MeshEnvelope.fromJson(o), fromPeer)
            o.has("delivered_at") -> receiveReceipt(DeliveredReceipt.fromJson(o), fromPeer)
            o.has("sos_id") -> receiveBackend(BackendMessage.fromJson(o), fromPeer)
            else -> drop(DropReason.MALFORMED, "?", fromPeer)
        }
    }

    private fun receiveEnvelope(env: MeshEnvelope?, fromPeer: String): ReceiveOutcome {
        if (env == null) return drop(DropReason.MALFORMED, "?", fromPeer)
        if (store.contains(env.id)) return ReceiveOutcome.Dropped(DropReason.DUPLICATE)
        val check = MeshValidation.validate(env, now(), knownKeys)
        check.drop?.let { return drop(it, env.id, fromPeer) }
        if (env.senderPublicKey != null && MeshValidation.isUuid(env.senderKeyId) && check.verified) {
            knownKeys[env.senderKeyId] = env.senderPublicKey
        }

        val msg = StoredMessage(env.id, env, now(), uploaded = false, isOwn = false, fromPeer = fromPeer, verified = check.verified)
        store.save(msg)
        if (env.kind != "heartbeat") log("RX ${short(env.id)} hop ${env.hopCount}/${env.maxHops} via ${env.hopPath.joinToString("→")}")

        if (isOnline()) {
            upload(msg)
            onChange()
            return ReceiveOutcome.Accepted(forwardedTo = 0, uploaded = true)
        }

        var forwarded = 0
        if (msg.canForward) {
            forwarded = peers.toList().count { it != fromPeer && sendForward(msg, it) }
            if (env.kind != "heartbeat") log("FWD ${short(env.id)} → $forwarded peer(s) as hop ${env.hopCount + 1}")
        } else if (env.kind != "heartbeat") {
            log("HOLD ${short(env.id)}: hop limit ${env.maxHops} reached, stored only")
        }
        onChange()
        return ReceiveOutcome.Accepted(forwardedTo = forwarded, uploaded = false)
    }

    private fun receiveBackend(bm: BackendMessage?, fromPeer: String): ReceiveOutcome {
        if (bm == null) return drop(DropReason.MALFORMED, "?", fromPeer)
        val key = "bm:${bm.id}"
        if (store.containsInbox(key)) return ReceiveOutcome.Dropped(DropReason.DUPLICATE)
        MeshValidation.validateHops(bm.maxHops, bm.hopCount, bm.hopPath, bm.expiresAtMs, now())?.let { return drop(it, bm.id, fromPeer) }
        return acceptBackendItem(key, "bm", bm.toJson(), bm.expiresAtMs, fromPeer, bm.signedPart(), bm.signature) { act(bm) }
    }

    private fun receiveReceipt(r: DeliveredReceipt?, fromPeer: String): ReceiveOutcome {
        if (r == null) return drop(DropReason.MALFORMED, "?", fromPeer)
        val key = "rcpt:${r.id}"
        if (store.containsInbox(key)) return ReceiveOutcome.Dropped(DropReason.DUPLICATE)
        MeshValidation.validateHops(r.maxHops, r.hopCount, r.hopPath, null, now())?.let { return drop(it, r.id, fromPeer) }
        return acceptBackendItem(key, "rcpt", r.toJson(), now() + MeshProtocol.BACKEND_TTL_MS, fromPeer, r.signedPart(), r.signature) { actReceipt(r) }
    }

    /**
     * Shared path for backend-signed items. Bad signature (key known): drop. No key: keep and forward, but do not act
     * until a key is available ([reevaluateInbox]). Backend items are downlink traffic, so even a gateway forwards them.
     */
    private fun acceptBackendItem(
        key: String, type: String, json: JSONObject, expiresAt: Long, fromPeer: String?,
        signed: String, signature: String, act: () -> Unit,
    ): ReceiveOutcome {
        val signKey = config.signingKey
        var acted = false
        if (signKey != null) {
            if (!MeshCrypto.verifyB64(signKey, signed, signature)) return drop(DropReason.BAD_SIGNATURE, key.substringAfter(':'), fromPeer ?: "local")
            act()
            acted = true
        } else {
            log("BACKEND ${short(key.substringAfter(':'))}: no signing key yet, relaying without acting")
        }
        val item = InboxItem(key, type, json.toString(), now(), expiresAt, acted)
        store.saveInbox(item)
        var forwarded = 0
        if (item.canForward) forwarded = peers.toList().count { it != fromPeer && sendInbox(item, it) }
        onChange()
        return ReceiveOutcome.Accepted(forwardedTo = forwarded, uploaded = false)
    }

    /** Gateway: inject a backend message / receipt from GET /mesh/outbox or a batch response into this phone and the mesh. */
    fun injectBackend(bm: BackendMessage): ReceiveOutcome? {
        if (store.containsInbox("bm:${bm.id}")) return null
        if (bm.expiresAtMs <= now() || bm.hopCount >= bm.maxHops) return null
        return acceptBackendItem("bm:${bm.id}", "bm", bm.toJson(), bm.expiresAtMs, null, bm.signedPart(), bm.signature) { act(bm) }
    }

    fun injectReceipt(r: DeliveredReceipt): ReceiveOutcome? {
        if (store.containsInbox("rcpt:${r.id}") || r.hopCount >= r.maxHops) return null
        return acceptBackendItem("rcpt:${r.id}", "rcpt", r.toJson(), now() + MeshProtocol.BACKEND_TTL_MS, null, r.signedPart(), r.signature) { actReceipt(r) }
    }

    /** Re-check backend items that arrived before a signing key was available (call after /server-info updates keys). */
    fun reevaluateInbox() {
        val signKey = config.signingKey ?: return
        for (item in store.inbox().filter { !it.acted }) {
            val o = JSONObject(item.json)
            when (item.type) {
                "bm" -> BackendMessage.fromJson(o)?.let { bm ->
                    if (MeshCrypto.verifyB64(signKey, bm.signedPart(), bm.signature)) act(bm)
                }
                "rcpt" -> DeliveredReceipt.fromJson(o)?.let { r ->
                    if (MeshCrypto.verifyB64(signKey, r.signedPart(), r.signature)) actReceipt(r)
                }
            }
            store.markInboxActed(item.key)
        }
        onChange()
    }

    // ---- Acting on verified backend messages ----

    private fun ownMessage(sosId: String) = store.all().firstOrNull { it.id == sosId && it.isOwn }

    private fun act(bm: BackendMessage) {
        val mine = ownMessage(bm.sosId) ?: return // not addressed to this phone: relay only
        val at = Iso.parse(bm.createdAt) ?: now()
        when (bm.kind) {
            "delivered" -> {
                store.markUploaded(mine.id)
                applyRemote(mine, RemoteStatus(bm.body.optStringOrNull("status") ?: "reported", true, null, bm.body.optStringOrNull("message"), at))
                log("Reached responders: ${short(mine.id)}")
            }
            "status_update" -> {
                store.markUploaded(mine.id)
                applyRemote(
                    mine,
                    RemoteStatus(bm.body.optStringOrNull("status"), true, if (bm.body.isNull("eta_minutes")) null else bm.body.optInt("eta_minutes"), bm.body.optStringOrNull("message"), at),
                )
                log("Status update ${short(mine.id)}: ${bm.body.optStringOrNull("status")}")
            }
            "checkin_request" -> {
                val prompt = CheckinParser.fromBackend(bm, now()) ?: return
                val sink = checkinSink
                if (sink != null) sink(prompt)
                else if (prompt.isPending(now()) && store.prompts().none { it.checkinId == prompt.checkinId }) store.savePrompt(prompt)
                log("Check-in requested for ${short(mine.id)}")
            }
        }
        if (bm.kind == "status_update" && bm.body.optStringOrNull("status") in RESOLVED_STATUSES) onSosResolved(mine.id)
    }

    private fun actReceipt(r: DeliveredReceipt) {
        val mine = ownMessage(r.id) ?: return
        store.markUploaded(mine.id)
        val at = Iso.parse(r.deliveredAt) ?: now()
        if (mine.remote == null) applyRemote(mine, RemoteStatus("reported", true, null, null, at))
        log("Receipt: ${short(mine.id)} reached responders")
    }

    private fun applyRemote(mine: StoredMessage, s: RemoteStatus) {
        val cur = mine.remote
        if (cur != null && s.updatedAtMs < cur.updatedAtMs) return // stale
        store.updateRemote(mine.id, s)
    }

    /** From GET /sos/{id}/status polling. */
    fun applyPolledStatus(id: String, s: RemoteStatus) {
        ownMessage(id)?.let { applyRemote(it, s); if (s.reachedResponders) store.markUploaded(id) }
        if (s.status in RESOLVED_STATUSES && ownMessage(id) != null) onSosResolved(id)
        onChange()
    }

    /** The person answered "I no longer need help": show the case as resolved at once (the server confirms later). */
    fun markResolvedLocally(sosId: String, message: String) {
        val mine = ownMessage(sosId) ?: return
        store.updateRemote(mine.id, RemoteStatus("resolved", mine.remote?.reachedResponders ?: false, null, message, now()))
        onChange()
    }

    /** The BLE identity changed: forget the links of the old one. */
    fun clearPeers() {
        peers.clear()
        onChange()
    }

    fun markCheckinAnswered(checkinId: String, response: String) {
        store.answerPrompt(checkinId, response)
        onChange()
    }

    // ---- Links / connectivity ----

    fun peerConnected(peer: String) {
        peers.add(peer)
        onChange()
        if (isOnline()) return
        val t = now()
        var sent = 0
        // Backend downlink first (small, high value), then SOS by priority.
        store.inbox().filter { it.expiresAt > t && it.canForward }.forEach { if (sendInbox(it, peer)) sent++ }
        store.all()
            .filter { it.canForward && it.expiresAtMs > t }
            .sortedBy { it.envelope.priority?.rank ?: 9 }
            .forEach { if (sendForward(it, peer)) sent++ }
        if (sent > 0) log("Store-and-forward: sent $sent held message(s) to new peer")
    }

    fun peerDisconnected(peer: String) {
        peers.remove(peer)
        onChange()
    }

    /** Held messages the gateway should still upload. */
    fun pendingUploads(): List<StoredMessage> {
        val t = now()
        return store.all().filter { !it.uploaded && it.rejectReason == null && it.expiresAtMs > t }
    }

    /** Call when the phone gains internet: become a gateway and flush everything held. */
    fun internetBecameAvailable() {
        val pending = pendingUploads()
        if (pending.isNotEmpty()) log("Gateway online: uploading ${pending.size} message(s)")
        pending.forEach(upload)
    }

    fun markUploaded(id: String) {
        store.markUploaded(id)
        onChange()
    }

    fun markRejected(id: String, reason: String) {
        store.markRejected(id, reason)
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
        return safeSend(t, msg.envelope.forwarded(relayId).toBytes(), peer)
    }

    private fun sendInbox(item: InboxItem, peer: String): Boolean {
        val t = transport ?: return false
        val o = JSONObject(item.json)
        val fwd = when (item.type) {
            "bm" -> BackendMessage.fromJson(o)?.takeIf { it.canForward }?.forwarded(relayId)?.toJson()
            else -> DeliveredReceipt.fromJson(o)?.takeIf { it.canForward }?.forwarded(relayId)?.toJson()
        } ?: return false
        return safeSend(t, fwd.toString().toByteArray(Charsets.UTF_8), peer)
    }

    /** A transport refusing a frame (e.g. envelope too large for the negotiated MTU) must never crash the relay. */
    private fun safeSend(t: MeshTransport, bytes: ByteArray, peer: String): Boolean = try {
        t.send(bytes, peer); true
    } catch (e: IllegalArgumentException) {
        log("TX to ${peer.take(8)} skipped: ${e.message}"); false
    }

    private fun drop(reason: DropReason, id: String, peer: String?): ReceiveOutcome {
        log("DROP ${short(id)} from ${peer?.take(8) ?: "?"}: ${reason.name.lowercase()}")
        return ReceiveOutcome.Dropped(reason)
    }

    private fun short(id: String) = id.take(8)
    private companion object { val RESOLVED_STATUSES = setOf("resolved", "closed") }
    private fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)

    private fun JSONObject.optStringOrNull(k: String): String? = if (has(k) && !isNull(k)) getString(k) else null
}
