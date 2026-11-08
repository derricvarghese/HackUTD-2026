package com.beacon.mesh

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import com.beacon.mesh.crypto.KeystoreSigner
import com.beacon.mesh.gateway.GatewayUploader
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.store.SqliteMessageStore
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.transport.BleMeshTransport
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
        router.upload = { uploader.upload(it) }
        router.onChange = { notifyChanged() }
        router.log = { append(it) }
        uploader.forceOffline = forceOffline
        uploader.backendUrl = backendUrl
        uploader.onOnline = { notifyChanged(); router.internetBecameAvailable() }
        uploader.onUploaded = { router.markUploaded(it) }
        uploader.log = { append(it) }
        transport.listener = this
    }

    /** Call after Bluetooth + location permissions are granted. Safe to call repeatedly. */
    fun start() {
        if (started) {
            transport.start() // retries if Bluetooth was off the first time
            return
        }
        started = true
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
            router.originate(
                category = category,
                text = text?.takeIf { it.isNotBlank() },
                lat = loc?.latitude,
                lng = loc?.longitude,
                accuracy = loc?.accuracy?.toDouble(),
                people = people,
                nonCriticalHopCap = demoHopCap,
            )
        } catch (e: Exception) {
            append("Failed to create SOS: ${e.message}")
            null
        }
    }

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    private fun notifyChanged() {
        listeners.toList().forEach { it() }
    }

    private fun append(line: String) {
        val ts = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logLines.addFirst("$ts $line")
        while (logLines.size > 200) logLines.removeLast()
        notifyChanged()
    }

    private fun startLocation() {
        val lm = locationManager ?: return
        val listener = LocationListener { lastLocation = it }
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
        @Volatile private var instance: MeshNode? = null

        fun get(context: Context): MeshNode =
            instance ?: synchronized(this) { instance ?: MeshNode(context).also { instance = it } }
    }
}
