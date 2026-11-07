package com.beacon.mesh.gateway

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import com.beacon.mesh.store.StoredMessage
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Watches connectivity and POSTs held envelopes to the backend when this phone is a gateway. */
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

    var onOnline: () -> Unit = {}
    var onUploaded: (String) -> Unit = {}
    var log: (String) -> Unit = {}

    val isOnline: Boolean get() = validated && !forceOffline && !backendUrl.isNullOrBlank()

    private var validated = false
    private val inFlight = HashSet<String>()
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

    /** Call on the main thread. */
    fun upload(msg: StoredMessage) {
        val base = backendUrl
        if (base.isNullOrBlank() || msg.uploaded || !inFlight.add(msg.id)) return
        val body = JSONObject().apply {
            put("envelope", msg.envelope.toJson())
            put("gateway", relayId)
            put("receivedAt", msg.receivedAt)
        }.toString().toByteArray(Charsets.UTF_8)

        io.execute {
            val result = try {
                val conn = URL("$base/api/mesh/ingest").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 15_000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body) }
                val code = conn.responseCode
                conn.disconnect()
                if (code in 200..299) null else "HTTP $code"
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            main.post {
                inFlight.remove(msg.id)
                if (result == null) {
                    log("UPLOAD ${msg.id.take(8)} ok")
                    onUploaded(msg.id)
                } else {
                    log("UPLOAD ${msg.id.take(8)} failed: $result")
                }
            }
        }
    }
}
