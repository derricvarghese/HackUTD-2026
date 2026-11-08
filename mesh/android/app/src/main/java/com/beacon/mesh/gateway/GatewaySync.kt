package com.beacon.mesh.gateway

import com.beacon.mesh.MeshRouter
import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.ServerInfo
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BatchResponse
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.RemoteStatus
import com.beacon.mesh.store.StoredMessage
import org.json.JSONObject

/** Counts for one upload round, shown on the Mesh status screen. */
data class UploadSummary(
    val atMs: Long,
    val created: Int = 0,
    val duplicate: Int = 0,
    val rejected: Int = 0,
    /** Left pending for a later retry (rate limited, network error, 429). */
    val deferred: Int = 0,
    /** Sent straight to POST /v1/sos instead of the mesh batch. */
    val direct: Int = 0,
    val rejectReasons: Map<String, Int> = emptyMap(),
    val error: String? = null,
    val retryAfterSeconds: Int? = null,
) {
    val total: Int get() = created + duplicate + rejected + deferred + direct
    val ok: Boolean get() = error == null && rejected == 0 && deferred == 0
}

/** Network half of a round (runs on the IO thread); [GatewaySync.apply] consumes it on the router thread. */
class Fetched(
    val directOk: List<StoredMessage>,
    val chunks: List<Pair<List<StoredMessage>, ApiResult<BatchResponse>>>,
    /** Messages not attempted because an earlier call hit a 429 / network error. */
    val skipped: List<StoredMessage>,
)

/**
 * Talks to the backend for a gateway / online phone. Split in a blocking `fetch*` part and an `apply*` part that touches
 * [MeshRouter] (not thread-safe), so the Android wrapper can run the first on an IO thread and the second on the main looper.
 */
