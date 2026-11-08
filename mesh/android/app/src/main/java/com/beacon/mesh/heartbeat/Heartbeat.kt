package com.beacon.mesh.heartbeat

import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.Routing
import com.beacon.mesh.store.StoredMessage
import org.json.JSONArray
import org.json.JSONObject

/** Everything optional that `HeartbeatCreate` can carry besides the battery / motion fields. */
data class HeartbeatExtras(
    /** `direct` (REST) or `mesh` (wrapped in an envelope). */
    val transport: String? = null,
    /** `wifi` | `cellular` | `none` | `unknown`. */
    val network: String? = null,
    val peersNearby: Int? = null,
    /** This phone has internet and relays for others. */
    val gateway: Boolean? = null,
    /** Own unresolved SOS ids (hint for the server, max [Heartbeat.MAX_OPEN_SOS]). */
    val openSosIds: List<String> = emptyList(),
)

/**
 * Heartbeat content (contract `HeartbeatCreate`). It is the AUTOMATIC liveness beacon: no person ever presses anything for it,
 * and its absence means the phone has no connectivity. Location is coarsened to the ~1 km grid before it leaves the phone.
 */
object Heartbeat {
    const val MAX_OPEN_SOS = 20
    const val KEY_LAST = "hbLast"
    const val KEY_SEQ = "hbSeq"
    const val KEY_MESH = "hbMesh"
    private val FINAL_STATUSES = setOf("resolved", "closed", "merged")

    /** `HeartbeatCreate`: {sent_at, approx{lat,lng,radius_m}, battery_pct?, charging?, moving?, seq, transport?, network?, peers_nearby?, gateway?, open_sos_ids?}. */
    fun create(
        nowMs: Long, lat: Double, lng: Double, batteryPct: Int?, charging: Boolean?, moving: Boolean?, seq: Long,
        extras: HeartbeatExtras = HeartbeatExtras(),
    ): JSONObject =
        JSONObject().apply {
            put("sent_at", Iso.format(nowMs))
            put("approx", JSONObject().put("lat", Routing.cell(lat)).put("lng", Routing.cell(lng)).put("radius_m", 1000))
            batteryPct?.let { put("battery_pct", it.coerceIn(0, 100)) }
            charging?.let { put("charging", it) }
            moving?.let { put("moving", it) }
            put("seq", seq)
            extras.transport?.takeIf { it == "direct" || it == "mesh" }?.let { put("transport", it) }
            extras.network?.takeIf { it in NETWORKS }?.let { put("network", it) }
            extras.peersNearby?.let { put("peers_nearby", it.coerceAtLeast(0)) }
            extras.gateway?.let { put("gateway", it) }
            if (extras.openSosIds.isNotEmpty()) put("open_sos_ids", JSONArray(extras.openSosIds.distinct().take(MAX_OPEN_SOS)))
        }

    private val NETWORKS = setOf("wifi", "cellular", "none", "unknown")

    /** Plaintext `MeshPayload` for a `kind=heartbeat` envelope. */
    fun meshPayload(create: JSONObject): JSONObject = JSONObject().put("heartbeat", create)

    /** Same heartbeat, stamped with the transport it finally went over. */
    fun withTransport(hb: JSONObject, transport: String): JSONObject = JSONObject(hb.toString()).put("transport", transport)

    fun due(lastSentMs: Long, nowMs: Long, intervalSeconds: Int): Boolean =
        lastSentMs <= 0 || nowMs - lastSentMs >= intervalSeconds * 1000L

    /**
     * Whether a heartbeat goes out now. The app heartbeats whenever its mesh service runs, with or without an active event and
     * while an SOS is open (the server accepts that). [force] = connectivity just returned or an SOS was just created.
     * A heartbeat needs a coarse location; without any fix there is nothing to send.
     */
    fun shouldSend(nowMs: Long, lastSentMs: Long, intervalSeconds: Int, force: Boolean, hasLocation: Boolean): Boolean =
        hasLocation && (force || due(lastSentMs, nowMs, intervalSeconds))

    /** Own unresolved SOS ids (newest first, at most [MAX_OPEN_SOS]) created by the current identity. */
    fun openSosIds(messages: List<StoredMessage>, nowMs: Long, ownPublicKey: String): List<String> =
        messages.asSequence()
            .filter {
                it.isOwn && it.envelope.kind == "sos" && it.expiresAtMs > nowMs && it.rejectReason == null &&
                    it.remote?.status !in FINAL_STATUSES && it.envelope.senderPublicKey == ownPublicKey
            }
            .sortedByDescending { it.receivedAt }
            .map { it.id }
            .take(MAX_OPEN_SOS)
            .toList()

    /** Contract `network` value from what ConnectivityManager reported. */
    fun networkKind(hasActiveNetwork: Boolean, wifi: Boolean, cellular: Boolean, known: Boolean = true): String = when {
        !known -> "unknown"
        !hasActiveNetwork -> "none"
        wifi -> "wifi"
        cellular -> "cellular"
        else -> "unknown"
    }
}
