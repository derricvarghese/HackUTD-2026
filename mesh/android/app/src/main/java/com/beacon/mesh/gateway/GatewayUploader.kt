package com.beacon.mesh.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.store.StoredMessage
import java.util.concurrent.Executors

/**
 * Watches connectivity and runs all backend traffic for a gateway / online phone: batch and direct uploads,
 * server-info refresh, outbox polling, status and check-in polling. Network work runs on one IO thread; results are
 * applied on the main looper (the router is single-threaded). The hooks ([onOnline], [onUploaded], [log]) keep their
 * old meaning so the UI snapshot keeps working.
 */
class GatewayUploader(context: Context, private val main: Handler, private val relayId: String) {
    var backendUrl: String? = null
        set(value) {
            val was = isOnline
            field = value?.trim()?.trimEnd('/')
            if (!was && isOnline) onOnline()
        }

    /** Demo switch: pretend there is no internet even when there is. */
    var forceOffline = false
        set(value) {
            val was = isOnline
            field = value
            if (!was && isOnline) onOnline()
        }

    /** Set by the node once the router / API exist. */
    var sync: GatewaySync? = null
    /** Own messages that may skip the mesh and go straight to POST /v1/sos while online. */
    var tryDirect: (StoredMessage) -> Boolean = { false }

    var onOnline: () -> Unit = {}
    var onUploaded: (String) -> Unit = {}
    var onSummary: (UploadSummary) -> Unit = {}
    var onServerReachable: (Boolean) -> Unit = {}
    var log: (String) -> Unit = {}

    val isOnline: Boolean get() = validated && !forceOffline && !backendUrl.isNullOrBlank()

    private var validated = false
    private val queue = LinkedHashMap<String, StoredMessage>()
    private val inFlight = HashSet<String>()
    private var backoffUntil = 0L
    private var flushScheduled = false
    private var busyIo = 0
    private val io = Executors.newSingleThreadExecutor()
    private val cm = context.getSystemService(ConnectivityManager::class.java)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val ok = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            main.post { setValidated(ok) }
        }

        override fun onLost(network: Network) {
            main.post { setValidated(false) }
        }
    }

    fun start() {
        cm?.registerDefaultNetworkCallback(callback)
    }

    fun stop() {
        try { cm?.unregisterNetworkCallback(callback) } catch (_: IllegalArgumentException) {}
    }

    private fun setValidated(ok: Boolean) {
        val was = isOnline
        validated = ok
        if (!was && isOnline) onOnline()
    }

    /** Queue a message for the backend. Bursts are coalesced into one batch. Call on the main thread. */
    fun upload(msg: StoredMessage) {
        if (backendUrl.isNullOrBlank() || msg.uploaded || msg.rejectReason != null || msg.id in inFlight) return
        queue[msg.id] = msg
        if (!flushScheduled) {
            flushScheduled = true
            main.postDelayed({ flushScheduled = false; flush() }, 250)
        }
    }

    private fun flush() {
        val s = sync ?: return
        if (!isOnline) { queue.clear(); return }
        val wait = backoffUntil - System.currentTimeMillis()
        if (wait > 0) {
            if (!flushScheduled) { flushScheduled = true; main.postDelayed({ flushScheduled = false; flush() }, wait + 100) }
            return
        }
        val batch = queue.values.filter { it.id !in inFlight }
        if (batch.isEmpty()) return
        queue.clear()
        batch.forEach { inFlight.add(it.id) }
        io.execute {
            val fetched = try {
                s.fetchUploads(batch, tryDirect)
            } catch (e: Exception) {
                Fetched(emptyList(), emptyList(), batch)
            }
            main.post {
                batch.forEach { inFlight.remove(it.id) }
                val summary = s.apply(fetched, log)
                fetched.directOk.forEach { onUploaded(it.id) }
                fetched.chunks.forEach { (msgs, res) ->
                    if (res is ApiResult.Ok) {
                        res.value.results.filter { it.status != "rejected" }.forEach { onUploaded(it.id) }
                    }
                }
                summary.retryAfterSeconds?.let {
                    backoffUntil = System.currentTimeMillis() + it * 1000L
                    log("Upload throttled (429), retry in ${it}s")
                }
                onSummary(summary)
                onServerReachable(summary.error == null || fetched.chunks.any { it.second is ApiResult.Ok } || fetched.directOk.isNotEmpty())
            }
        }
    }

    /** Re-queue everything still pending (after a backoff or a failed round). */
    fun retry(pending: List<StoredMessage>) { pending.forEach(::upload) }

    // ---- other backend traffic (all hop onto the IO thread and back) ----

    /** GET /v1/server-info; refreshes keys, hop table, heartbeat settings. */
    fun refreshServerInfo(done: (Boolean) -> Unit = {}) = runIo(
        work = { it.fetchServerInfo() },
        apply = { s, r -> val ok = s.applyServerInfo(r); onServerReachable(r is ApiResult.Ok); done(ok) },
        failed = { onServerReachable(false); done(false) },
    )

    fun pollOutbox(done: (Int) -> Unit = {}) = runIo(
        work = { it.fetchOutbox() },
        apply = { s, r -> done(s.applyOutbox(r)) },
        failed = { done(0) },
    )

    fun pollStatuses(ids: List<String>) {
        if (ids.isEmpty()) return
        runIo(
            work = { s -> ids.map { it to s.fetchStatus(it) } },
            apply = { s, rs -> rs.forEach { (id, r) -> s.applyStatus(id, r) } },
        )
    }

    /** GET /v1/checkins/pending; [apply] runs on the main thread with the result. */
    fun pollCheckins(apply: (ApiResult<List<com.beacon.mesh.store.CheckinPrompt>>) -> Unit) =
        runIo(work = { it.fetchPendingCheckins() }, apply = { _, r -> apply(r) })

    /** Run [work] on the IO thread, then [apply] on main. Skips if a previous background job of this kind is still busy. */
    fun <T> runIo(work: (GatewaySync) -> T, apply: (GatewaySync, T) -> Unit, failed: () -> Unit = {}) {
        val s = sync ?: return
        if (!isOnline) { failed(); return }
        if (busyIo > 4) return
        busyIo++
        io.execute {
            val r = try { work(s) } catch (e: Exception) { null }
            main.post {
                busyIo--
                if (r == null) failed() else apply(s, r)
            }
        }
    }

    /** Arbitrary blocking call on the IO thread, result on main (used for heartbeats / check-in replies). */
    fun <T> background(work: () -> T, done: (T?) -> Unit) {
        io.execute {
            val r = try { work() } catch (e: Exception) { null }
            main.post { done(r) }
        }
    }
}
