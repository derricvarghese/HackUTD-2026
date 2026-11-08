package com.beacon.mesh

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.beacon.mesh.crypto.KeystoreSigner
import com.beacon.mesh.gateway.GatewayUploader
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.store.SqliteMessageStore
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.transport.BleMeshTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Result of the most recent gateway upload attempt, for the status screen. */
data class UploadResult(val atMs: Long, val messageId: String, val ok: Boolean, val detail: String?)

/** Last known GPS fix (null in the snapshot when there is none). */
data class GpsFix(val accuracyM: Float?, val timeMs: Long)

/** Immutable view of everything the UI shows; published by [MeshNode.state]. */
data class MeshSnapshot(
    val relayId: String = "",
    val started: Boolean = false,
    val peers: List<String> = emptyList(),
    val messages: List<StoredMessage> = emptyList(),
    val log: List<String> = emptyList(),
    /** Acting as gateway: internet validated, backend URL set, not forced offline. */
    val isGateway: Boolean = false,
    /** The phone has a validated internet connection (regardless of backend URL / force offline). */
    val hasInternet: Boolean = false,
    val forceOffline: Boolean = false,
    val backendUrl: String = "",
    val demoHopCap: Int? = null,
    val uploadingIds: Set<String> = emptySet(),
    val lastUpload: UploadResult? = null,
    val gps: GpsFix? = null,
    /** Own message id -> peers it was pushed to at creation time. */
    val sentToPeers: Map<String, Int> = emptyMap(),
)

/**
 * App-wide mesh node: BLE transport + router + SQLite store + gateway uploader + GPS.
 * Everything runs on the main looper. Get it with [MeshNode.get].
 */
@SuppressLint("MissingPermission")
class MeshNode private constructor(context: Context) : BleMeshTransport.Listener {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val prefs = app.getSharedPreferences("beacon_mesh", Context.MODE_PRIVATE)

    val router = MeshRouter(KeystoreSigner(), SqliteMessageStore(app))
    val relayId: String get() = router.relayId

    private val transport = BleMeshTransport(app, main)
    private val uploader = GatewayUploader(app, main, router.relayId)
    private val locationManager = app.getSystemService(LocationManager::class.java)
    private var lastLocation: Location? = null
    private var started = false

    val logLines = ArrayDeque<String>()
    private val listeners = LinkedHashSet<() -> Unit>()

    // ---- UI state (additive; the listener API above keeps working) ----
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val inFlight = LinkedHashSet<String>()
    private var lastUpload: UploadResult? = null
    private val sentTo = HashMap<String, Int>()
    private val _state = MutableStateFlow(MeshSnapshot())
    /** Hot snapshot of peers, messages, log, gateway and GPS state. Updated on the main thread. */
    val state: StateFlow<MeshSnapshot> = _state.asStateFlow()

    /** Demo setting: cap maxHops for non-critical messages (null = priority table). */
    var demoHopCap: Int?
        get() = prefs.getInt("demoHopCap", 0).takeIf { it > 0 }
        set(v) { prefs.edit().putInt("demoHopCap", v ?: 0).apply(); notifyChanged() }

    var forceOffline: Boolean
        get() = prefs.getBoolean("forceOffline", false)
        set(v) { prefs.edit().putBoolean("forceOffline", v).apply(); uploader.forceOffline = v; notifyChanged() }

    var backendUrl: String
        get() = prefs.getString("backendUrl", "") ?: ""
        set(v) { prefs.edit().putString("backendUrl", v).apply(); uploader.backendUrl = v; notifyChanged() }

    val messages: List<StoredMessage> get() = router.messages.sortedByDescending { it.receivedAt }
    val peerCount: Int get() = router.connectedPeers.size
    val isGateway: Boolean get() = uploader.isOnline

    init {
        router.transport = transport
        router.isOnline = { uploader.isOnline }
        router.upload = { if (!it.uploaded) inFlight.add(it.id); uploader.upload(it) }
        router.onChange = { notifyChanged() }
        router.log = { append(it) }
        uploader.forceOffline = forceOffline
        uploader.backendUrl = backendUrl
        uploader.onOnline = { notifyChanged(); router.internetBecameAvailable() }
        uploader.onUploaded = { inFlight.remove(it); router.markUploaded(it) }
        uploader.log = { trackUpload(it); append(it) }
        transport.listener = this
        _state.value = buildSnapshot()
    }

