package com.beacon.mesh.ui.haptics

/** What happened, in UI terms. [HapticMapping] decides how each one feels. */
enum class HapticEvent {
    /** Primary button / click. */
    Tap,
    /** List item, card, chip action, nav item: softer than [Tap]. */
    LightTap,
    ToggleOn,
    ToggleOff,
    /** Segmented / choice / radio selection. */
    Select,
    /** Slider or stepper detent. */
    Tick,
    /** Continuous drag detents; rate limited harder than [Tick]. */
    FrequentTick,
    /** Something worked (non-hold send, copy, saved, permission granted). */
    Success,
    /** Something failed or was refused. */
    Error,
    Warning,
    LongPress,
    ContextClick,
    SheetOpen,
    SheetDismiss,
    /** A gesture (swipe / back) crossed its commit point. */
    GestureCommit,
    /** A gesture crossed an intermediate threshold. */
    GestureThreshold,
    Expand,
    Collapse,
    /** Moving to another screen or pane. */
    Navigate,
}

/** A named custom vibration, built from composition primitives with a waveform fallback. */
enum class CustomPattern { Success, Error, Warning, SheetOpen, SheetDismiss, Expand, Collapse }

/** Constants the platform provides through `performHapticFeedback`; these follow the system touch-feedback setting. */
enum class PlatformKind {
    Confirm, Reject, ToggleOn, ToggleOff, SegmentTick, SegmentFrequentTick, ContextClick,
    GestureThresholdActivate, GestureEnd, LongPress, VirtualKey, KeyboardTap,
}

sealed interface HapticEffect {
    data class Platform(val kind: PlatformKind) : HapticEffect
    data class Custom(val pattern: CustomPattern) : HapticEffect
}

/** Event to effect table. Pure, so it is unit tested. */
object HapticMapping {
    fun effectFor(event: HapticEvent): HapticEffect = when (event) {
        HapticEvent.Tap -> HapticEffect.Platform(PlatformKind.VirtualKey)
        HapticEvent.LightTap, HapticEvent.Navigate -> HapticEffect.Platform(PlatformKind.KeyboardTap)
        HapticEvent.ToggleOn -> HapticEffect.Platform(PlatformKind.ToggleOn)
        HapticEvent.ToggleOff -> HapticEffect.Platform(PlatformKind.ToggleOff)
        HapticEvent.Select, HapticEvent.Tick -> HapticEffect.Platform(PlatformKind.SegmentTick)
        HapticEvent.FrequentTick -> HapticEffect.Platform(PlatformKind.SegmentFrequentTick)
        HapticEvent.Success -> HapticEffect.Custom(CustomPattern.Success)
        HapticEvent.Error -> HapticEffect.Custom(CustomPattern.Error)
        HapticEvent.Warning -> HapticEffect.Custom(CustomPattern.Warning)
        HapticEvent.LongPress -> HapticEffect.Platform(PlatformKind.LongPress)
        HapticEvent.ContextClick -> HapticEffect.Platform(PlatformKind.ContextClick)
        HapticEvent.SheetOpen -> HapticEffect.Custom(CustomPattern.SheetOpen)
        HapticEvent.SheetDismiss -> HapticEffect.Custom(CustomPattern.SheetDismiss)
        HapticEvent.GestureCommit -> HapticEffect.Platform(PlatformKind.GestureEnd)
        HapticEvent.GestureThreshold -> HapticEffect.Platform(PlatformKind.GestureThresholdActivate)
        HapticEvent.Expand -> HapticEffect.Custom(CustomPattern.Expand)
        HapticEvent.Collapse -> HapticEffect.Custom(CustomPattern.Collapse)
    }
}
