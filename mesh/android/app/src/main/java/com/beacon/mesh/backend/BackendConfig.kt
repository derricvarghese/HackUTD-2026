package com.beacon.mesh.backend

import android.content.SharedPreferences
import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.protocol.HopLimits
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/** Tiny persistence seam so the logic below runs in JVM tests without Android. */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String?)
    fun getLong(key: String, def: Long = 0L): Long
    fun putLong(key: String, value: Long)
}

class PrefsKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getString(key: String) = prefs.getString(key, null)
    override fun putString(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
    override fun getLong(key: String, def: Long) = prefs.getLong(key, def)
    override fun putLong(key: String, value: Long) { prefs.edit().putLong(key, value).apply() }
}

class MemoryKeyValueStore : KeyValueStore {
    private val m = HashMap<String, Any>()
    override fun getString(key: String) = m[key] as? String
    override fun putString(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
    override fun getLong(key: String, def: Long) = (m[key] as? Long) ?: def
    override fun putLong(key: String, value: Long) { m[key] = value }
}

enum class KeyStatus {
    /** No backend encryption key at all: the app refuses to create messages. */
    NONE,
    /** Using the key baked into the build (BuildConfig.BACKEND_ENC_PUBLIC_KEY). */
    BUILT_IN,
    /** Using the key cached from GET /v1/server-info. */
    CACHED,
}

/** Parsed `GET /v1/server-info`. */
data class ServerInfo(
    val serverTimeMs: Long?,
    val encryptionPublicKey: String?,
    val signingPublicKey: String?,
    val hopLimits: HopLimits,
    /** `event != null` in the response. */
    val eventActive: Boolean,
    val eventName: String?,
    val checkinIntervalSeconds: Int?,
    val heartbeatIntervalSeconds: Int?,
    val silenceThresholdSeconds: Int?,
    val gatewayUploadMaxBatch: Int?,
    /** `profile_required`; null when the server did not say. */
    val profileRequired: Boolean? = null,
    /** `profile_consent_version`: id of the consent text the app must have shown. */
    val profileConsentVersion: String? = null,
) {
    companion object {
        fun fromJson(o: JSONObject): ServerInfo = ServerInfo(
            serverTimeMs = com.beacon.mesh.protocol.Iso.parse(o.optString("server_time", "")),
            encryptionPublicKey = o.optString("encryption_public_key", "").ifBlank { null },
            signingPublicKey = o.optString("signing_public_key", "").ifBlank { null },
            hopLimits = HopLimits.fromJson(o.optJSONArray("hop_limits")),
            eventActive = o.has("event") && !o.isNull("event"),
            eventName = o.optJSONObject("event")?.optString("name")?.ifBlank { null },
            checkinIntervalSeconds = o.optInt("checkin_interval_seconds", 0).takeIf { it > 0 },
            heartbeatIntervalSeconds = o.optInt("heartbeat_interval_seconds", 0).takeIf { it > 0 },
            silenceThresholdSeconds = o.optInt("silence_threshold_seconds", 0).takeIf { it > 0 },
            gatewayUploadMaxBatch = o.optInt("gateway_upload_max_batch", 0).takeIf { it > 0 },
            profileRequired = if (o.has("profile_required") && !o.isNull("profile_required")) o.optBoolean("profile_required") else null,
            profileConsentVersion = o.optString("profile_consent_version", "").ifBlank { null },
        )
    }
}

/**
 * Everything the phone knows about the backend: keys (cached from /server-info, with a build-time fallback),
 * hop table, heartbeat settings, event state and its own device registration.
 */
class BackendConfig(
    private val kv: KeyValueStore,
    private val builtInEncKey: String = "",
    private val builtInSignKey: String = "",
) {
    private fun validKey(b64: String?): String? {
        if (b64.isNullOrBlank()) return null
        val der = try { Base64.getDecoder().decode(b64.trim()) } catch (e: IllegalArgumentException) { return null }
        return if (Ecies.isValidP256Spki(der)) b64.trim() else null
    }

    /** Base64 SPKI of the backend encryption key, or null when none is available. */
    val encryptionKey: String? get() = validKey(kv.getString(K_ENC)) ?: validKey(builtInEncKey)
    val signingKey: String? get() = validKey(kv.getString(K_SIGN)) ?: validKey(builtInSignKey)

    val encryptionKeyStatus: KeyStatus
        get() = when {
            validKey(kv.getString(K_ENC)) != null -> KeyStatus.CACHED
            validKey(builtInEncKey) != null -> KeyStatus.BUILT_IN
            else -> KeyStatus.NONE
        }
    val signingKeyStatus: KeyStatus
        get() = when {
            validKey(kv.getString(K_SIGN)) != null -> KeyStatus.CACHED
            validKey(builtInSignKey) != null -> KeyStatus.BUILT_IN
            else -> KeyStatus.NONE
        }

    val hopLimits: HopLimits
        get() = kv.getString(K_HOPS)?.let { try { HopLimits.fromJson(JSONArray(it)) } catch (e: Exception) { null } } ?: HopLimits.DEFAULT

    val heartbeatIntervalSeconds: Int get() = kv.getLong(K_HB_INT, DEFAULT_HEARTBEAT_S.toLong()).toInt()
    val silenceThresholdSeconds: Int get() = kv.getLong(K_SILENCE, 0).toInt()
    val maxBatch: Int get() = kv.getLong(K_BATCH, DEFAULT_BATCH.toLong()).toInt().coerceIn(1, 500)
    val eventActive: Boolean get() = kv.getLong(K_EVENT, 0) == 1L
    val lastInfoAtMs: Long get() = kv.getLong(K_INFO_AT, 0)

    var deviceId: String?
        get() = kv.getString(K_DEVICE_ID)
        set(v) = kv.putString(K_DEVICE_ID, v)

    var outboxCursor: String?
        get() = kv.getString(K_CURSOR)
        set(v) = kv.putString(K_CURSOR, v)

    /** Whether onboarding may skip the profile. Unknown (never reached the server) counts as required. */
    val profileRequired: Boolean get() = kv.getLong(K_PROFILE_REQUIRED, 1) != 0L
    /** Consent text version the server currently wants; null until a /server-info said so. */
    val profileConsentVersion: String? get() = kv.getString(K_PROFILE_CONSENT)

    fun setEventActive(active: Boolean) = kv.putLong(K_EVENT, if (active) 1 else 0)

    /** Stores a fresh /server-info. Garbage keys are ignored so a bad response cannot lock the phone out. */
    fun update(info: ServerInfo, nowMs: Long) {
        validKey(info.encryptionPublicKey)?.let { kv.putString(K_ENC, it) }
        validKey(info.signingPublicKey)?.let { kv.putString(K_SIGN, it) }
        kv.putString(K_HOPS, info.hopLimits.toJson().toString())
        info.heartbeatIntervalSeconds?.let { kv.putLong(K_HB_INT, it.toLong()) }
        info.silenceThresholdSeconds?.let { kv.putLong(K_SILENCE, it.toLong()) }
        info.gatewayUploadMaxBatch?.let { kv.putLong(K_BATCH, it.toLong()) }
        setEventActive(info.eventActive)
        info.profileRequired?.let { kv.putLong(K_PROFILE_REQUIRED, if (it) 1 else 0) }
        info.profileConsentVersion?.let { kv.putString(K_PROFILE_CONSENT, it) }
        kv.putLong(K_INFO_AT, nowMs)
    }

    companion object {
        const val DEFAULT_HEARTBEAT_S = 300
        const val DEFAULT_BATCH = 500
        private const val K_ENC = "be_enc_key"
        private const val K_SIGN = "be_sign_key"
        private const val K_HOPS = "be_hops"
        private const val K_HB_INT = "be_hb_interval"
        private const val K_SILENCE = "be_silence"
        private const val K_BATCH = "be_batch"
        private const val K_EVENT = "be_event_active"
        private const val K_INFO_AT = "be_info_at"
        private const val K_PROFILE_REQUIRED = "be_profile_required"
        private const val K_PROFILE_CONSENT = "be_profile_consent"
        private const val K_DEVICE_ID = "be_device_id"
        private const val K_CURSOR = "be_outbox_cursor"
    }
}
