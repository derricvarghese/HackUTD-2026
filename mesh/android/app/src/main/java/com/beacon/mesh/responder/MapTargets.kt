package com.beacon.mesh.responder

import com.beacon.mesh.store.StoredMessage

/** Something drawn on the responder map: a server case, or an SOS this phone heard over Bluetooth that no server has yet. */
data class MapTarget(
    val id: String,
    val source: Source,
    val tone: PinTone,
    val title: String,
    val lat: Double,
    val lng: Double,
    val radiusM: Double,
    val exact: Boolean,
    val mine: Boolean,
    /** Silent or unresponsive: drawn with a pulsing ring. */
    val attention: Boolean,
    /** App category wire name (trapped, injured, ...) for the pin glyph; null when unknown. */
    val category: String? = null,
) {
    enum class Source { SERVER, MESH }
}

object MapTargets {
    const val MESH_PREFIX = "mesh-"

    fun fromCase(c: ResponderCase, title: String, account: ResponderAccount?) = MapTarget(
        id = c.id, source = MapTarget.Source.SERVER, tone = CaseRules.tone(c), title = title,
        lat = c.lat, lng = c.lng, radiusM = CaseRules.mapRadiusM(c), exact = c.hasExactLocation,
        mine = c.isMine(account), attention = c.needsAttention, category = com.beacon.mesh.ui.responder.appCategory(c.category),
    )

    /**
     * SOS messages this phone heard over Bluetooth that are still live and not yet known to the server.
     * Their exact position is encrypted for the server, so only the ~1 km routing cell is readable.
     */
    fun fromMesh(messages: List<StoredMessage>, serverIds: Set<String>, nowMs: Long, title: (category: String?) -> String): List<MapTarget> =
        messages.mapNotNull { m ->
            val e = m.envelope
            if (m.isOwn || e.kind != "sos" || e.expiresAtMs <= nowMs || m.id in serverIds) return@mapNotNull null
            val approx = e.routing.optJSONObject("approx") ?: return@mapNotNull null
            if (!approx.has("lat") || !approx.has("lng")) return@mapNotNull null
            MapTarget(
                id = MESH_PREFIX + m.id, source = MapTarget.Source.MESH, tone = tonePriority(e.category),
                title = title(e.category), lat = approx.getDouble("lat"), lng = approx.getDouble("lng"),
                radiusM = approx.optDouble("radius_m", 1000.0), exact = false, mine = false, attention = false, category = e.category,
            )
        }

    private fun tonePriority(wire: String?): PinTone = when (wire) {
        "trapped", "injured", "medical" -> PinTone.CRITICAL
        "water_meds" -> PinTone.HIGH
        "safe" -> PinTone.SAFE
        else -> PinTone.NORMAL
    }
}
