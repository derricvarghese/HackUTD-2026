package com.beacon.mesh.responder

import com.beacon.mesh.net.HttpClient
import com.beacon.mesh.net.HttpResponse
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/** Where the login survives restarts. Keystore-encrypted on device, in memory for tests. */
interface SessionStore {
    fun load(): StoredSession?
    fun save(session: StoredSession?)
}

class InMemorySessionStore(private var session: StoredSession? = null) : SessionStore {
    override fun load() = session
    override fun save(session: StoredSession?) { this.session = session }
}

class ResponderException(val kind: Kind, val detail: String? = null, val code: Int? = null) : Exception(kind.name) {
    enum class Kind { BAD_CREDENTIALS, SIGNED_OUT, ALREADY_CLAIMED, FORBIDDEN, NOT_FOUND, RATE_LIMITED, SERVER, OFFLINE, BAD_RESPONSE }
}

/**
 * REST client for the responder side of the contract (auth, sos and assignments endpoints).
 * The access token lives in memory only; the refresh token goes to [store]. A 401 triggers exactly one
 * refresh-and-retry; a failed refresh signs the user out. Nothing here logs request or response content.
 */
class ResponderClient(
    baseUrl: String,
    private val http: HttpClient,
    private val store: SessionStore,
    private val now: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    val baseUrl: String = baseUrl.trim().trimEnd('/').removeSuffix("/v1").trimEnd('/')

    private class Tokens(val access: String?, val accessExpiresAtMs: Long, val refresh: String, val account: ResponderAccount)

    @Volatile private var tokens: Tokens? = store.load()?.let { Tokens(null, 0, it.refreshToken, it.account) }
    private val refreshLock = Mutex()

    val account: ResponderAccount? get() = tokens?.account

    suspend fun login(username: String, password: String): ResponderAccount {
        val body = JSONObject().put("username", username).put("password", password)
        val r = send("POST", "/v1/auth/login", null, body, bearer = null)
        if (r.code == 401 || r.code == 422) throw ResponderException(ResponderException.Kind.BAD_CREDENTIALS, code = r.code)
        if (r.code !in 200..299) throw error(r)
        return adopt(r, null).account
    }

    /** Best-effort server logout, then everything local is wiped regardless. */
    suspend fun logout() {
        val t = tokens
        tokens = null
        store.save(null)
        if (t?.access != null) {
            runCatching { send("POST", "/v1/auth/logout", null, JSONObject().put("refresh_token", t.refresh), bearer = t.access) }
        }
    }

    /** Open cases, highest priority first. */
    suspend fun openCases(): List<ResponderCase> =
        ResponderCase.parseList(authed("GET", "/v1/sos", "status=reported,assigned,en_route,on_scene&sort=priority&limit=200").body)

    /** Everything that changed after [sinceIso] in any status, so finished cases can be dropped (reconnect catch-up). */
    suspend fun casesUpdatedSince(sinceIso: String): List<ResponderCase> =
        ResponderCase.parseList(
            authed("GET", "/v1/sos", "updated_since=" + URLEncoder.encode(sinceIso, "UTF-8") + "&sort=priority&limit=200").body,
        )

    suspend fun caseDetail(id: String): CaseDetail =
        CaseDetail.parse(authed("GET", "/v1/sos/$id").body) ?: throw ResponderException(ResponderException.Kind.BAD_RESPONSE)

    /** Claims a case. 409 becomes [ResponderException.Kind.ALREADY_CLAIMED] with the other responder's name in `detail`. */
    suspend fun claim(sosId: String): String {
        val r = authed("POST", "/v1/assignments", null, JSONObject().put("sos_id", sosId))
        return JSONObject(r.body).optString("id").takeIf { it.isNotEmpty() }
            ?: throw ResponderException(ResponderException.Kind.BAD_RESPONSE)
    }

    suspend fun updateAssignment(id: String, status: String, outcome: String? = null) {
        val body = JSONObject().put("status", status)
        if (outcome != null) body.put("outcome", outcome)
        authed("PATCH", "/v1/assignments/$id", null, body)
    }

    suspend fun addNote(sosId: String, text: String) {
        authed("PATCH", "/v1/sos/$sosId", null, JSONObject().put("note", text))
    }

    // ---- the responder's own record (`PATCH /v1/responders/{id}`) ----

    /** `available` from `GET /v1/auth/me`, null if the server did not say. */
    suspend fun myAvailability(): Boolean? {
        val j = JSONObject(authed("GET", "/v1/auth/me").body)
        return if (j.has("available") && !j.isNull("available")) j.optBoolean("available") else null
    }

    suspend fun setAvailable(available: Boolean) { patchSelf(JSONObject().put("available", available)) }

    /** Also refreshes `last_seen_at` server-side. */
    suspend fun shareLocation(lat: Double, lng: Double) {
        patchSelf(JSONObject().put("location", JSONObject().put("lat", lat).put("lng", lng)))
    }

    /** `location: null` removes the stored position. */
    suspend fun clearLocation() { patchSelf(JSONObject().put("location", JSONObject.NULL)) }

    private suspend fun patchSelf(body: JSONObject) {
        val id = tokens?.account?.id ?: throw ResponderException(ResponderException.Kind.SIGNED_OUT)
        authed("PATCH", "/v1/responders/$id", null, body)
    }

    /** A valid access token for the WebSocket handshake (refreshes when close to expiry). */
    suspend fun accessToken(): String {
        val t = tokens ?: throw ResponderException(ResponderException.Kind.SIGNED_OUT)
        if (t.access != null && t.accessExpiresAtMs - EXPIRY_SLACK_MS > now()) return t.access
        return refresh(t).access!!
    }

    // ---- plumbing ----

    private suspend fun authed(method: String, path: String, query: String? = null, body: JSONObject? = null): HttpResponse {
        var t = tokens ?: throw ResponderException(ResponderException.Kind.SIGNED_OUT)
        if (t.access == null || t.accessExpiresAtMs - EXPIRY_SLACK_MS < now()) t = refresh(t)
        var r = send(method, path, query, body, t.access)
        if (r.code == 401) {
            t = refresh(t)
            r = send(method, path, query, body, t.access)
        }
        if (r.code !in 200..299) throw error(r)
        return r
    }

    /** Single-flight: if another caller already refreshed since [stale] was read, reuse its result. */
    private suspend fun refresh(stale: Tokens): Tokens = refreshLock.withLock {
        val current = tokens ?: throw ResponderException(ResponderException.Kind.SIGNED_OUT)
        if (current !== stale && current.access != null && current.accessExpiresAtMs - EXPIRY_SLACK_MS > now()) return current
        val r = send("POST", "/v1/auth/refresh", null, JSONObject().put("refresh_token", current.refresh), bearer = null)
        if (r.code !in 200..299) {
            if (r.code == 401 || r.code == 422) {
                tokens = null
                store.save(null)
                throw ResponderException(ResponderException.Kind.SIGNED_OUT, code = r.code)
            }
            throw error(r)
        }
        adopt(r, current.account)
    }

    private fun adopt(r: HttpResponse, fallback: ResponderAccount?): Tokens {
        val j = try { JSONObject(r.body) } catch (e: Exception) { throw ResponderException(ResponderException.Kind.BAD_RESPONSE) }
        val access = j.optString("access_token").takeIf { it.isNotEmpty() }
        val refresh = j.optString("refresh_token").takeIf { it.isNotEmpty() }
        val account = ResponderAccount.from(j.optJSONObject("responder")) ?: fallback
        if (access == null || refresh == null || account == null) throw ResponderException(ResponderException.Kind.BAD_RESPONSE)
        val ttlMs = (if (j.has("expires_in")) j.optLong("expires_in", 900) else 900L) * 1000
        val t = Tokens(access, now() + ttlMs, refresh, account)
        tokens = t
        store.save(StoredSession(refresh, account))
        return t
    }

    private fun error(r: HttpResponse): ResponderException {
        val details = try { JSONObject(r.body).optJSONObject("details") } catch (e: Exception) { null }
        return when (r.code) {
            401 -> ResponderException(ResponderException.Kind.SIGNED_OUT, code = 401)
            403 -> ResponderException(ResponderException.Kind.FORBIDDEN, code = 403)
            404 -> ResponderException(ResponderException.Kind.NOT_FOUND, code = 404)
            409 -> ResponderException(ResponderException.Kind.ALREADY_CLAIMED, details?.str("responder_name"), 409)
            429 -> ResponderException(ResponderException.Kind.RATE_LIMITED, code = 429)
            else -> ResponderException(ResponderException.Kind.SERVER, code = r.code)
        }
    }

    private suspend fun send(method: String, path: String, query: String?, body: JSONObject?, bearer: String?): HttpResponse {
        val headers = HashMap<String, String>()
        headers["Accept"] = "application/json"
        val bytes = body?.toString()?.toByteArray(Charsets.UTF_8)
        if (bytes != null) headers["Content-Type"] = "application/json"
        if (bearer != null) headers["Authorization"] = "Bearer $bearer"
        val url = baseUrl + path + (query?.let { "?$it" } ?: "")
        return try {
            withContext(io) { http.execute(method, url, headers, bytes) }
        } catch (e: IOException) {
            throw ResponderException(ResponderException.Kind.OFFLINE)
        }
    }

    private companion object {
        const val EXPIRY_SLACK_MS = 30_000L
    }
}
