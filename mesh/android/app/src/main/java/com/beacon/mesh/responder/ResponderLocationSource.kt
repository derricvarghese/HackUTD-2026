package com.beacon.mesh.responder

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat

/** Fixed-interval foreground updates from the platform LocationManager (no Play services, no background location). */
class ResponderLocationSource(context: Context) {
    private val app = context.applicationContext
    private val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var listener: LocationListener? = null

    fun hasFine() = granted(Manifest.permission.ACCESS_FINE_LOCATION)
    fun hasCoarse() = granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    private fun granted(p: String) = ContextCompat.checkSelfPermission(app, p) == PackageManager.PERMISSION_GRANTED

    /** Returns false when no permission or no provider is available. */
    @SuppressLint("MissingPermission")
    fun start(onFix: (lat: Double, lng: Double) -> Unit): Boolean {
        stop()
        if (!hasFine() && !hasCoarse()) return false
        val best = com.beacon.mesh.location.BestFix<Location>()
        // Only a fix that beats the current one is shared: a coarse network fix never replaces a good GPS fix.
        fun offer(location: Location) {
            if (best.offer(com.beacon.mesh.location.LocationProviders.info(location), location)) onFix(location.latitude, location.longitude)
        }
        val l = LocationListener { offer(it) }
        // Same provider logic as the mesh node: fused (API 31+), then GPS (fine permission only), then network.
        val providers = com.beacon.mesh.location.LocationProviders.chooseProviders(lm, hasFine())
        var any = false
        try {
            for (loc in com.beacon.mesh.location.LocationProviders.lastKnown(lm, providers)) {
                offer(loc)
            }
            for (p in providers) {
                try { com.beacon.mesh.location.LocationProviders.request(lm, p, INTERVAL_MS, l); any = true } catch (_: IllegalArgumentException) { }
            }
        } catch (_: SecurityException) { }
        if (any) listener = l
        return any
    }

    fun stop() {
        listener?.let { runCatching { lm.removeUpdates(it) } }
        listener = null
    }

    private companion object { const val INTERVAL_MS = 5_000L }
}