    /** Call after Bluetooth + location permissions are granted. Safe to call repeatedly. */
    fun start() {
        if (started) {
            transport.start() // retries if Bluetooth was off the first time
            return
        }
        started = true
        notifyChanged()
        uploader.start()
        transport.start()
        startLocation()
        router.pruneExpired()
        main.postDelayed(object : Runnable {
            override fun run() {
                router.pruneExpired()
                main.postDelayed(this, 60_000)
            }
        }, 60_000)
        append("Node $relayId started")
    }

    fun sendSos(category: Category, text: String?, people: Int? = null): StoredMessage? {
        val loc = lastLocation
        return try {
            val offline = !isGateway
            val peersNow = router.connectedPeers.size
            router.originate(
                category = category,
                text = text?.takeIf { it.isNotBlank() },
                lat = loc?.latitude,
                lng = loc?.longitude,
                accuracy = loc?.accuracy?.toDouble(),
                people = people,
                nonCriticalHopCap = demoHopCap,
            ).also { if (offline) sentTo[it.id] = peersNow; notifyChanged() }
        } catch (e: Exception) {
            append("Failed to create SOS: ${e.message}")
            null
        }
    }

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    private fun notifyChanged() {
        _state.value = buildSnapshot()
        listeners.toList().forEach { it() }
    }

    private fun buildSnapshot() = MeshSnapshot(
        relayId = relayId,
        started = started,
        peers = router.connectedPeers,
        messages = messages,
        log = logLines.toList(),
        isGateway = isGateway,
        hasInternet = hasValidatedInternet(),
        forceOffline = forceOffline,
        backendUrl = backendUrl,
        demoHopCap = demoHopCap,
        uploadingIds = inFlight.toSet(),
        lastUpload = lastUpload,
        gps = lastLocation?.let { GpsFix(if (it.hasAccuracy()) it.accuracy else null, it.time) },
        sentToPeers = sentTo.toMap(),
    )

    private fun hasValidatedInternet(): Boolean {
        val cm = connectivity ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** The uploader reports through its log: "UPLOAD abcd1234 ok" / "UPLOAD abcd1234 failed: reason". */
    private fun trackUpload(line: String) {
        val m = UPLOAD_LINE.matchEntire(line) ?: return
        val (short, outcome, detail) = m.destructured
        val id = inFlight.firstOrNull { it.startsWith(short) } ?: short
        inFlight.remove(id)
        lastUpload = UploadResult(System.currentTimeMillis(), id, outcome == "ok", detail.ifBlank { null })
    }

    private fun append(line: String) {
        val ts = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logLines.addFirst("$ts $line")
        while (logLines.size > 200) logLines.removeLast()
        notifyChanged()
    }

    private fun startLocation() {
        val lm = locationManager ?: return
        val listener = LocationListener { lastLocation = it; notifyChanged() }
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (!lm.isProviderEnabled(provider)) continue
                lm.getLastKnownLocation(provider)?.let { if (lastLocation == null) lastLocation = it }
                lm.requestLocationUpdates(provider, 10_000L, 0f, listener, Looper.getMainLooper())
            } catch (e: SecurityException) {
                append("No location permission; SOS will be sent without GPS")
            } catch (e: IllegalArgumentException) {
                // provider missing on this device
            }
        }
    }

    // ---- BleMeshTransport.Listener ----

    override fun onPeerReady(peer: String) = router.peerConnected(peer)
    override fun onPeerLost(peer: String) = router.peerDisconnected(peer)
    override fun onEnvelope(envelopeJson: ByteArray, fromPeer: String) { router.receive(envelopeJson, fromPeer) }
    override fun onLog(message: String) = append(message)

    companion object {
        private val UPLOAD_LINE = Regex("UPLOAD (\\w+) (ok|failed)(?:: (.*))?")

        @Volatile private var instance: MeshNode? = null

        fun get(context: Context): MeshNode =
            instance ?: synchronized(this) { instance ?: MeshNode(context).also { instance = it } }
    }
}
