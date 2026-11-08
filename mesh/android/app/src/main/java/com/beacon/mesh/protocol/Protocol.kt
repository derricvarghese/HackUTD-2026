package com.beacon.mesh.protocol

import com.beacon.mesh.crypto.MeshCrypto
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** Constants shared with iOS. See mesh/PROTOCOL.md. */
object MeshProtocol {
    const val VERSION = 1
    val SERVICE_UUID: UUID = UUID.fromString("B5A10001-7E4C-4C3A-9D2F-6B8E1C0FBEAC")
    val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("B5A10002-7E4C-4C3A-9D2F-6B8E1C0FBEAC")

    const val HARD_MAX_HOPS = 10
    const val HARD_MAX_TTL_MS = 24L * 3_600_000
    const val MAX_CLOCK_SKEW_MS = 10L * 60_000
}

enum class Priority(val wire: String, val maxHops: Int, val ttlMs: Long, val rank: Int) {
    CRITICAL("critical", 10, 24L * 3_600_000, 0),
    HIGH("high", 7, 12L * 3_600_000, 1),
    NORMAL("normal", 5, 6L * 3_600_000, 2),
    SAFE("safe", 3, 3L * 3_600_000, 3);

    companion object {
        fun fromWire(s: String): Priority = entries.firstOrNull { it.wire == s } ?: NORMAL
    }
}

enum class Category(val wire: String, val priority: Priority, val kind: String) {
    TRAPPED("trapped", Priority.CRITICAL, "sos"),
    INJURED("injured", Priority.CRITICAL, "sos"),
    MEDICAL("medical", Priority.CRITICAL, "sos"),
    WATER_MEDS("water_meds", Priority.HIGH, "sos"),
    CHECKIN("checkin", Priority.NORMAL, "checkin"),
    OTHER("other", Priority.NORMAL, "sos"),
    SAFE("safe", Priority.SAFE, "safe"),
}

data class SosBody(
    val category: String,
    val text: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val acc: Double? = null,
    val people: Int? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("category", category)
        text?.let { put("text", it) }
        lat?.let { put("lat", it) }
        lng?.let { put("lng", it) }
        acc?.let { put("acc", it) }
        people?.let { put("people", it) }
    }

    companion object {
        fun fromJson(o: JSONObject) = SosBody(
            category = o.optString("category", "other"),
            text = if (o.has("text") && !o.isNull("text")) o.getString("text") else null,
            lat = if (o.has("lat") && !o.isNull("lat")) o.getDouble("lat") else null,
            lng = if (o.has("lng") && !o.isNull("lng")) o.getDouble("lng") else null,
            acc = if (o.has("acc") && !o.isNull("acc")) o.getDouble("acc") else null,
            people = if (o.has("people") && !o.isNull("people")) o.getInt("people") else null,
        )
    }
}

/** The part the sender signs. Serialised once; the bytes travel verbatim (base64). */
data class SignedHeader(
    val v: Int,
    val id: String,
    val pub: String,
    val kind: String,
    val pri: String,
    val maxHops: Int,
    val createdAt: Long,
    val expiresAt: Long,
    val body: SosBody?,
) {
    val priority: Priority get() = Priority.fromWire(pri)

    fun encoded(): ByteArray = JSONObject().apply {
        put("v", v)
        put("id", id)
        put("pub", pub)
        put("kind", kind)
        put("pri", pri)
        put("maxHops", maxHops)
        put("createdAt", createdAt)
        put("expiresAt", expiresAt)
        body?.let { put("body", it.toJson()) }
    }.toString().toByteArray(Charsets.UTF_8)

    companion object {
        fun decode(bytes: ByteArray): SignedHeader? = try {
            val o = JSONObject(String(bytes, Charsets.UTF_8))
            SignedHeader(
                v = o.getInt("v"),
                id = o.getString("id"),
                pub = o.getString("pub"),
                kind = o.getString("kind"),
                pri = o.getString("pri"),
                maxHops = o.getInt("maxHops"),
                createdAt = o.getLong("createdAt"),
                expiresAt = o.getLong("expiresAt"),
                body = o.optJSONObject("body")?.let(SosBody::fromJson),
            )
        } catch (e: Exception) {
            null
        }
    }
}

/** What goes over the air (after reassembly). */
data class Envelope(
    val v: Int = MeshProtocol.VERSION,
    /** base64 of the signed header bytes */
    val signed: String,
    /** base64 DER ECDSA P-256 / SHA-256 signature */
    val sig: String,
    /** radio transmissions so far (unsigned; relays increment) */
    val hop: Int,
    /** relay ID of each transmitter, origin first (unsigned) */
    val path: List<String>,
) {
    val signedBytes: ByteArray?
        get() = try { Base64.getDecoder().decode(signed) } catch (e: IllegalArgumentException) { null }

    val header: SignedHeader? get() = signedBytes?.let(SignedHeader::decode)

    /** The copy a transmitter sends: hop + 1 and its own relay ID appended. */
    fun forwarded(relayId: String) = copy(hop = hop + 1, path = path + relayId)

    fun toJson(): JSONObject = JSONObject().apply {
        put("v", v)
        put("signed", signed)
        put("sig", sig)
        put("hop", hop)
        put("path", JSONArray(path))
    }

    fun toBytes(): ByteArray = toJson().toString().toByteArray(Charsets.UTF_8)

    companion object {
        fun fromJson(o: JSONObject): Envelope? = try {
            val arr = o.getJSONArray("path")
            Envelope(
                v = o.getInt("v"),
                signed = o.getString("signed"),
                sig = o.getString("sig"),
                hop = o.getInt("hop"),
                path = (0 until arr.length()).map { arr.getString(it) },
            )
        } catch (e: Exception) {
            null
        }

        fun decode(bytes: ByteArray): Envelope? = try {
            fromJson(JSONObject(String(bytes, Charsets.UTF_8)))
        } catch (e: Exception) {
            null
        }
    }
}

enum class DropReason { MALFORMED, DUPLICATE, BAD_SIGNATURE, EXPIRED, HOP_LIMIT, PATH_MISMATCH, LIMITS }

object MeshValidation {
    /** Everything except the duplicate check (which needs the store). Mirrors iOS `MeshValidation`. */
    fun validate(env: Envelope, header: SignedHeader, signedBytes: ByteArray, nowMs: Long): DropReason? {
        if (env.v != MeshProtocol.VERSION || header.v != MeshProtocol.VERSION) return DropReason.MALFORMED
        val pub = try { Base64.getDecoder().decode(header.pub) } catch (e: IllegalArgumentException) { null }
        val sig = try { Base64.getDecoder().decode(env.sig) } catch (e: IllegalArgumentException) { null }
        if (pub == null || sig == null || !MeshCrypto.verify(pub, signedBytes, sig)) return DropReason.BAD_SIGNATURE
        if (nowMs > header.expiresAt) return DropReason.EXPIRED
        if (header.maxHops < 1 || header.maxHops > MeshProtocol.HARD_MAX_HOPS) return DropReason.LIMITS
        if (header.expiresAt - header.createdAt > MeshProtocol.HARD_MAX_TTL_MS) return DropReason.LIMITS
        if (header.createdAt > nowMs + MeshProtocol.MAX_CLOCK_SKEW_MS) return DropReason.LIMITS
        if (env.hop < 1 || env.hop > header.maxHops) return DropReason.HOP_LIMIT
        if (env.hop != env.path.size) return DropReason.PATH_MISMATCH
        return null
    }
}
