package com.beacon.mesh.ui.haptics

/** Plays an effect on the device. Faked in unit tests. */
fun interface HapticBackend {
    fun perform(effect: HapticEffect)
}

/**
 * The one place every haptic in the app goes through.
 *
 * - [enabled] is the Settings master switch; when false nothing plays at all.
 * - Rate limiting: ticks are throttled per kind, and any non-urgent event within [MIN_GAP_MS] of the
 *   previous one is dropped, so a tap that also navigates (or a Switch inside a clickable row) buzzes once.
 *   Results (success, error, warning, sheet and gesture events) are never dropped by the shared gap.
 */
class Haptics(
    private val backend: HapticBackend,
    private val enabled: () -> Boolean = { true },
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private var lastAny = NEVER
    private var lastTick = NEVER
    private var lastFrequentTick = NEVER

    val isEnabled: Boolean get() = enabled()

    /** Returns true if something was played. */
    fun perform(event: HapticEvent): Boolean {
        if (!enabled()) return false
        val now = nowMs()
        when (event) {
            HapticEvent.Tick -> {
                if (lastTick != NEVER && now - lastTick < TICK_GAP_MS) return false
                lastTick = now
            }
            HapticEvent.FrequentTick -> {
                if (lastFrequentTick != NEVER && now - lastFrequentTick < FREQUENT_TICK_GAP_MS) return false
                lastFrequentTick = now
            }
            else -> Unit
        }
        if (event !in URGENT && lastAny != NEVER && now - lastAny < MIN_GAP_MS) return false
        lastAny = now
        backend.perform(HapticMapping.effectFor(event))
        return true
    }

    fun toggle(on: Boolean) = perform(if (on) HapticEvent.ToggleOn else HapticEvent.ToggleOff)

    // ---- Helpers that wrap a callback, so Material components stay unmodified ----

    /** `Button(onClick = haptics.onClick { ... })`. Pass [event] for non-default feel. */
    fun onClick(event: HapticEvent = HapticEvent.Tap, action: () -> Unit): () -> Unit = {
        perform(event)
        action()
    }

    fun onLightClick(action: () -> Unit): () -> Unit = onClick(HapticEvent.LightTap, action)

    /** `Switch` / `Checkbox` / `ToggleButton`: plays toggle-on or toggle-off from the new value. */
    fun onToggle(action: (Boolean) -> Unit): (Boolean) -> Unit = { on ->
        toggle(on)
        action(on)
    }

    /** Choice controls (chips, segmented buttons, radios). */
    fun onSelect(action: () -> Unit): () -> Unit = onClick(HapticEvent.Select, action)

    companion object {
        const val MIN_GAP_MS = 30L
        const val TICK_GAP_MS = 45L
        const val FREQUENT_TICK_GAP_MS = 25L
        private const val NEVER = Long.MIN_VALUE
        private val URGENT = setOf(
            HapticEvent.Success, HapticEvent.Error, HapticEvent.Warning,
            HapticEvent.SheetOpen, HapticEvent.SheetDismiss, HapticEvent.GestureCommit,
        )

        /** Used by previews and tests that have no [LocalHaptics] provider. */
        val None = Haptics({ }, { false })
    }
}

/**
 * Emits [HapticEvent.Tick] only when a value crosses into a different detent, never while it stays
 * put, so a slider or drag cannot spam the motor. Programmatic changes should use [reset].
 */
class DetentTicker(private val haptics: Haptics, private val event: HapticEvent = HapticEvent.Tick) {
    private var last: Int? = null

    fun reset(value: Int? = null) { last = value }

    fun onValue(detent: Int) {
        val prev = last
        last = detent
        if (prev != null && prev != detent) haptics.perform(event)
    }
}
