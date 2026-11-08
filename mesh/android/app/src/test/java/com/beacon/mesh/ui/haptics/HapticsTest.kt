package com.beacon.mesh.ui.haptics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class Fake : HapticBackend {
    val played = mutableListOf<HapticEffect>()
    override fun perform(effect: HapticEffect) { played += effect }
}

class HapticsTest {
    private var now = 1_000L
    private val backend = Fake()
    private var on = true
    private val haptics = Haptics(backend, { on }, { now })

    @Test fun everyEventHasAnEffect() {
        HapticEvent.entries.forEach { HapticMapping.effectFor(it) }
    }

    @Test fun mappingKeyEvents() {
        assertEquals(HapticEffect.Platform(PlatformKind.ToggleOn), HapticMapping.effectFor(HapticEvent.ToggleOn))
        assertEquals(HapticEffect.Platform(PlatformKind.ToggleOff), HapticMapping.effectFor(HapticEvent.ToggleOff))
        assertEquals(HapticEffect.Platform(PlatformKind.SegmentTick), HapticMapping.effectFor(HapticEvent.Select))
        assertEquals(HapticEffect.Custom(CustomPattern.Success), HapticMapping.effectFor(HapticEvent.Success))
        assertEquals(HapticEffect.Custom(CustomPattern.Error), HapticMapping.effectFor(HapticEvent.Error))
    }

    @Test fun successAndErrorAreDistinct() {
        assertTrue(HapticMapping.effectFor(HapticEvent.Success) != HapticMapping.effectFor(HapticEvent.Error))
        val s = HapticPatterns.of(CustomPattern.Success)
        val e = HapticPatterns.of(CustomPattern.Error)
        assertTrue(s.primitives.map { it.id } != e.primitives.map { it.id })
    }

    @Test fun waveformsAreWellFormedAndShort() {
        CustomPattern.entries.forEach {
            val p = HapticPatterns.of(it)
            assertEquals(p.timings.size, p.amplitudes.size)
            assertTrue(p.timings.sum() < 300)
            assertTrue(p.primitives.isNotEmpty())
        }
    }

    @Test fun disabledPlaysNothing() {
        on = false
        HapticEvent.entries.forEach { assertFalse(haptics.perform(it)); now += 100 }
        assertTrue(backend.played.isEmpty())
    }

    @Test fun reEnablingWorksImmediately() {
        on = false
        haptics.perform(HapticEvent.Tap)
        on = true
        assertTrue(haptics.perform(HapticEvent.Tap))
        assertEquals(1, backend.played.size)
    }

    @Test fun doubleFireWithinGapIsDropped() {
        assertTrue(haptics.perform(HapticEvent.Tap))
        now += 10
        assertFalse(haptics.perform(HapticEvent.ToggleOn))
        now += Haptics.MIN_GAP_MS
        assertTrue(haptics.perform(HapticEvent.LightTap))
        assertEquals(2, backend.played.size)
    }

    @Test fun resultsAreNotSwallowedByAPrecedingTap() {
        haptics.perform(HapticEvent.Tap)
        now += 5
        assertTrue(haptics.perform(HapticEvent.Success))
        assertEquals(2, backend.played.size)
    }

    @Test fun ticksAreRateLimited() {
        var played = 0
        repeat(100) {
            if (haptics.perform(HapticEvent.Tick)) played++
            now += 5
        }
        // 500 ms of 5 ms updates with a 45 ms gap: roughly 11 ticks, never 100.
        assertTrue("played $played", played in 8..13)
    }

    @Test fun frequentTicksAllowedMoreOftenThanTicks() {
        var ticks = 0
        var frequent = 0
        repeat(100) {
            if (haptics.perform(HapticEvent.Tick)) ticks++
            now += 1000
        }
        now = 1_000_000
        val h2 = Haptics(backend, { true }, { now })
        repeat(100) {
            if (h2.perform(HapticEvent.FrequentTick)) frequent++
            now += 30
        }
        assertEquals(100, ticks)
        assertEquals(100, frequent)
        assertEquals(Haptics.FREQUENT_TICK_GAP_MS < Haptics.TICK_GAP_MS, true)
    }

    @Test fun helpersFireOnceThenRunAction() {
        var ran = 0
        haptics.onClick { ran++ }()
        assertEquals(1, ran)
        assertEquals(1, backend.played.size)
        now += 100
        var last: Boolean? = null
        haptics.onToggle { last = it }(false)
        assertEquals(false, last)
        assertEquals(HapticEffect.Platform(PlatformKind.ToggleOff), backend.played.last())
    }

    @Test fun nestedSwitchInClickableRowBuzzesOnce() {
        // Row click and Switch change arrive in the same frame.
        haptics.perform(HapticEvent.Tap)
        haptics.toggle(true)
        assertEquals(1, backend.played.size)
    }

    @Test fun detentTickerOnlyTicksOnChange() {
        val t = DetentTicker(haptics)
        t.onValue(3)                         // first value: no tick
        repeat(10) { t.onValue(3); now += 100 }
        assertEquals(0, backend.played.size)
        now += 100
        t.onValue(4)
        assertEquals(1, backend.played.size)
        t.reset(9)                           // programmatic change: silent
        t.onValue(9)
        assertEquals(1, backend.played.size)
    }
}
