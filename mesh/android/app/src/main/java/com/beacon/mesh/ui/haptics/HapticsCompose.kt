package com.beacon.mesh.ui.haptics

import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role

/** Provided once at the app root. The default is silent so previews and tests need no setup. */
val LocalHaptics = staticCompositionLocalOf { Haptics.None }

/** Builds the app's [Haptics]; [enabled] is the Settings master switch and may change at any time. */
@Composable
fun rememberHaptics(enabled: Boolean): Haptics {
    val context = LocalContext.current.applicationContext
    val platform = LocalHapticFeedback.current
    val enabledNow by rememberUpdatedState(enabled)
    return remember(context, platform) {
        Haptics(AndroidHapticBackend(context, platform), { enabledNow })
    }
}

@Composable
fun Modifier.hapticClickable(
    event: HapticEvent = HapticEvent.Tap,
    enabled: Boolean = true,
    onClickLabel: String? = null,
    role: Role? = null,
    onClick: () -> Unit,
): Modifier {
    val haptics = LocalHaptics.current
    return clickable(enabled = enabled, onClickLabel = onClickLabel, role = role) {
        haptics.perform(event)
        onClick()
    }
}

@Composable
fun Modifier.hapticSelectable(
    selected: Boolean,
    enabled: Boolean = true,
    role: Role? = Role.RadioButton,
    onClick: () -> Unit,
): Modifier {
    val haptics = LocalHaptics.current
    return selectable(selected = selected, enabled = enabled, role = role) {
        haptics.perform(HapticEvent.Select)
        onClick()
    }
}

@Composable
fun Modifier.hapticToggleable(
    value: Boolean,
    enabled: Boolean = true,
    role: Role? = Role.Switch,
    onValueChange: (Boolean) -> Unit,
): Modifier {
    val haptics = LocalHaptics.current
    return toggleable(value = value, enabled = enabled, role = role) { on ->
        haptics.toggle(on)
        onValueChange(on)
    }
}
