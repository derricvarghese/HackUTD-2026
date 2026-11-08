package com.beacon.mesh

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.KeyStatus
import com.beacon.mesh.backend.PrefsKeyValueStore
import com.beacon.mesh.crypto.KeystoreSigner
import com.beacon.mesh.gateway.GatewaySync
import com.beacon.mesh.gateway.GatewayUploader
import com.beacon.mesh.gateway.UploadSummary
import com.beacon.mesh.heartbeat.Heartbeat
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.net.UrlConnectionHttp
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.SqliteMessageStore
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.transport.BleMeshTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** Result of the most recent gateway upload attempt, for the status screen. */
data class UploadResult(val atMs: Long, val messageId: String, val ok: Boolean, val detail: String?, val summary: UploadSummary? = null)

/** Last known GPS fix (null in the snapshot when there is none). */
data class GpsFix(val accuracyM: Float?, val timeMs: Long)

/** Heartbeat state for the Mesh status screen. */
data class HeartbeatUi(
    /** An event is active (from /server-info, last known), so heartbeats are being sent. */
    val active: Boolean = false,
    val lastSentMs: Long = 0,
    /** True when the last heartbeat went over the mesh instead of POST /v1/heartbeats. */
    val lastViaMesh: Boolean = false,
    val intervalSeconds: Int = 0,
)

