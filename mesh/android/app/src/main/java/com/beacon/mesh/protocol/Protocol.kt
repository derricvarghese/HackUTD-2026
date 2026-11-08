package com.beacon.mesh.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Constants shared with iOS. See mesh/PROTOCOL.md (v2, the Beacon API contract). */
object MeshProtocol {
    const val VERSION = 2
    val SERVICE_UUID: UUID = UUID.fromString("B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC")
    val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC")

    const val HARD_MAX_HOPS = 10
    const val HARD_MAX_TTL_MS = 24L * 3_600_000
    /** Relay-side tolerance for a creator's clock being ahead of ours. */
    const val MAX_CLOCK_SKEW_MS = 10L * 60_000
    /** Server tolerance on `expires_at - created_at` above the tier TTL. */
    const val TTL_SKEW_MS = 5L * 60_000

    /** Backend-originated messages (receipts, check-in requests, status updates). */
    const val BACKEND_MAX_HOPS = 5
    const val BACKEND_TTL_MS = 6L * 3_600_000
}

/** Tiers of the contract (`Tier`). Defaults mirror the hop table in openapi.yaml; /server-info may override them. */
enum class Priority(val wire: String, val maxHops: Int, val ttlMs: Long, val rank: Int) {
    CRITICAL("critical", 10, 24L * 3_600_000, 0),
    HIGH("high", 7, 12L * 3_600_000, 1),
    NORMAL("normal", 5, 6L * 3_600_000, 2),
    SAFE("safe", 3, 3L * 3_600_000, 3),
    HEARTBEAT("heartbeat", 2, 30L * 60_000, 4);

    companion object {
        fun fromWire(s: String): Priority? = entries.firstOrNull { it.wire == s }
    }
}

/** Hop table in force on this phone: contract defaults, replaced by server-provided values once cached. */
class HopLimits(private val rows: Map<Priority, Pair<Int, Long>> = emptyMap()) {
    fun maxHops(p: Priority): Int = rows[p]?.first ?: p.maxHops
    fun ttlMs(p: Priority): Long = rows[p]?.second ?: p.ttlMs

    fun toJson(): JSONArray = JSONArray().also { a ->
        Priority.entries.forEach { p ->
            a.put(JSONObject().put("tier", p.wire).put("max_hops", maxHops(p)).put("ttl_seconds", ttlMs(p) / 1000))
        }
    }

    companion object {
        val DEFAULT = HopLimits()

        fun fromJson(a: JSONArray?): HopLimits {
            if (a == null) return DEFAULT
            val m = HashMap<Priority, Pair<Int, Long>>()
            for (i in 0 until a.length()) {
                val o = a.optJSONObject(i) ?: continue
                val p = Priority.fromWire(o.optString("tier")) ?: continue
                val hops = o.optInt("max_hops", 0)
                val ttl = o.optLong("ttl_seconds", 0)
                if (hops in 1..MeshProtocol.HARD_MAX_HOPS && ttl > 0) m[p] = hops to ttl * 1000
            }
            return HopLimits(m)
        }
    }
}

/**
 * What the user picks in the UI. [apiCategory] is the contract `Category`; [kind] the envelope kind.
 * `medical` is sent as `injured`, `water_meds` as `need_water_meds`. The un-prompted `checkin` (the "+" menu)
 * is a normal-tier `sos` with category `other` (a `checkin_reply` envelope needs a backend check-in id).
 */
enum class Category(val wire: String, val priority: Priority, val kind: String, val apiCategory: String) {
    TRAPPED("trapped", Priority.CRITICAL, "sos", "trapped"),
    INJURED("injured", Priority.CRITICAL, "sos", "injured"),
    MEDICAL("medical", Priority.CRITICAL, "sos", "injured"),
    WATER_MEDS("water_meds", Priority.HIGH, "sos", "need_water_meds"),
    CHECKIN("checkin", Priority.NORMAL, "sos", "other"),
    OTHER("other", Priority.NORMAL, "sos", "other"),
    SAFE("safe", Priority.SAFE, "safe", "safe"),
}

