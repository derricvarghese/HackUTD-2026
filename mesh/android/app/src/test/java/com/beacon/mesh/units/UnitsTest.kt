package com.beacon.mesh.units

import com.beacon.mesh.ui.logic.HeightInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class UnitsTest {
    private val us = Locale.US
    private val de = Locale.GERMANY
    private val M = UnitSystem.METRIC
    private val I = UnitSystem.IMPERIAL

    @Test fun automaticFollowsTheRegion() {
        for (c in listOf("US", "LR", "MM")) assertEquals(c, I, UnitPreference.AUTOMATIC.resolve(Locale("en", c)))
        for (c in listOf("GB", "DE", "CA", "AU", "FR", "")) assertEquals(c, M, UnitPreference.AUTOMATIC.resolve(Locale("en", c)))
        assertEquals(I, UnitPreference.IMPERIAL.resolve(Locale.GERMANY))
        assertEquals(M, UnitPreference.METRIC.resolve(Locale.US))
    }

    @Test fun heightConversionsAndEdges() {
        assertEquals(FeetInches(1, 0), Units.cmToFeetInches(30))
        assertEquals(FeetInches(8, 6), Units.cmToFeetInches(260))
        assertEquals(FeetInches(5, 10), Units.cmToFeetInches(178))
        assertEquals(FeetInches(6, 0), Units.cmToFeetInches(183))
        assertEquals(178, Units.feetInchesToCm(5, 10))
        assertEquals(30, Units.feetInchesToCm(1, 0))
        assertEquals(259, Units.feetInchesToCm(8, 6))
    }

    @Test fun everyCentimetreMapsIntoTheFeetInchesBoxes() {
        for (cm in 30..260) {
            val fi = Units.cmToFeetInches(cm)
            assertTrue("$cm -> $fi", fi.feet in 1..8 && fi.inches in 0..11)
            assertTrue("$cm back out of range", Units.feetInchesToCm(fi.feet, fi.inches) in 30..260)
            // The inch-rounded value is within half an inch of the original.
            assertTrue(Math.abs(Units.feetInchesToCm(fi.feet, fi.inches) - cm) <= 2)
        }
    }

    @Test fun feetInchesRoundTripIsStableAndNeverDrifts() {
        for (total in 12..102) {
            val fi = FeetInches(total / 12, total % 12)
            val cm = Units.feetInchesToCm(fi.feet, fi.inches)
            assertEquals("$fi", fi, Units.cmToFeetInches(cm))
            // cm -> ft/in -> cm -> ft/in -> cm is a fixed point after the first step.
            val again = Units.feetInchesToCm(Units.cmToFeetInches(cm).feet, Units.cmToFeetInches(cm).inches)
            assertEquals(cm, again)
        }
    }

    @Test fun parseHeightValidation() {
        assertEquals(178, Units.parseHeightFeetInches("5", "10"))
        assertEquals(152, Units.parseHeightFeetInches("5", ""))
        assertNull(Units.parseHeightFeetInches("", "10"))
        assertNull(Units.parseHeightFeetInches("0", "11"))
        assertNull(Units.parseHeightFeetInches("9", "0"))
        assertNull(Units.parseHeightFeetInches("5", "12"))
        assertNull(Units.parseHeightFeetInches("8", "11"))          // 272 cm
        assertEquals(30, Units.parseHeightFeetInches("1", "0"))
        assertEquals(259, Units.parseHeightFeetInches("8", "6"))
        assertEquals(30, Units.parseHeightCm("30")); assertEquals(260, Units.parseHeightCm("260"))
        assertNull(Units.parseHeightCm("29")); assertNull(Units.parseHeightCm("261")); assertNull(Units.parseHeightCm("abc"))
    }

    @Test fun formatHeight() {
        assertEquals("178 cm", Units.formatHeight(178, M, us))
        assertEquals("5 ft 10 in", Units.formatHeight(178, I, us))
        assertEquals("1 ft 0 in", Units.formatHeight(30, I, us))
    }

    @Test fun heightInputGlue() {
        assertEquals("5" to "10", HeightInput.fromCm("178"))
        assertEquals("" to "", HeightInput.fromCm(""))
        assertEquals("178", HeightInput.toCm("5", "10"))
        assertEquals("", HeightInput.toCm("", ""))
        assertEquals("0", HeightInput.toCm("5", "12"))   // invalid but non blank: rejected later by the profile rules (30..260)
        assertEquals("0", HeightInput.toCm("", "7"))
    }

    @Test fun metricDistances() {
        assertEquals("5 m", Units.formatDistance(5.0, M, us))
        assertEquals("999 m", Units.formatDistance(999.0, M, us))
        assertEquals("1 km", Units.formatDistance(1000.0, M, us))
        assertEquals("1 km", Units.formatDistance(999.6, M, us))
        assertEquals("1.5 km", Units.formatDistance(1540.0, M, us))
        assertEquals("1,5 km", Units.formatDistance(1540.0, M, de))
        assertEquals("0 m", Units.formatDistance(-3.0, M, us))
    }

    @Test fun imperialDistances() {
        assertEquals("16 ft", Units.formatDistance(5.0, I, us))
        assertEquals("527 ft", Units.formatDistance(160.6, I, us))      // just under 0.1 mi
        assertEquals("0.1 mi", Units.formatDistance(161.0, I, us))      // 528.2 ft
        assertEquals("0.6 mi", Units.formatDistance(1000.0, I, us))
        assertEquals("1 mi", Units.formatDistance(1609.344, I, us))
        assertEquals("6,2 mi".replace(',', '.'), Units.formatDistance(10_000.0, I, us))
        assertEquals("0,6 mi", Units.formatDistance(1000.0, I, de))
    }

    @Test fun accuracyHasNoFalsePrecision() {
        assertEquals("5 m", Units.formatAccuracy(5.2, M, us))
        assertEquals("1 m", Units.formatAccuracy(0.0, M, us))
        assertEquals("10 m", Units.formatAccuracy(9.6, M, us))
        assertEquals("55 m", Units.formatAccuracy(54.0, M, us))
        assertEquals("130 m", Units.formatAccuracy(126.0, M, us))
        assertEquals("1.2 km", Units.formatAccuracy(1234.0, M, us))
        assertEquals("16 ft", Units.formatAccuracy(5.0, I, us))
        assertEquals("30 ft", Units.formatAccuracy(9.0, I, us))          // 29.5 ft -> 30
        assertEquals("180 ft", Units.formatAccuracy(55.0, I, us))        // 180.4 ft -> 5 ft steps
        assertEquals("420 ft", Units.formatAccuracy(128.0, I, us))       // 419.9 -> 10 ft steps
        assertEquals("0.6 mi", Units.formatAccuracy(1000.0, I, us))
    }

    @Test fun measureCarriesUnitAndDecimalsForSpokenForms() {
        val m = Units.accuracy(5.0, I)
        assertEquals(LengthUnit.FOOT, m.unit); assertEquals(16.0, m.value, 0.0)
        assertEquals("0.6", Units.distance(1000.0, I).numberText(us))
    }
}
