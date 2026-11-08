package com.beacon.mesh.responder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapFramingTest {
    private fun t(lat: Double, lng: Double, r: Double, exact: Boolean) =
        MapTarget("x", MapTarget.Source.SERVER, PinTone.NORMAL, "t", lat, lng, r, exact, false, false)

    @Test fun emptyHasNoFrame() = assertNull(MapFraming.frame(emptyList()))

    @Test fun singleExactCaseGetsMinimumSpan() {
        val f = MapFraming.frame(listOf(t(32.98, -96.75, 20.0, true)))!!
        val halfLatM = (f.north - f.south) / 2 * 111_320.0
        assertEquals(MapFraming.MIN_HALF_SPAN_M, halfLatM, 1.0)
    }

    @Test fun hugeApproximateCircleDoesNotDominate() {
        val f = MapFraming.frame(listOf(t(32.98, -96.75, 5000.0, false)))!!
        val halfLatM = (f.north - f.south) / 2 * 111_320.0
        assertTrue(halfLatM <= 700.0)
    }

    @Test fun farApartTargetsAreAllInside() {
        val f = MapFraming.frame(listOf(t(32.9, -96.8, 30.0, true), t(33.1, -96.5, 30.0, true)))!!
        assertTrue(f.north >= 33.1 && f.south <= 32.9 && f.east >= -96.5 && f.west <= -96.8)
    }
}
