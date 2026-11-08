package com.beacon.mesh.location

import kotlin.math.abs

/** The facts about one location fix that decide whether it is trustworthy and better than another (no Android types). */
data class FixInfo(
    val provider: String,
    /** Android's `Location.accuracy`: radius in metres of the 68 % confidence circle; <= 0 means "unknown". */
    val accuracyM: Float,
    /** Wall-clock time of the fix (`Location.time`). */
    val timeMs: Long,
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val mock: Boolean = false,
)

/**
 * The classic Android "isBetterLocation" selection, as a pure function. A coarse network fix must never overwrite
 * a good GPS fix (that was the "accurate to 55 m while Google Maps shows 8 m" bug), and an old fix must not be
 * shown as current.
 */
object LocationSelector {
    const val STALE_MS = 2 * 60_000L
    const val SIGNIFICANT_LESS_ACCURATE_M = 200f
    /** Anything worse than this is a cell-tower guess, not a position worth keeping over nothing. */
    const val MAX_USEFUL_ACCURACY_M = 100_000f

    const val GPS = "gps"
    const val FUSED = "fused"
    const val NETWORK = "network"

    fun isUsable(f: FixInfo): Boolean =
        f.accuracyM.isFinite() && f.accuracyM > 0f && f.accuracyM <= MAX_USEFUL_ACCURACY_M &&
            f.lat.isFinite() && f.lng.isFinite() && abs(f.lat) <= 90.0 && abs(f.lng) <= 180.0 &&
            // (0,0) "null island" is what several providers emit before they have a position.
            !(f.lat == 0.0 && f.lng == 0.0) && f.timeMs > 0

    fun isFresh(f: FixInfo, nowMs: Long, maxAgeMs: Long = STALE_MS): Boolean = nowMs - f.timeMs <= maxAgeMs

    /** Should [new] replace [current] at wall time [nowMs]? */
    fun isBetter(new: FixInfo, current: FixInfo?, nowMs: Long): Boolean {
        if (!isUsable(new)) return false
        if (current == null) return true
        // A fix from the future (clock jump) cannot be ranked by age; trust accuracy only.
        val timeDelta = new.timeMs - current.timeMs
        val currentStale = nowMs - current.timeMs > STALE_MS
        val significantlyNewer = timeDelta > STALE_MS
        val significantlyOlder = timeDelta < -STALE_MS
        if (significantlyNewer || (currentStale && timeDelta >= 0)) return true
        if (significantlyOlder) return false

        val accuracyDelta = new.accuracyM - current.accuracyM
        val moreAccurate = accuracyDelta < 0
        val lessAccurate = accuracyDelta > 0
        val significantlyLess = accuracyDelta > SIGNIFICANT_LESS_ACCURATE_M
        val newer = timeDelta > 0
        val sameProvider = new.provider == current.provider
        return when {
            moreAccurate -> true
            newer && !lessAccurate -> true
            newer && !significantlyLess && sameProvider -> true
            else -> false
        }
    }

    /** Short user-facing source key: "gps", "fused", "network" or "other". */
    fun sourceOf(provider: String): String = when (provider) { GPS, FUSED, NETWORK -> provider; else -> "other" }

    /** Accuracy rounded for display: 3 m steps below 10 m would be false precision, so whole metres, 5 m steps up to 100 m, 10 m beyond. */
    fun displayMeters(accuracyM: Float): Int {
        val a = accuracyM.coerceAtLeast(1f)
        return when {
            a < 10f -> Math.round(a)
            a < 100f -> (Math.round(a / 5f) * 5)
            else -> (Math.round(a / 10f) * 10)
        }
    }
}

/** Keeps the best fix seen so far under [LocationSelector.isBetter]; [payload] carries the platform object. */
class BestFix<T>(private val clock: () -> Long = System::currentTimeMillis) {
    var info: FixInfo? = null; private set
    var payload: T? = null; private set

    /** True when [fix] became the current best. */
    fun offer(fix: FixInfo, p: T): Boolean {
        if (!LocationSelector.isBetter(fix, info, clock())) return false
        info = fix; payload = p
        return true
    }

    /** The best fix if it is newer than [maxAgeMs], else null ("searching for GPS"). */
    fun fresh(maxAgeMs: Long = LocationSelector.STALE_MS): Pair<FixInfo, T>? {
        val i = info ?: return null
        val p = payload ?: return null
        return if (LocationSelector.isFresh(i, clock(), maxAgeMs)) i to p else null
    }

    fun clear() { info = null; payload = null }
}
