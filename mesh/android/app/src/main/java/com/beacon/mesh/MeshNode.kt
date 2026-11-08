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
import com.beacon.mesh.heartbeat.HeartbeatExtras
import com.beacon.mesh.identity.IdentityReset
import com.beacon.mesh.identity.IdentityResetResult
import com.beacon.mesh.identity.TransportIdentity
import com.beacon.mesh.welfare.AndroidWelfareNotifier
import com.beacon.mesh.welfare.DeliveryOutcome
import com.beacon.mesh.welfare.MeshReplySender
import com.beacon.mesh.welfare.WelfareManager
import com.beacon.mesh.welfare.WelfareReplier
import com.beacon.mesh.welfare.WelfareResponse
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.net.UrlConnectionHttp
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.profile.Consent
import com.beacon.mesh.profile.KeystoreProfileStorage
import com.beacon.mesh.profile.ProfileRepository
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.ProfileStatus
import com.beacon.mesh.profile.UserProfile
import com.beacon.mesh.gateway.ProfileSync
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

/** Heartbeat state for the Mesh status screen. The heartbeat is automatic: it runs whenever the mesh service runs. */
data class HeartbeatUi(
    /** The mesh service runs, so heartbeats are being sent (no event needed). */
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
    /** Welfare check-ins held on this phone (open and recently answered); the UI filters what it needs. */
    val checkins: List<CheckinPrompt> = emptyList(),
    /** SHA-256 of this phone's signing key (hex); the first 8 chars identify the device identity before it is registered. */
    val keyFingerprint: String = "",
    /** Profile sync bookkeeping (no profile content). */
    val profile: ProfileStatus = ProfileStatus(),
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
    private val store = SqliteMessageStore(app)
    val router = MeshRouter(signer, store, config)
    /** Welfare check-ins: dedupe, persistence, notification. Safe to call from any thread. */
    val welfare = WelfareManager(
        store, AndroidWelfareNotifier(app),
        log = { line -> main.post { append(line) } }, onChange = { main.post { notifyChanged() } },
        reminderIntervalMs = { config.checkinReminderSeconds * 1000L },
    )
    private val replier = WelfareReplier(welfare, MeshReplySender { p, r -> sendMeshReply(p, r) }, log = { append(it) })
    private val replyInFlight = HashSet<String>()
    val relayId: String get() = router.relayId

    private val api = BeaconApi(
        BuildConfig.BACKEND_URL, UrlConnectionHttp(), RequestSigner(signer), config,
        Base64.getEncoder().encodeToString(signer.publicKeyDer), BuildConfig.VERSION_NAME,
    )
    /** The user's identity profile: encrypted at rest, synced by [profileSync]. */
    val profiles = ProfileRepository(KeystoreProfileStorage(app))
    private val profileSync = ProfileSync(api, profiles, config, log = { append(it) })
    private val identity = IdentityReset(
        signer, config,
        object : TransportIdentity {
            override fun regenerateInstanceId() = transport.regenerateInstanceId()
            override fun forgetPeers() = router.clearPeers()
        },
        PrefsKeyValueStore(prefs),
        cancelWelfare = { welfare.cancelAll() },
        resetProfileSync = { profiles.resetForNewDevice() },
        onNewPublicKey = { api.publicKeyB64 = it },
    )
    private var profileBusy = false
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
        router.checkinSink = { welfare.ingest(listOf(it)) }
        router.onSosResolved = { welfare.cancelForSos(it) }
        router.log = { append(it) }
        router.profileSummary = {
            val r = profiles.current
            r.profile?.let { ProfileRules.summary(it, r.profileVersion) }
        }
        profiles.onChange = { main.post { notifyChanged() } }
        uploader.sync = GatewaySync(api, router, config, log = { append(it) })
        // Own SOS created while online go straight to POST /v1/sos once; failures fall back to the mesh batch.
        // Only messages of the CURRENT device identity go out under this device's signature (not ones from before a reset).
        uploader.tryDirect = { it.isOwn && it.envelope.senderPublicKey == router.ownPublicKey && directAttempted.add(it.id) }
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
        syncProfile()
        router.pruneExpired()
        welfare.restore() // open check-ins survive process death / reboot via the database
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
     * Periodic work, driven by the foreground service (every ~30 s, also with the screen off): the automatic heartbeat, and while a
     * gateway the outbox / status / welfare check-in polling, reply retries and a /server-info refresh. Uses only the last known location.
     */
    fun tick() {
        tickCount++
        heartbeatTick()
        welfare.tickReminders() // overdue check-ins keep alerting (same notification) even when no server message arrives
        if (!uploader.isOnline) {
            retryReplies(online = false)
            return
        }
        val now = System.currentTimeMillis()
        if (now - config.lastInfoAtMs > INFO_REFRESH_MS) uploader.refreshServerInfo()
        syncProfile()
        uploader.pollOutbox()
        pollWelfare()
        retryReplies(online = true)
        if (tickCount % 2 == 0) {
            val ids = router.messages.filter { it.isOwn && it.envelope.kind in setOf("sos", "safe") && it.expiresAtMs > now && it.remote?.status !in FINAL_STATUSES }.map { it.id }
            uploader.pollStatuses(ids)
        }
        uploader.retry(router.pendingUploads())
    }

    private fun onBecameOnline() {
        uploader.refreshServerInfo { syncProfile() }
        router.internetBecameAvailable()
        uploader.pollOutbox()
        heartbeatTick(force = true) // connectivity is back: say so right away
        pollWelfare()
        retryReplies(online = true)
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
            // A new SOS: heartbeat soon so the server links this device's liveness to it (a few seconds for the upload to land first).
            main.postDelayed({ heartbeatTick(force = true) }, if (offline) 500L else 3_000L)
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

    // ---- Welfare check-ins ----

    /**
     * The person answered a welfare check-in (notification button, or in-app screen). Marks it answered locally at once
     * (removes the notification), then delivers: `PATCH /v1/checkins/{id}` when online, else a `checkin_reply` mesh envelope.
     * `no_longer_need_help` also shows the case as resolved and stops further urgency. [done] runs on the main thread when delivery
     * has been attempted.
     */
    fun answerCheckin(checkinId: String, response: String, done: () -> Unit = {}) {
        if (!WelfareResponse.isKnown(response)) { done(); return }
        val p = welfare.answer(checkinId, response)
        if (p == null) { done(); return }
        if (response == WelfareResponse.NO_LONGER_NEED_HELP && !p.isTest) {
            router.markResolvedLocally(p.sosId, app.getString(R.string.welfare_resolved_message))
            welfare.cancelForSos(p.sosId)
        }
        deliverReply(p, done)
        notifyChanged()
    }

    /** Debug: a fake check-in notification with a 20 s deadline, handled entirely on the phone (no server call). */
    fun scheduleTestCheckin() {
        welfare.ingest(listOf(WelfareManager.testPrompt(System.currentTimeMillis())))
    }

    private fun deliverReply(p: CheckinPrompt, done: () -> Unit) {
        if (p.checkinId in replyInFlight) { done(); return }
        if (p.isTest || !uploader.isOnline) {
            replier.apply(p, false, null); notifyChanged(); done(); return
        }
        replyInFlight.add(p.checkinId)
        val at = p.answeredAtMs ?: System.currentTimeMillis()
        uploader.background({ api.respondCheckin(p.checkinId, p.response.orEmpty(), null, at) }) { r ->
            replyInFlight.remove(p.checkinId)
            val outcome = replier.apply(p, true, r ?: ApiResult.Failure(null, null, "error"))
            if (outcome == DeliveryOutcome.DELIVERED || outcome == DeliveryOutcome.CLEARED) append("Check-in answer delivered")
            notifyChanged(); done()
        }
    }

    private fun sendMeshReply(p: CheckinPrompt, response: String): Boolean = try {
        router.originateCheckinReply(p, response, nonCriticalHopCap = demoHopCap); true
    } catch (e: SendException) {
        append("Check-in reply failed: ${e.error.name.lowercase()}"); false
    }

    /** Answers that did not reach the server yet: retry with backoff (online) or hand them to the mesh (offline). */
    private fun retryReplies(online: Boolean) {
        welfare.dueReplies().forEach { p ->
            if (online) deliverReply(p) {} else if (!p.meshReplied) replier.apply(p, false, null)
        }
    }

    /** GET /v1/checkins/pending: new check-ins raise the notification; ones the server dropped are cleared. */
    private fun pollWelfare() {
        uploader.pollCheckins { r ->
            if (r is ApiResult.Ok) {
                welfare.ingest(r.value)
                welfare.reconcile(r.value.map { it.checkinId }.toSet())
            }
        }
    }

    // ---- Profile ----

    /**
     * Uploads the profile (or its erasure) when online; the engine decides what is due (backoff, consent, verify).
     * Reuses the gateway's connectivity detection and IO thread. [force] ignores the backoff (manual retry).
     */
    fun syncProfile(force: Boolean = false) {
        val r = profiles.current
        if (r.profile == null && !r.pendingErase) return
        if (!uploader.isOnline || profileBusy) return
        profileBusy = true
        uploader.background({ profileSync.run(force) }) { profileBusy = false; notifyChanged() }
    }

    /** Saves the edited profile locally (encrypted) and queues it for upload. */
    fun saveProfile(profile: UserProfile, consent: Consent) {
        profiles.saveProfile(profile, consent, System.currentTimeMillis())
        syncProfile(force = true)
    }

    /** Wipes the local copy now; the server copy is erased as soon as the phone is online. */
    fun deleteProfile() {
        welfare.cancelAll() // consent withdrawn: no more check-in notifications
        profiles.eraseLocal()
        syncProfile(force = true)
    }

    fun retryProfileSync() {
        profiles.retryNow()
        if (uploader.isOnline) uploader.refreshServerInfo { syncProfile(force = true) } else notifyChanged()
    }

    fun acceptProfileConsent(consent: Consent) {
        profiles.acceptConsent(consent)
        syncProfile(force = true)
    }

    /** Onboarding: fetch the latest `profile_required` / consent version if we can reach the server. */
    fun refreshServerInfo() { if (uploader.isOnline) uploader.refreshServerInfo() }

    // ---- Heartbeats (automatic liveness; nobody ever presses anything) ----

    /**
     * Sends the heartbeat when it is due: every `heartbeat_interval_seconds` (cached /server-info, default 300) for as long as the mesh
     * service runs, with or without an active event and while an SOS is open. [force] sends now (connectivity returned, SOS created).
     */
    private fun heartbeatTick(force: Boolean = false) {
        val now = System.currentTimeMillis()
        val loc = lastLocation // never spin up GPS for a heartbeat
        if (!Heartbeat.shouldSend(now, prefs.getLong(Heartbeat.KEY_LAST, 0), config.heartbeatIntervalSeconds, force, loc != null) || loc == null) return
        val seq = prefs.getLong(Heartbeat.KEY_SEQ, 0) + 1
        val battery = batteryInfo()
        val online = uploader.isOnline
        val extras = HeartbeatExtras(
            transport = if (online) "direct" else "mesh", network = networkKind(), peersNearby = router.connectedPeers.size,
            gateway = online, openSosIds = Heartbeat.openSosIds(router.messages, now, router.ownPublicKey),
        )
        val hb = Heartbeat.create(now, loc.latitude, loc.longitude, battery?.first, battery?.second, loc.hasSpeed() && loc.speed > 1.0f, seq, extras)
        // Optimistic bookkeeping so a slow request is not repeated every tick.
        prefs.edit().putLong(Heartbeat.KEY_LAST, now).putLong(Heartbeat.KEY_SEQ, seq).apply()
        if (online) {
            uploader.background({ api.heartbeat(hb, now) }) { r ->
                when {
                    r is ApiResult.Ok -> {
                        prefs.edit().putBoolean(Heartbeat.KEY_MESH, false).apply()
                        welfare.ingest(r.value.pendingCheckins)
                    }
                    // 404: neither an active event nor an open SOS for this device; 429: slow down. Nothing to relay either way.
                    r is ApiResult.Failure && (r.code == 404 || r.code == 429) -> Unit
                    else -> sendHeartbeatViaMesh(Heartbeat.withTransport(hb, "mesh"), loc)
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
            prefs.edit().putBoolean(Heartbeat.KEY_MESH, true).apply()
        } catch (e: SendException) {
            append("Heartbeat skipped: ${e.error.name.lowercase()}")
        }
    }

    private fun networkKind(): String {
        val cm = connectivity ?: return Heartbeat.networkKind(false, false, false, known = false)
        val net = cm.activeNetwork
        val caps = net?.let { cm.getNetworkCapabilities(it) }
        return Heartbeat.networkKind(
            net != null && caps != null,
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true,
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true,
        )
    }

    // ---- Demo: new identity ----

    /**
     * Debug: become a new device for the server (see [IdentityReset]). Held messages and the profile are kept; the profile is
     * uploaded again for the new device as soon as the phone is online.
     */
    fun resetIdentity(): IdentityResetResult {
        val result = identity.reset()
        append("Device identity reset")
        notifyChanged()
        if (uploader.isOnline) {
            uploader.refreshServerInfo { syncProfile(force = true) }
            heartbeatTick(force = true)
        }
        return result
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
        heartbeat = HeartbeatUi(started, prefs.getLong(Heartbeat.KEY_LAST, 0), prefs.getBoolean(Heartbeat.KEY_MESH, false), config.heartbeatIntervalSeconds),
        checkins = welfare.all(),
        keyFingerprint = IdentityReset.fingerprint(signer.publicKeyDer),
        profile = ProfileStatus.of(profiles.current, config.profileRequired, config.profileConsentVersion)
            .copy(bannerDismissed = profiles.bannerDismissedThisSession),
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
