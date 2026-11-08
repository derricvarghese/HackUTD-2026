package com.beacon.mesh.ui.haptics

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType

/**
 * Platform effects go through Compose's [HapticFeedback] (view.performHapticFeedback), so they follow
 * the system "touch feedback" setting. Custom patterns use the [Vibrator] directly; they check that
 * same system setting themselves. The app-level switch is applied earlier, in [Haptics].
 */
class AndroidHapticBackend(
    private val context: Context,
    private val platform: HapticFeedback,
) : HapticBackend {
    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }

    override fun perform(effect: HapticEffect) {
        when (effect) {
            is HapticEffect.Platform -> platform.performHapticFeedback(effect.kind.toCompose())
            is HapticEffect.Custom -> playCustom(effect.pattern)
        }
    }

    private fun systemTouchFeedbackOn() =
        Settings.System.getInt(context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0

    private fun playCustom(pattern: CustomPattern) {
        val v = vibrator?.takeIf { it.hasVibrator() } ?: return
        if (!systemTouchFeedbackOn()) return
        val spec = HapticPatterns.of(pattern)
        val effect = composition(v, spec) ?: waveform(v, spec)
        v.vibrate(effect)
    }

    @SuppressLint("WrongConstant") // ids are always VibrationEffect.Composition.PRIMITIVE_* (see HapticPatterns)
    private fun composition(v: Vibrator, spec: PatternSpec): VibrationEffect? {
        if (Build.VERSION.SDK_INT < 30) return null
        if (!v.areAllPrimitivesSupported(*spec.primitives.map { it.id }.toIntArray())) return null
        val c = VibrationEffect.startComposition()
        spec.primitives.forEach { c.addPrimitive(it.id, it.scale, it.delayMs) }
        return c.compose()
    }

    private fun waveform(v: Vibrator, spec: PatternSpec): VibrationEffect =
        if (v.hasAmplitudeControl()) {
            VibrationEffect.createWaveform(spec.timings, spec.amplitudes, -1)
        } else {
            VibrationEffect.createWaveform(spec.timings, -1)
        }

    private fun PlatformKind.toCompose(): HapticFeedbackType = when (this) {
        PlatformKind.Confirm -> HapticFeedbackType.Confirm
        PlatformKind.Reject -> HapticFeedbackType.Reject
        PlatformKind.ToggleOn -> HapticFeedbackType.ToggleOn
        PlatformKind.ToggleOff -> HapticFeedbackType.ToggleOff
        PlatformKind.SegmentTick -> HapticFeedbackType.SegmentTick
        PlatformKind.SegmentFrequentTick -> HapticFeedbackType.SegmentFrequentTick
        PlatformKind.ContextClick -> HapticFeedbackType.ContextClick
        PlatformKind.GestureThresholdActivate -> HapticFeedbackType.GestureThresholdActivate
        PlatformKind.GestureEnd -> HapticFeedbackType.GestureEnd
        PlatformKind.LongPress -> HapticFeedbackType.LongPress
        PlatformKind.VirtualKey -> HapticFeedbackType.VirtualKey
        PlatformKind.KeyboardTap -> HapticFeedbackType.KeyboardTap
    }
}

class Primitive(val id: Int, val scale: Float, val delayMs: Int = 0)

/** A custom pattern: composition primitives where the hardware has them, a short waveform otherwise. */
class PatternSpec(val primitives: List<Primitive>, val timings: LongArray, val amplitudes: IntArray)

object HapticPatterns {
    private const val CLICK = VibrationEffect.Composition.PRIMITIVE_CLICK
    private const val TICK = VibrationEffect.Composition.PRIMITIVE_TICK
    private const val THUD = VibrationEffect.Composition.PRIMITIVE_THUD
    private const val RISE = VibrationEffect.Composition.PRIMITIVE_QUICK_RISE
    private const val FALL = VibrationEffect.Composition.PRIMITIVE_QUICK_FALL

    // Waveforms alternate off/on: [off, on, off, on, ...], amplitudes line up with timings.
    private val success = PatternSpec(
        listOf(Primitive(RISE, 0.6f), Primitive(CLICK, 1f, 30)),
        longArrayOf(0, 8, 30, 22), intArrayOf(0, 90, 0, 255),
    )
    private val error = PatternSpec(
        listOf(Primitive(THUD, 1f), Primitive(THUD, 0.85f, 110)),
        longArrayOf(0, 35, 80, 45), intArrayOf(0, 255, 0, 255),
    )
    private val warning = PatternSpec(
        listOf(Primitive(CLICK, 1f), Primitive(CLICK, 0.7f, 140)),
        longArrayOf(0, 14, 110, 14), intArrayOf(0, 255, 0, 170),
    )
    private val sheetOpen = PatternSpec(
        listOf(Primitive(RISE, 0.45f), Primitive(TICK, 0.7f, 10)),
        longArrayOf(0, 10, 15, 8), intArrayOf(0, 80, 0, 150),
    )
    private val sheetDismiss = PatternSpec(
        listOf(Primitive(FALL, 0.45f), Primitive(TICK, 0.5f, 10)),
        longArrayOf(0, 8, 15, 6), intArrayOf(0, 120, 0, 70),
    )
    private val expand = PatternSpec(listOf(Primitive(RISE, 0.4f)), longArrayOf(0, 14), intArrayOf(0, 110))
    private val collapse = PatternSpec(listOf(Primitive(FALL, 0.4f)), longArrayOf(0, 12), intArrayOf(0, 90))

    fun of(p: CustomPattern): PatternSpec = when (p) {
        CustomPattern.Success -> success
        CustomPattern.Error -> error
        CustomPattern.Warning -> warning
        CustomPattern.SheetOpen -> sheetOpen
        CustomPattern.SheetDismiss -> sheetDismiss
        CustomPattern.Expand -> expand
        CustomPattern.Collapse -> collapse
    }
}
