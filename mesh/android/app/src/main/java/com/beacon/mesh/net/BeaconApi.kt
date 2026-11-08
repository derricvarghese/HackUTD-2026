package com.beacon.mesh.net

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.ServerInfo
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.DeliveredReceipt
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.RemoteStatus
import com.beacon.mesh.welfare.CheckinParser
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URL

sealed class ApiResult<out T> {
    data class Ok<T>(val value: T, val code: Int) : ApiResult<T>()
    /** [code] null = network failure. [errorCode] is the contract `Error.code` when the server sent one. */
    data class Failure(
        val code: Int?, val errorCode: String?, val message: String, val retryAfterSeconds: Int? = null,
        /** `Error.details` when the server sent one (e.g. `profile_version` on a 409, field names on a 422). */
        val details: JSONObject? = null,
    ) : ApiResult<Nothing>() {
        val isRateLimited get() = code == 429
        val isNetwork get() = code == null
    }
}

data class BatchItem(val id: String, val status: String, val reason: String?, val sosId: String?)
data class BatchResponse(val results: List<BatchItem>, val receipts: List<DeliveredReceipt>, val messages: List<BackendMessage>)
/** Server copy of the profile as far as the sync engine cares: version plus the full body (device's own view). */
data class ServerProfile(val profileVersion: Int, val profile: JSONObject, val created: Boolean)

/** 202 body of `POST /heartbeats`: [eventActive] is false when accepted only because the device has an open SOS. */
data class HeartbeatAck(val eventActive: Boolean, val nextInSeconds: Int?, val pendingCheckins: List<CheckinPrompt> = emptyList())

/**
 * Blocking client for the Beacon REST contract (openapi.yaml). Call off the main thread.
 * Authenticated calls register the device on demand and sign every request (see [RequestSigner]).
 */
