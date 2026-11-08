package com.beacon.mesh.location

import android.annotation.SuppressLint
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Looper
import androidx.annotation.RequiresApi

/** Platform side of location: which providers to use, how to ask for high accuracy, and how to turn a [Location] into a [FixInfo]. */
object LocationProviders {
    /** Foreground cadence while the app is on screen; background (service) is slower; warm-up is as fast as GPS allows. */
    const val FOREGROUND_MS = 3_000L
    const val BACKGROUND_MS = 15_000L
    const val WARMUP_MS = 1_000L

    fun info(l: Location): FixInfo = FixInfo(
        provider = l.provider ?: "",
        accuracyM = if (l.hasAccuracy()) l.accuracy else 0f,
        timeMs = l.time,
        lat = l.latitude,
        lng = l.longitude,
        mock = if (Build.VERSION.SDK_INT >= 31) l.isMock else false,
    )

    /**
     * Providers to listen to, best first: the platform fused provider (API 31+, what Google Maps benefits from),
     * then GPS (fine permission only), then network as the last resort. Fused already blends GPS and Wi-Fi, so network
     * is only requested when fused is absent.
     */
    fun chooseProviders(lm: LocationManager, fine: Boolean): List<String> {
        fun ok(p: String) = try { lm.isProviderEnabled(p) } catch (_: Exception) { false }
        val out = ArrayList<String>(3)
        val fused = Build.VERSION.SDK_INT >= 31 && ok(LocationManager.FUSED_PROVIDER)
        if (fused) out += LocationManager.FUSED_PROVIDER
        if (fine && ok(LocationManager.GPS_PROVIDER)) out += LocationManager.GPS_PROVIDER
        if (!fused && ok(LocationManager.NETWORK_PROVIDER)) out += LocationManager.NETWORK_PROVIDER
        return out
    }

    /** Last known locations of the providers, to seed the selector before the first update arrives. */
    @SuppressLint("MissingPermission")
    fun lastKnown(lm: LocationManager, providers: List<String>): List<Location> =
        providers.mapNotNull { p -> try { lm.getLastKnownLocation(p) } catch (_: Exception) { null } }

    /** Registers [listener] on [provider] with high accuracy where the API supports it. Throws SecurityException without permission. */
    @SuppressLint("MissingPermission")
    fun request(lm: LocationManager, provider: String, intervalMs: Long, listener: LocationListener) {
        if (Build.VERSION.SDK_INT >= 31) {
            lm.requestLocationUpdates(provider, highAccuracy(intervalMs), mainExecutor, listener)
        } else {
            lm.requestLocationUpdates(provider, intervalMs, 0f, listener, Looper.getMainLooper())
        }
    }

    private val mainExecutor = android.os.Handler(Looper.getMainLooper()).let { h -> java.util.concurrent.Executor { h.post(it) } }

    @RequiresApi(31)
    private fun highAccuracy(intervalMs: Long): LocationRequest =
        LocationRequest.Builder(intervalMs)
            .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .build()
}
