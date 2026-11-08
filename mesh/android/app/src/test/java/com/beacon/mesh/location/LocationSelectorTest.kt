package com.beacon.mesh.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationSelectorTest {
    private val now = 1_800_000_000_000L
    private fun fix(p: String, acc: Float, ageMs: Long = 0, lat: Double = 32.98, lng: Double = -96.75) =
        FixInfo(p, acc, now - ageMs, lat, lng)

    @Test fun firstUsableFixWins() = assertTrue(LocationSelector.isBetter(fix("gps", 5f), null, now))

    @Test fun networkNeverOverwritesBetterGpsEvenWhenNewer() {
        val gps = fix("gps", 5f, ageMs = 10_000)
        val network = fix("network", 55f, ageMs = 0)
        assertFalse(LocationSelector.isBetter(network, gps, now))
    }

    @Test fun gpsOverwritesNetworkWhenMoreAccurate() {
        val network = fix("network", 55f, ageMs = 0)
        val gps = fix("gps", 5f, ageMs = 5_000) // older but far better
        assertTrue(LocationSelector.isBetter(gps, network, now))
    }

    @Test fun newerAndNotLessAccurateWins() {
        assertTrue(LocationSelector.isBetter(fix("network", 55f), fix("gps", 55f, ageMs = 5_000), now))
    }

    @Test fun sameProviderNewerSlightlyWorseWins() {
        assertTrue(LocationSelector.isBetter(fix("gps", 20f), fix("gps", 8f, ageMs = 4_000), now))
    }

    @Test fun sameProviderNewerButSignificantlyWorseLoses() {
        assertFalse(LocationSelector.isBetter(fix("gps", 400f), fix("gps", 8f, ageMs = 4_000), now))
    }

    @Test fun olderAndLessAccurateLoses() {
        assertFalse(LocationSelector.isBetter(fix("gps", 30f, ageMs = 20_000), fix("gps", 8f, ageMs = 4_000), now))
    }

    @Test fun staleCurrentIsReplacedEvenByWorseFix() {
        val old = fix("gps", 5f, ageMs = 3 * 60_000)
        assertTrue(LocationSelector.isBetter(fix("network", 120f), old, now))
    }

    @Test fun significantlyOlderFixIsIgnoredEvenIfMoreAccurate() {
        assertFalse(LocationSelector.isBetter(fix("gps", 3f, ageMs = 5 * 60_000), fix("network", 80f, ageMs = 1_000), now))
    }

    @Test fun invalidFixesAreRejected() {
        assertFalse(LocationSelector.isBetter(fix("gps", 0f), null, now))
        assertFalse(LocationSelector.isBetter(fix("gps", -3f), null, now))
        assertFalse(LocationSelector.isBetter(fix("gps", Float.NaN), null, now))
        assertFalse(LocationSelector.isBetter(fix("gps", 5f, lat = 0.0, lng = 0.0), null, now))
        assertFalse(LocationSelector.isBetter(fix("gps", 5f, lat = 95.0), null, now))
        assertFalse(LocationSelector.isBetter(fix("network", 500_000f), null, now))
    }

    @Test fun equalAccuracySameTimeKeepsCurrent() {
        assertFalse(LocationSelector.isBetter(fix("fused", 10f), fix("gps", 10f), now))
    }

    @Test fun fusedBeatsNetworkOfSimilarTime() {
        assertTrue(LocationSelector.isBetter(fix("fused", 13f), fix("network", 100f, ageMs = 2_000), now))
    }

    @Test fun freshness() {
        assertTrue(LocationSelector.isFresh(fix("gps", 5f, ageMs = 119_000), now))
        assertFalse(LocationSelector.isFresh(fix("gps", 5f, ageMs = 121_000), now))
    }

    @Test fun displayRounding() {
        assertEquals(8, LocationSelector.displayMeters(7.6f))
        assertEquals(1, LocationSelector.displayMeters(0.2f))
        assertEquals(15, LocationSelector.displayMeters(16.8f))
        assertEquals(55, LocationSelector.displayMeters(54.9f))
        assertEquals(95, LocationSelector.displayMeters(97f))
        assertEquals(100, LocationSelector.displayMeters(99f))
        assertEquals(130, LocationSelector.displayMeters(127f))
    }

    @Test fun sources() {
        assertEquals("gps", LocationSelector.sourceOf("gps"))
        assertEquals("fused", LocationSelector.sourceOf("fused"))
        assertEquals("other", LocationSelector.sourceOf("passive"))
    }

    @Test fun holderKeepsGpsAgainstNetworkAndExpires() {
        var t = now
        val h = BestFix<String>({ t })
        assertTrue(h.offer(fix("gps", 5f), "gps"))
        assertFalse(h.offer(fix("network", 55f), "net"))
        assertEquals("gps", h.fresh()?.second)
        t += 3 * 60_000
        assertNull(h.fresh())
        // a stale holder accepts the next usable fix
        assertTrue(h.offer(FixInfo("network", 60f, t, 32.9, -96.7), "net"))
        assertEquals("net", h.fresh()?.second)
    }
}