class BeaconApi(
    baseUrl: String,
    private val http: HttpClient,
    private val signer: RequestSigner,
    private val config: BackendConfig,
    publicKeyB64: String,
    private val appVersion: String,
) {
    /** Base64 SPKI sent to `POST /v1/devices`; replaced when the device identity is reset. */
    @Volatile var publicKeyB64: String = publicKeyB64

    private val base = baseUrl.trim().trimEnd('/')
    private val basePath = try { URL(base).path.trimEnd('/') } catch (e: Exception) { "" }

    // ---- unauthenticated ----

    fun serverInfo(): ApiResult<ServerInfo> =
        call("GET", "/v1/server-info", null, signed = false) { ServerInfo.fromJson(JSONObject(it)) }

    /** POST /v1/devices (idempotent on public_key; 201 new, 200 existing). Stores the device id. */
    fun ensureRegistered(): ApiResult<String> {
        config.deviceId?.let { return ApiResult.Ok(it, 200) }
        val body = JSONObject().put("public_key", publicKeyB64).put("platform", "android").put("app_version", appVersion)
        return call("POST", "/v1/devices", body.toString(), signed = false) {
            JSONObject(it).getString("id").also { id -> config.deviceId = id }
        }
    }

    // ---- device-signed ----

    /** POST /v1/sos/batch. Caller keeps `envelopes.size <= gateway_upload_max_batch`. */
    fun uploadBatch(envelopes: List<MeshEnvelope>): ApiResult<BatchResponse> {
        val body = JSONObject().put("envelopes", JSONArray().also { a -> envelopes.forEach { a.put(it.toJson()) } })
        return signedCall("POST", "/v1/sos/batch", body.toString()) { parseBatch(JSONObject(it)) }
    }

    /** POST /v1/sos (direct, phone online). 201 created / 200 replay are both success. */
    fun createSos(sosCreate: JSONObject): ApiResult<Unit> =
        signedCall("POST", "/v1/sos", sosCreate.toString()) { }

    fun sosStatus(sosId: String): ApiResult<RemoteStatus> = signedCall("GET", "/v1/sos/$sosId/status", null) {
        val o = JSONObject(it)
        RemoteStatus(
            status = o.optString("status").ifBlank { null },
            reachedResponders = o.optBoolean("reached_responders", false),
            etaMinutes = if (o.isNull("eta_minutes")) null else o.optInt("eta_minutes"),
            message = if (o.isNull("message")) null else o.optString("message").ifBlank { null },
            updatedAtMs = Iso.parse(o.optString("updated_at")) ?: 0L,
        )
    }

    fun outbox(since: String?): ApiResult<List<BackendMessage>> {
        val q = "?limit=200" + (since?.let { "&since=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")
        return signedCall("GET", "/v1/mesh/outbox", null, query = q) {
            val a = JSONObject(it).getJSONArray("data")
            (0 until a.length()).mapNotNull { i -> BackendMessage.fromJson(a.getJSONObject(i)) }
        }
    }

    /** GET /v1/checkins/pending: unanswered, not-yet-missed welfare check-ins of this device. */
    fun pendingCheckins(now: Long): ApiResult<List<CheckinPrompt>> = signedCall("GET", "/v1/checkins/pending", null) {
        CheckinParser.fromRestArray(JSONObject(it).getJSONArray("data"), now)
    }

    /** PATCH /v1/checkins/{id}: response is still_here | no_longer_need_help | need_urgent_help. */
    fun respondCheckin(checkinId: String, response: String, text: String?, respondedAtMs: Long): ApiResult<Unit> {
        val body = JSONObject().put("response", response).put("responded_at", Iso.format(respondedAtMs))
        text?.let { body.put("text", it) }
        return signedCall("PATCH", "/v1/checkins/$checkinId", body.toString()) { }
    }

    /** POST /v1/heartbeats (automatic liveness). The 202 body may carry `pending_checkins`. */
    fun heartbeat(payload: JSONObject, now: Long = System.currentTimeMillis()): ApiResult<HeartbeatAck> =
        signedCall("POST", "/v1/heartbeats", payload.toString()) {
            val o = JSONObject(it)
            HeartbeatAck(
                o.optBoolean("event_active", true),
                if (o.has("next_heartbeat_in_seconds") && !o.isNull("next_heartbeat_in_seconds")) o.optInt("next_heartbeat_in_seconds") else null,
                CheckinParser.fromRestArray(o.optJSONArray("pending_checkins"), now),
            )
        }

    // ---- profile (personal data: never log bodies) ----

    /** PUT /v1/devices/{id}/profile. [ifMatch] = last known server version (0 = create only), null = unconditional. */
    fun putProfile(input: JSONObject, ifMatch: Int?): ApiResult<ServerProfile> {
        val id = when (val r = ensureRegistered()) { is ApiResult.Ok -> r.value; is ApiResult.Failure -> return r }
        val extra = ifMatch?.let { mapOf("If-Match" to it.toString()) } ?: emptyMap()
        return when (val r = signedCall("PUT", "/v1/devices/$id/profile", input.toString(), extraHeaders = extra) { parseProfile(it) }) {
            is ApiResult.Ok -> ApiResult.Ok(r.value.copy(created = r.code == 201), r.code)
            is ApiResult.Failure -> r
        }
    }

    fun getProfile(): ApiResult<ServerProfile> {
        val id = when (val r = ensureRegistered()) { is ApiResult.Ok -> r.value; is ApiResult.Failure -> return r }
        return signedCall("GET", "/v1/devices/$id/profile", null) { parseProfile(it) }
    }

    /** DELETE /v1/devices/{id}/profile (right to erasure). 204 and 404 both mean "gone". */
    fun deleteProfile(): ApiResult<Unit> {
        val id = when (val r = ensureRegistered()) { is ApiResult.Ok -> r.value; is ApiResult.Failure -> return r }
        return signedCall("DELETE", "/v1/devices/$id/profile", null) { }
    }

    /** GET /v1/devices/{id}: only `profile_version` (null = the server holds no profile). */
    fun deviceProfileVersion(): ApiResult<Int?> {
        val id = when (val r = ensureRegistered()) { is ApiResult.Ok -> r.value; is ApiResult.Failure -> return r }
        return signedCall("GET", "/v1/devices/$id", null) { b ->
            JSONObject(b).let { if (it.has("profile_version") && !it.isNull("profile_version")) it.getInt("profile_version") else null }
        }
    }

    private fun parseProfile(body: String): ServerProfile =
        JSONObject(body).let { ServerProfile(it.getInt("profile_version"), it, false) }

    // ---- plumbing ----

    private fun <T> signedCall(
        method: String, path: String, body: String?, query: String = "",
        extraHeaders: Map<String, String> = emptyMap(), parse: (String) -> T,
    ): ApiResult<T> {
        var attempt = 0
        while (true) {
            val id = when (val r = ensureRegistered()) {
                is ApiResult.Ok -> r.value
                is ApiResult.Failure -> return r
            }
            val bytes = body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
            val signedPath = basePath + path // the query string is not signed
            val headers = signer.headers(id, method, signedPath, bytes)
            val res = call(method, path + query, body, signed = true, extraHeaders = headers + extraHeaders, parse = parse)
            // The server forgot this device (e.g. database reset): register again once and retry.
            if (res is ApiResult.Failure && res.code == 401 && res.errorCode == "unauthorized" && attempt == 0) {
                config.deviceId = null
                attempt++
                continue
            }
            return res
        }
    }

    private fun <T> call(
        method: String, pathAndQuery: String, body: String?, signed: Boolean,
        extraHeaders: Map<String, String> = emptyMap(), parse: (String) -> T,
    ): ApiResult<T> {
        val headers = HashMap<String, String>(extraHeaders)
        headers["Accept"] = "application/json"
        if (body != null) headers["Content-Type"] = "application/json"
        val res = try {
            http.execute(method, base + pathAndQuery, headers, body?.toByteArray(Charsets.UTF_8))
        } catch (e: IOException) {
            return ApiResult.Failure(null, null, e.message ?: e.javaClass.simpleName)
        }
        if (res.code in 200..299) {
            return try {
                ApiResult.Ok(parse(res.body), res.code)
            } catch (e: Exception) {
                ApiResult.Failure(res.code, null, "unexpected response")
            }
        }
        val err = try { JSONObject(res.body) } catch (e: Exception) { null }
        return ApiResult.Failure(
            res.code, err?.optString("code")?.ifBlank { null }, err?.optString("message")?.ifBlank { null } ?: "HTTP ${res.code}",
            res.headers["retry-after"]?.trim()?.toIntOrNull(),
            err?.optJSONObject("details"),
        )
    }

    private fun parseBatch(o: JSONObject): BatchResponse {
        val results = o.getJSONArray("results").let { a ->
            (0 until a.length()).map { i ->
                val r = a.getJSONObject(i)
                BatchItem(r.getString("id"), r.getString("status"), r.optString("reason").ifBlank { null }, r.optString("sos_id").ifBlank { null })
            }
        }
        val receipts = o.optJSONArray("receipts")?.let { a -> (0 until a.length()).mapNotNull { DeliveredReceipt.fromJson(a.getJSONObject(it)) } } ?: emptyList()
        val messages = o.optJSONArray("messages")?.let { a -> (0 until a.length()).mapNotNull { BackendMessage.fromJson(a.getJSONObject(it)) } } ?: emptyList()
        return BatchResponse(results, receipts, messages)
    }
}
