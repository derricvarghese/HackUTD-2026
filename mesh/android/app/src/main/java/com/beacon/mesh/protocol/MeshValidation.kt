package com.beacon.mesh.protocol

import com.beacon.mesh.crypto.MeshCrypto
import java.util.Base64

/**
 * What a relay can check about a [MeshEnvelope]: routing fields and the sender signature. The payload is encrypted
 * to the backend, so relays never see it.
 */
object MeshValidation {
    val KINDS = setOf("sos", "checkin_reply", "safe", "offer", "heartbeat")
    private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    const val MAX_PAYLOAD_CHARS = 16_000

    data class Result(val drop: DropReason?, /** false when no sender key was available (signature unchecked). */ val verified: Boolean)

    fun isUuid(s: String) = UUID_RE.matches(s)

    /** Public key a relay can use: the key carried in the envelope, a key-as-id, or a previously seen device id. */
    fun senderKey(env: MeshEnvelope, known: Map<String, String> = emptyMap()): String? =
        env.senderPublicKey ?: (if (!isUuid(env.senderKeyId)) env.senderKeyId else null) ?: known[env.senderKeyId]

    /** Everything except the duplicate check (which needs the store). */
    fun validate(env: MeshEnvelope, nowMs: Long, known: Map<String, String> = emptyMap(), requireHop: Boolean = true): Result {
        val tier = Priority.fromWire(env.tier)
        if (tier == null || env.kind !in KINDS || !isUuid(env.id)) return Result(DropReason.MALFORMED, false)
        if (env.payload.isEmpty() || env.payload.length > MAX_PAYLOAD_CHARS) return Result(DropReason.MALFORMED, false)
        val created = Iso.parse(env.createdAt)
        val expires = Iso.parse(env.expiresAt)
        if (created == null || expires == null) return Result(DropReason.MALFORMED, false)
        if ((env.kind == "heartbeat") != (tier == Priority.HEARTBEAT)) return Result(DropReason.LIMITS, false)
        if (env.maxHops < 1 || env.maxHops > MeshProtocol.HARD_MAX_HOPS) return Result(DropReason.LIMITS, false)
        val ttl = expires - created
        if (ttl <= 0 || ttl > MeshProtocol.HARD_MAX_TTL_MS + MeshProtocol.TTL_SKEW_MS) return Result(DropReason.LIMITS, false)
        if (created > nowMs + MeshProtocol.MAX_CLOCK_SKEW_MS) return Result(DropReason.LIMITS, false)

        var verified = false
        val key = senderKey(env, known)
        if (key != null) {
            if (!MeshCrypto.verifyB64(key, env.signedPart(), env.signature)) return Result(DropReason.BAD_SIGNATURE, false)
            verified = true
        } else {
            // sanity: a signature must at least be base64 DER-looking
            try { Base64.getDecoder().decode(env.signature) } catch (e: IllegalArgumentException) { return Result(DropReason.MALFORMED, false) }
        }
        if (nowMs > expires) return Result(DropReason.EXPIRED, verified)
        if (requireHop) {
            if (env.hopCount < 1 || env.hopCount > env.maxHops) return Result(DropReason.HOP_LIMIT, verified)
            if (env.hopCount != env.hopPath.size) return Result(DropReason.PATH_MISMATCH, verified)
        }
        return Result(null, verified)
    }

    /** Hop/expiry rules for BackendMessage and DeliveredReceipt (the signature is checked by the router). */
    fun validateHops(maxHops: Int, hopCount: Int, hopPath: List<String>, expiresAtMs: Long?, nowMs: Long): DropReason? {
        if (maxHops < 1 || maxHops > MeshProtocol.HARD_MAX_HOPS) return DropReason.LIMITS
        if (expiresAtMs != null && nowMs > expiresAtMs) return DropReason.EXPIRED
        if (hopCount < 1 || hopCount > maxHops) return DropReason.HOP_LIMIT
        if (hopCount != hopPath.size) return DropReason.PATH_MISMATCH
        return null
    }
}