class GatewaySync(
    private val api: BeaconApi,
    private val router: MeshRouter,
    private val config: BackendConfig,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    companion object {
        /** Server verdicts that will never change: do not retry these. `rate_limited` is retried. */
        val TERMINAL_REASONS = setOf("bad_signature", "expired", "hop_limit_exceeded", "invalid_limits", "undecryptable", "malformed")

        /** `SosCreate` for POST /v1/sos from an own message (plaintext only over the TLS request, never over the mesh). */
        fun sosCreate(msg: StoredMessage): JSONObject? {
            val p = msg.ownPayload?.let { JSONObject(it) } ?: return null
            if (!msg.isOwn || msg.envelope.kind !in setOf("sos", "safe")) return null
            return JSONObject().apply {
                put("id", msg.id)
                put("channel", "app")
                put("category", p.optString("category", msg.envelope.category ?: "other"))
                for (k in listOf("lat", "lng", "accuracy_m", "text", "people_count", "trapped", "water_rising", "injured")) {
                    if (p.has(k) && !p.isNull(k)) put(k, p.get(k))
                }
                put("created_at", msg.envelope.createdAt)
            }
        }
    }

    // ---- server info ----

    fun fetchServerInfo(): ApiResult<ServerInfo> = api.serverInfo()

    /** @return true when the cached keys / hop table were refreshed. */
    fun applyServerInfo(r: ApiResult<ServerInfo>): Boolean = when (r) {
        is ApiResult.Ok -> {
            config.update(r.value, now())
            router.reevaluateInbox()
            true
        }
        is ApiResult.Failure -> false
    }

    // ---- uploads ----

    /** Blocking. Own sos/safe messages created while online go to POST /v1/sos; everything else to POST /v1/sos/batch. */
    fun fetchUploads(msgs: List<StoredMessage>, tryDirect: (StoredMessage) -> Boolean): Fetched {
        val directOk = ArrayList<StoredMessage>()
        val rest = ArrayList<StoredMessage>()
        val skipped = ArrayList<StoredMessage>()
        var stop = false
        for (m in msgs) {
            val body = if (tryDirect(m)) sosCreate(m) else null
            if (body == null) { rest.add(m); continue }
            if (stop) { skipped.add(m); continue }
            when (val r = api.createSos(body)) {
                is ApiResult.Ok -> directOk.add(m)
                is ApiResult.Failure -> {
                    if (r.isNetwork || r.isRateLimited) stop = true
                    // any other failure: fall back to the mesh batch, which returns a precise per-item reason
                    if (stop) skipped.add(m) else rest.add(m)
                }
            }
        }
        val chunks = ArrayList<Pair<List<StoredMessage>, ApiResult<BatchResponse>>>()
        for (chunk in rest.chunked(config.maxBatch)) {
            if (stop) { skipped.addAll(chunk); continue }
            val r = api.uploadBatch(chunk.map { it.envelope })
            if (r is ApiResult.Failure && (r.isNetwork || r.isRateLimited)) stop = true
            chunks.add(chunk to r)
        }
        return Fetched(directOk, chunks, skipped)
    }

    /** On the router thread. Marks uploaded / rejected, injects receipts and backend messages into the mesh. */
    fun apply(f: Fetched, log: (String) -> Unit = this.log): UploadSummary {
        var created = 0; var dup = 0; var rejected = 0; var deferred = f.skipped.size
        var error: String? = null; var retry: Int? = null
        val reasons = LinkedHashMap<String, Int>()
        f.directOk.forEach {
            router.markUploaded(it.id)
            log("UPLOAD ${it.id.take(8)} ok")
        }
        for ((msgs, res) in f.chunks) {
            when (res) {
                is ApiResult.Failure -> {
                    deferred += msgs.size
                    error = res.message
                    if (res.isRateLimited) retry = res.retryAfterSeconds ?: 60
                    msgs.forEach { log("UPLOAD ${it.id.take(8)} failed: ${res.message}") }
                }
                is ApiResult.Ok -> {
                    val byId = res.value.results.associateBy { it.id }
                    for (m in msgs) {
                        val item = byId[m.id]
                        when {
                            item == null -> { deferred++; log("UPLOAD ${m.id.take(8)} failed: no result") }
                            item.status == "created" -> { created++; router.markUploaded(m.id); log("UPLOAD ${m.id.take(8)} ok") }
                            item.status == "duplicate" -> { dup++; router.markUploaded(m.id); log("UPLOAD ${m.id.take(8)} ok") }
                            item.reason in TERMINAL_REASONS -> {
                                rejected++
                                router.markRejected(m.id, item.reason!!)
                                reasons.merge(item.reason, 1, Int::plus)
                                log("UPLOAD ${m.id.take(8)} failed: rejected (${item.reason})")
                            }
                            else -> { deferred++; log("UPLOAD ${m.id.take(8)} failed: ${item.reason ?: "rejected"}") }
                        }
                    }
                    res.value.receipts.forEach { router.injectReceipt(it) }
                    res.value.messages.forEach { router.injectBackend(it) }
                }
            }
        }
        return UploadSummary(now(), created, dup, rejected, deferred, f.directOk.size, reasons, error, retry)
    }

    // ---- downlink ----

    fun fetchOutbox(): ApiResult<List<BackendMessage>> = api.outbox(config.outboxCursor)

    /** Injects the messages into the mesh and advances the `since` cursor. @return number injected. */
    fun applyOutbox(r: ApiResult<List<BackendMessage>>): Int {
        if (r !is ApiResult.Ok) return 0
        var n = 0
        for (m in r.value) {
            if (router.injectBackend(m) != null) n++
        }
        r.value.maxOfOrNull { Iso.parse(it.createdAt) ?: 0L }?.takeIf { it > 0 }?.let {
            // the server filters created_at > since; keep 1 s of overlap, duplicates are dropped by id
            config.outboxCursor = Iso.format(it - 1000)
        }
        return n
    }

    fun fetchStatus(id: String): ApiResult<RemoteStatus> = api.sosStatus(id)
    fun applyStatus(id: String, r: ApiResult<RemoteStatus>) {
        if (r is ApiResult.Ok) router.applyPolledStatus(id, r.value)
    }

    fun fetchPendingCheckins(): ApiResult<List<CheckinPrompt>> = api.pendingCheckins(now())
}