/** RFC 3339 UTC timestamps. Envelopes carry the exact strings that were signed, so never reformat a received one. */
object Iso {
    private val FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
    fun format(ms: Long): String = FMT.format(Instant.ofEpochMilli(ms))
    fun parse(s: String): Long? = try { OffsetDateTime.parse(s).toInstant().toEpochMilli() } catch (e: Exception) { null }
}

/** UUIDv7 (RFC 9562): 48-bit unix ms + random. Same layout as server/src/testing/uuid.ts. */
object Uuid7 {
    private val rnd = java.security.SecureRandom()
    fun generate(nowMs: Long = System.currentTimeMillis()): String {
        val b = ByteArray(16).also { rnd.nextBytes(it) }
        for (i in 0 until 6) b[i] = (nowMs shr (8 * (5 - i))).toByte()
        b[6] = ((b[6].toInt() and 0x0f) or 0x70).toByte()
        b[8] = ((b[8].toInt() and 0x3f) or 0x80).toByte()
        val h = b.joinToString("") { "%02x".format(it) }
        return "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}"
    }
}

private fun JSONObject.optStr(k: String): String? = if (has(k) && !isNull(k)) getString(k) else null
private fun JSONObject.strList(k: String): List<String> {
    val a = optJSONArray(k) ?: return emptyList()
    return (0 until a.length()).map { a.getString(it) }
}

/** The contract's `MeshEnvelope`. [routing] is kept as received (it is part of the signed bytes). */
data class MeshEnvelope(
    val id: String,
    val senderKeyId: String,
    val senderPublicKey: String?,
    val kind: String,
    val tier: String,
    val maxHops: Int,
    val hopCount: Int,
    val hopPath: List<String>,
    val expiresAt: String,
    val createdAt: String,
    val routing: JSONObject,
    /** Base64 ECIES ciphertext of the `MeshPayload` JSON. */
    val payload: String,
    /** Base64 DER ECDSA P-256 / SHA-256 signature over [signedPart]. */
    val signature: String,
) {
    val priority: Priority? get() = Priority.fromWire(tier)
    val expiresAtMs: Long get() = Iso.parse(expiresAt) ?: 0L
    val createdAtMs: Long get() = Iso.parse(createdAt) ?: 0L
    val category: String? get() = routing.optStr("category")
    val canForward: Boolean get() = hopCount < maxHops

    /** UTF-8 canonical JSON of {id, sender_key_id, kind, tier, max_hops, expires_at, created_at, routing, payload}. */
    fun signedPart(): String = Canonical.json(
        JSONObject()
            .put("id", id).put("sender_key_id", senderKeyId).put("kind", kind).put("tier", tier)
            .put("max_hops", maxHops).put("expires_at", expiresAt).put("created_at", createdAt)
            .put("routing", routing).put("payload", payload)
    )

    /** The copy a transmitter sends: hop_count + 1 and its own relay ID appended. */
    fun forwarded(relayId: String) = copy(hopCount = hopCount + 1, hopPath = hopPath + relayId)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("sender_key_id", senderKeyId)
        senderPublicKey?.let { put("sender_public_key", it) }
        put("kind", kind)
        put("tier", tier)
        put("max_hops", maxHops)
        put("hop_count", hopCount)
        put("hop_path", JSONArray(hopPath))
        put("expires_at", expiresAt)
        put("created_at", createdAt)
        put("routing", routing)
        put("payload", payload)
        put("signature", signature)
    }

    fun toBytes(): ByteArray = toJson().toString().toByteArray(Charsets.UTF_8)

    companion object {
        fun fromJson(o: JSONObject): MeshEnvelope? = try {
            MeshEnvelope(
                id = o.getString("id"),
                senderKeyId = o.getString("sender_key_id"),
                senderPublicKey = o.optStr("sender_public_key"),
                kind = o.getString("kind"),
                tier = o.getString("tier"),
                maxHops = o.getInt("max_hops"),
                hopCount = o.getInt("hop_count"),
                hopPath = o.strList("hop_path"),
                expiresAt = o.getString("expires_at"),
                createdAt = o.getString("created_at"),
                routing = o.getJSONObject("routing"),
                payload = o.getString("payload"),
                signature = o.getString("signature"),
            )
        } catch (e: Exception) {
            null
        }

        fun decode(bytes: ByteArray): MeshEnvelope? = try {
            fromJson(JSONObject(String(bytes, Charsets.UTF_8)))
        } catch (e: Exception) {
            null
        }
    }
}

