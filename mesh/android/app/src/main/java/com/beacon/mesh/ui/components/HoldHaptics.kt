package com.beacon.mesh.ui.components

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Haptics for the hold-to-send button: a vibration that builds in intensity for as long as the
 * finger is down, then a sharp "pop" when the alert is sent.
 *
 * - Devices with amplitude control get a smooth ramp (a waveform whose amplitude follows an ease-in
 *   curve, so it stays gentle early and swells near the end).
 * - Devices without it get pulses that get longer and closer together, which reads as the same
 *   build-up.
 * - The pop uses the richer composition primitives (a THUD plus a CLICK) when the hardware has them.
 */
class HoldHaptics(context: Context, private val enabled: () -> Boolean = { true }) {
    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }

    private val canVibrate get() = enabled() && vibrator?.hasVibrator() == true

    /** Starts the build-up; call [cancel] if the finger lifts before [durationMs] elapses. */
    fun startRamp(durationMs: Long) {
        val v = vibrator?.takeIf { canVibrate } ?: return
        v.cancel()
        val effect = if (v.hasAmplitudeControl()) smoothRamp(durationMs) else pulseRamp(durationMs)
        v.vibrate(effect)
    }

    /** The release: a heavy thud followed by a crisp click, or one strong buzz as a fallback. */
    fun pop() {
        val v = vibrator?.takeIf { canVibrate } ?: return
        v.cancel()
        val effect = if (
            Build.VERSION.SDK_INT >= 30 &&
            v.areAllPrimitivesSupported(
                VibrationEffect.Composition.PRIMITIVE_THUD,
                VibrationEffect.Composition.PRIMITIVE_CLICK,
            )
        ) {
            VibrationEffect.startComposition()
                .addPrimitive(VibrationEffect.Composition.PRIMITIVE_THUD, 1f)
                .addPrimitive(VibrationEffect.Composition.PRIMITIVE_CLICK, 1f, 40)
                .compose()
        } else if (v.hasAmplitudeControl()) {
            VibrationEffect.createWaveform(longArrayOf(0, 18, 24, 50), intArrayOf(0, 255, 0, 255), -1)
        } else {
            VibrationEffect.createOneShot(70, VibrationEffect.DEFAULT_AMPLITUDE)
        }
        v.vibrate(effect)
    }

    fun cancel() {
        vibrator?.cancel()
    }

    private fun smoothRamp(durationMs: Long): VibrationEffect {
        val steps = (durationMs / STEP_MS).toInt().coerceAtLeast(2)
        val timings = LongArray(steps) { STEP_MS }
        val amplitudes = IntArray(steps) { i ->
            val t = (i + 1).toFloat() / steps
            // Ease-in: barely there at first, strong at the end.
            (MIN_AMPLITUDE + (255 - MIN_AMPLITUDE) * t.pow(2.2f)).roundToInt().coerceIn(1, 255)
        }
        return VibrationEffect.createWaveform(timings, amplitudes, -1)
    }

    private fun pulseRamp(durationMs: Long): VibrationEffect {
        // Pulses grow from 10 ms to 60 ms while the gap between them shrinks from 120 ms to 15 ms.
        val timings = ArrayList<Long>()
        timings += 0L
        var elapsed = 0L
        while (elapsed < durationMs) {
            val t = (elapsed.toFloat() / durationMs).coerceIn(0f, 1f)
            val on = (10 + 50 * t).toLong()
            val off = (120 - 105 * t).toLong()
            timings += on
            timings += off
            elapsed += on + off
        }
        if (timings.size % 2 == 1) timings += 1L
        return VibrationEffect.createWaveform(timings.toLongArray(), -1)
    }

    private companion object {
        const val STEP_MS = 20L
        const val MIN_AMPLITUDE = 18
    }
}
