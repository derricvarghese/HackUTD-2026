package com.beacon.mesh.heartbeat

import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.Routing
import org.json.JSONObject

/** Heartbeat content (contract `HeartbeatCreate`). Location is coarsened to the ~1 km grid before it leaves the phone. */
object Heartbeat {
    /** `HeartbeatCreate`: {sent_at, approx{lat,lng,radius_m}, battery_pct?, charging?, moving?, seq}. */
    fun create(nowMs: Long, lat: Double, lng: Double, batteryPct: Int?, charging: Boolean?, moving: Boolean?, seq: Long): JSONObject =
        JSONObject().apply {
            put("sent_at", Iso.format(nowMs))
            put("approx", JSONObject().put("lat", Routing.cell(lat)).put("lng", Routing.cell(lng)).put("radius_m", 1000))
            batteryPct?.let { put("battery_pct", it.coerceIn(0, 100)) }
            charging?.let { put("charging", it) }
            moving?.let { put("moving", it) }
            put("seq", seq)
        }

    /** Plaintext `MeshPayload` for a `kind=heartbeat` envelope. */
    fun meshPayload(create: JSONObject): JSONObject = JSONObject().put("heartbeat", create)

    fun due(lastSentMs: Long, nowMs: Long, intervalSeconds: Int): Boolean =
        lastSentMs <= 0 || nowMs - lastSentMs >= intervalSeconds * 1000L
}