/** Outcome of [MeshNode.sendSos]. */
sealed interface SendResult {
    data class Sent(val message: StoredMessage) : SendResult
    data class Failed(val error: SendError) : SendResult
}

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
    /** Backend encryption key availability: none, built into the app, or cached from /server-info. */
    val encKeyStatus: KeyStatus = KeyStatus.NONE,
    val signKeyStatus: KeyStatus = KeyStatus.NONE,
    /** Device id returned by POST /v1/devices, null until registered. */
    val deviceId: String? = null,
    /** null = not tried yet, true/false = outcome of the latest call to the server. */
    val serverReachable: Boolean? = null,
    val serverInfoAtMs: Long = 0,
    val heartbeat: HeartbeatUi = HeartbeatUi(),
    /** Check-ins the backend asked this phone to answer and that are still open. */
    val checkins: List<CheckinPrompt> = emptyList(),
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

    private val signer = KeystoreSigner()
    val config = BackendConfig(PrefsKeyValueStore(prefs), BuildConfig.BACKEND_ENC_PUBLIC_KEY, BuildConfig.BACKEND_SIGN_PUBLIC_KEY)
    val router = MeshRouter(signer, SqliteMessageStore(app), config)
    val relayId: String get() = router.relayId

    private val api = BeaconApi(
        BuildConfig.BACKEND_URL, UrlConnectionHttp(), RequestSigner(signer), config,
        Base64.getEncoder().encodeToString(signer.publicKeyDer), BuildConfig.VERSION_NAME,
    )
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
    private var serverReachable: Boolean? = null
    private val sentTo = HashMap<String, Int>()
    private val directAttempted = ConcurrentHashMap.newKeySet<String>()
    private var tickCount = 0
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

    /** Fixed at build time (see BACKEND_URL in app/build.gradle.kts); not a user setting. */
    val backendUrl: String = BuildConfig.BACKEND_URL

    val messages: List<StoredMessage> get() = router.messages.filter { !it.isHeartbeat }.sortedByDescending { it.receivedAt }
    val peerCount: Int get() = router.connectedPeers.size
    val isGateway: Boolean get() = uploader.isOnline

    init {
        router.transport = transport
        router.isOnline = { uploader.isOnline }
        router.upload = { if (!it.uploaded) inFlight.add(it.id); uploader.upload(it) }
        router.onChange = { notifyChanged() }
        router.log = { append(it) }
        uploader.sync = GatewaySync(api, router, config, log = { append(it) })
        // Own SOS created while online go straight to POST /v1/sos once; failures fall back to the mesh batch.
        uploader.tryDirect = { it.isOwn && directAttempted.add(it.id) }
        uploader.forceOffline = forceOffline
        uploader.backendUrl = backendUrl
        uploader.onOnline = { notifyChanged(); onBecameOnline() }
        uploader.onUploaded = { inFlight.remove(it) }
        uploader.onSummary = { s -> inFlight.clear(); recordSummary(s) }
        uploader.onServerReachable = { serverReachable = it; notifyChanged() }
        uploader.log = { append(it) }
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
        if (config.encryptionKeyStatus == KeyStatus.NONE) append("No backend key yet: SOS needs one online refresh or a build-time key")
    }

    /**
     * Periodic work, driven by the foreground service (every ~30 s, also with the screen off): heartbeat, and while a
     * gateway the outbox / status / check-in polling and a /server-info refresh. Uses only the last known location.
     */
    fun tick() {
        tickCount++
        heartbeatTick()
        if (!uploader.isOnline) return
        val now = System.currentTimeMillis()
        if (now - config.lastInfoAtMs > INFO_REFRESH_MS) uploader.refreshServerInfo()
        uploader.pollOutbox()
        uploader.pollCheckins()
        if (tickCount % 2 == 0) {
            val ids = router.messages.filter { it.isOwn && it.envelope.kind in setOf("sos", "safe") && it.expiresAtMs > now && it.remote?.status !in FINAL_STATUSES }.map { it.id }
            uploader.pollStatuses(ids)
        }
        uploader.retry(router.pendingUploads())
    }

    private fun onBecameOnline() {
        uploader.refreshServerInfo()
        router.internetBecameAvailable()
        uploader.pollOutbox()
        uploader.pollCheckins()
    }

    fun sendSos(category: Category, text: String?, people: Int? = null): SendResult {
        val loc = lastLocation
        return try {
            val offline = !isGateway
            val peersNow = router.connectedPeers.size
            val msg = router.originate(
                category = category,
                text = text?.takeIf { it.isNotBlank() },
                lat = loc?.latitude,
                lng = loc?.longitude,
                accuracy = loc?.accuracy?.toDouble(),
                people = people,
                nonCriticalHopCap = demoHopCap,
            )
            if (offline) sentTo[msg.id] = peersNow
            notifyChanged()
            SendResult.Sent(msg)
        } catch (e: SendException) {
            append("SOS not created: ${e.error.name.lowercase()}")
            if (e.error == SendError.NO_BACKEND_KEY && uploader.isOnline) uploader.refreshServerInfo()
            SendResult.Failed(e.error)
        } catch (e: Exception) {
            append("Failed to create SOS: ${e.javaClass.simpleName}")
            SendResult.Failed(SendError.ENCRYPTION_FAILED)
        }
    }

    /** Reply "ok" / "need_help" to a backend check-in: PATCH /v1/checkins/{id} when online, else a checkin_reply envelope. */
    fun answerCheckin(prompt: CheckinPrompt, response: String) {
        val viaMesh = {
            try { router.originateCheckinReply(prompt, response, nonCriticalHopCap = demoHopCap) } catch (e: SendException) { append("Check-in reply failed: ${e.error.name.lowercase()}") }
            notifyChanged()
        }
        if (!uploader.isOnline) { viaMesh(); return }
        val at = System.currentTimeMillis()
        uploader.background({ api.respondCheckin(prompt.checkinId, response, null, at) }) { r ->
            if (r is ApiResult.Ok) router.markCheckinAnswered(prompt.checkinId, response) else viaMesh()
        }
    }

    // ---- Heartbeats ----

    private fun heartbeatTick() {
        if (!config.eventActive) return
        val now = System.currentTimeMillis()
        val interval = config.heartbeatIntervalSeconds
        if (!Heartbeat.due(prefs.getLong("hbLast", 0), now, interval)) return
        val loc = lastLocation ?: return // never spin up GPS for a heartbeat
        val seq = prefs.getLong("hbSeq", 0) + 1
        val battery = batteryInfo()
        val hb = Heartbeat.create(now, loc.latitude, loc.longitude, battery?.first, battery?.second, loc.hasSpeed() && loc.speed > 1.0f, seq)
        // Optimistic bookkeeping so a slow request is not repeated every tick.
        prefs.edit().putLong("hbLast", now).putLong("hbSeq", seq).apply()
        if (uploader.isOnline) {
            uploader.background({ api.heartbeat(hb) }) { r ->
                when {
                    r is ApiResult.Ok -> {
                        prefs.edit().putBoolean("hbMesh", false).apply()
                        if (!r.value.eventActive) config.setEventActive(false)
                    }
                    r is ApiResult.Failure && r.code == 404 -> config.setEventActive(false) // no active event any more
                    else -> sendHeartbeatViaMesh(hb, loc)
                }
                notifyChanged()
            }
        } else {
            sendHeartbeatViaMesh(hb, loc)
        }
        notifyChanged()
    }

    private fun sendHeartbeatViaMesh(hb: org.json.JSONObject, loc: Location) {
        try {
            router.originateHeartbeat(Heartbeat.meshPayload(hb), com.beacon.mesh.protocol.Routing.cell(loc.latitude), com.beacon.mesh.protocol.Routing.cell(loc.longitude))
            prefs.edit().putBoolean("hbMesh", true).apply()
        } catch (e: SendException) {
            append("Heartbeat skipped: ${e.error.name.lowercase()}")
        }
    }

    /** Battery percent and charging state from the sticky broadcast (no permission, no polling). */
    private fun batteryInfo(): Pair<Int, Boolean>? {
        val i: Intent = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return (level * 100 / scale) to charging
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
        encKeyStatus = config.encryptionKeyStatus,
        signKeyStatus = config.signingKeyStatus,
        deviceId = config.deviceId,
        serverReachable = serverReachable,
        serverInfoAtMs = config.lastInfoAtMs,
        heartbeat = HeartbeatUi(config.eventActive, prefs.getLong("hbLast", 0), prefs.getBoolean("hbMesh", false), config.heartbeatIntervalSeconds),
        checkins = router.checkinPrompts.filter { it.response == null },
    )

    private fun hasValidatedInternet(): Boolean {
        val cm = connectivity ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun recordSummary(s: UploadSummary) {
        if (s.total == 0 && s.error == null) return
        lastUpload = UploadResult(s.atMs, "", s.ok, s.error ?: s.rejectReasons.keys.firstOrNull(), s)
        notifyChanged()
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
                append("No location permission; SOS cannot be created without a location")
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
        private const val INFO_REFRESH_MS = 5 * 60_000L
        private val FINAL_STATUSES = setOf("resolved", "closed", "merged")

        @Volatile private var instance: MeshNode? = null

        fun get(context: Context): MeshNode =
            instance ?: synchronized(this) { instance ?: MeshNode(context).also { instance = it } }
    }
}
