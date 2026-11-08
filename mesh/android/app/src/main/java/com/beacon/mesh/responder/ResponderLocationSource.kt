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
        val l = object : LocationListener {
            override fun onLocationChanged(location: Location) { onFix(location.latitude, location.longitude) }
            @Deprecated("Deprecated in API 29") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
        }
        // Approximate-only grants cannot use GPS; the network provider still works.
        val providers = buildList {
            if (hasFine()) add(LocationManager.GPS_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
        }
        var any = false
        for (p in providers) {
            try {
                if (lm.isProviderEnabled(p)) { lm.requestLocationUpdates(p, INTERVAL_MS, 0f, l, Looper.getMainLooper()); any = true }
            } catch (_: SecurityException) { } catch (_: IllegalArgumentException) { }
        }
        if (any) listener = l
        return any
    }

    fun stop() {
        listener?.let { runCatching { lm.removeUpdates(it) } }
        listener = null
    }

    private companion object { const val INTERVAL_MS = 10_000L }
}
