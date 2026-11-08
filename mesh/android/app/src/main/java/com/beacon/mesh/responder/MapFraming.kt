package com.beacon.mesh.responder

import kotlin.math.cos

/** Where the map camera should look: a box in degrees, plus the zoom ceiling for a "fit". Pure so it is unit-testable. */
data class FrameBox(val north: Double, val south: Double, val east: Double, val west: Double)

object MapFraming {
    /** A single case is framed at roughly street / neighbourhood level, never closer. */
    const val MIN_HALF_SPAN_M = 600.0
    /** Approximate circles can be ~1 km; they must not dominate the framing. */
    const val MAX_CIRCLE_CONTEXT_M = 450.0
    /** The fit never zooms in further than this, however tight the targets are. */
    const val MAX_FIT_ZOOM = 16.0
    const val PADDING_DP = 56

    /** Box around all target centres with context; null when there is nothing to frame. */
    fun frame(targets: List<MapTarget>): FrameBox? {
        if (targets.isEmpty()) return null
        var n = -90.0; var s = 90.0; var e = -180.0; var w = 180.0
        for (t in targets) {
            val r = (if (t.exact) 200.0 else minOf(t.radiusM, MAX_CIRCLE_CONTEXT_M)).coerceAtLeast(150.0)
            val dLat = r / 111_320.0
            val dLng = r / (111_320.0 * cos(Math.toRadians(t.lat)).coerceAtLeast(0.1))
            n = maxOf(n, t.lat + dLat); s = minOf(s, t.lat - dLat)
            e = maxOf(e, t.lng + dLng); w = minOf(w, t.lng - dLng)
        }
        // Minimum span so one or two nearby cases keep their surroundings.
        val midLat = (n + s) / 2; val midLng = (e + w) / 2
        val minLat = MIN_HALF_SPAN_M / 111_320.0
        val minLng = MIN_HALF_SPAN_M / (111_320.0 * cos(Math.toRadians(midLat)).coerceAtLeast(0.1))
        if ((n - s) / 2 < minLat) { n = midLat + minLat; s = midLat - minLat }
        if ((e - w) / 2 < minLng) { e = midLng + minLng; w = midLng - minLng }
        return FrameBox(n.coerceAtMost(85.0), s.coerceAtLeast(-85.0), e.coerceAtMost(180.0), w.coerceAtLeast(-180.0))
    }
}