/** Builds the `routing` block: approx = centre of the ~1 km grid cell (0.01 degree), radius 1000 m. */
object Routing {
    fun cell(v: Double): Double = Math.round((Math.floor(v * 100) / 100 + 0.005) * 1e5) / 1e5

    fun build(lat: Double, lng: Double, category: String?): JSONObject = JSONObject().apply {
        put("approx", JSONObject().put("lat", cell(lat)).put("lng", cell(lng)).put("radius_m", 1000))
        category?.let { put("category", it) }
    }
}

/** The contract's `BackendMessage`: delivered | checkin_request | status_update, signed by the backend. */
data class BackendMessage(
    val id: String,
    val kind: String,
    val sosId: String,
    val checkinId: String?,
    val body: JSONObject,
    val maxHops: Int,
    val hopCount: Int,
    val hopPath: List<String>,
    val expiresAt: String,
    val createdAt: String,
    val signature: String,
) {
    val expiresAtMs: Long get() = Iso.parse(expiresAt) ?: 0L
    val canForward: Boolean get() = hopCount < maxHops

    /** Canonical JSON of {id, kind, sos_id, checkin_id (null when absent), body, max_hops, expires_at, created_at}. */
    fun signedPart(): String = Canonical.json(
        JSONObject()
            .put("id", id).put("kind", kind).put("sos_id", sosId)
            .put("checkin_id", checkinId ?: JSONObject.NULL)
            .put("body", body).put("max_hops", maxHops).put("expires_at", expiresAt).put("created_at", createdAt)
    )

    fun forwarded(relayId: String) = copy(hopCount = hopCount + 1, hopPath = hopPath + relayId)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("kind", kind); put("sos_id", sosId)
        put("checkin_id", checkinId ?: JSONObject.NULL)
        put("body", body); put("max_hops", maxHops); put("hop_count", hopCount)
        put("hop_path", JSONArray(hopPath)); put("expires_at", expiresAt); put("created_at", createdAt)
        put("signature", signature)
    }

    companion object {
        val KINDS = setOf("delivered", "checkin_request", "status_update")

        fun fromJson(o: JSONObject): BackendMessage? = try {
            BackendMessage(
                id = o.getString("id"), kind = o.getString("kind"), sosId = o.getString("sos_id"),
                checkinId = o.optStr("checkin_id"), body = o.optJSONObject("body") ?: JSONObject(),
                maxHops = o.getInt("max_hops"), hopCount = o.optInt("hop_count", 0), hopPath = o.strList("hop_path"),
                expiresAt = o.getString("expires_at"), createdAt = o.getString("created_at"), signature = o.getString("signature"),
            ).takeIf { it.kind in KINDS }
        } catch (e: Exception) {
            null
        }
    }
}

/** The contract's `DeliveredReceipt`; travels the mesh like a backend message. TTL = 6 h from first sight. */
data class DeliveredReceipt(
    val id: String,
    val deliveredAt: String,
    val maxHops: Int,
    val hopCount: Int,
    val hopPath: List<String>,
    val signature: String,
) {
    val canForward: Boolean get() = hopCount < maxHops
    /** Canonical JSON of {id, delivered_at, max_hops: 5}. */
    fun signedPart(): String = Canonical.json(JSONObject().put("id", id).put("delivered_at", deliveredAt).put("max_hops", 5))
    fun forwarded(relayId: String) = copy(hopCount = hopCount + 1, hopPath = hopPath + relayId)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("delivered_at", deliveredAt); put("max_hops", maxHops); put("hop_count", hopCount)
        put("hop_path", JSONArray(hopPath)); put("signature", signature)
    }

    companion object {
        fun fromJson(o: JSONObject): DeliveredReceipt? = try {
            DeliveredReceipt(
                o.getString("id"), o.getString("delivered_at"), o.getInt("max_hops"), o.optInt("hop_count", 0),
                o.strList("hop_path"), o.getString("signature"),
            )
        } catch (e: Exception) {
            null
        }
    }
}

enum class DropReason { MALFORMED, DUPLICATE, BAD_SIGNATURE, EXPIRED, HOP_LIMIT, PATH_MISMATCH, LIMITS }
