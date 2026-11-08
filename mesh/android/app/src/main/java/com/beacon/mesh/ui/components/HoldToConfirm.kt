package com.beacon.mesh.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.logic.SosDraft

/**
 * Press and hold to send, so a pocket tap can never raise a false alarm. A vibration builds in intensity while held, then pops on send (see [HoldHaptics]). TalkBack users activate it with a normal double tap through the click semantic.
 */
@Composable
fun HoldToConfirmButton(
    onConfirm: () -> Unit,
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    holdMillis: Long = SosDraft.HOLD_MILLIS,
) {
    val context = LocalContext.current
    val appHaptics = LocalHaptics.current
    val haptics = remember(context, appHaptics) { HoldHaptics(context) { appHaptics.isEnabled } }
    var pressing by remember { mutableStateOf(false) }
    val progress = remember { Animatable(0f) }
    val sendNow = stringResource(R.string.sos_send_now_desc)
    LaunchedEffect(pressing) {
        if (pressing) {
            var completed = false
            try {
                haptics.startRamp(holdMillis)
                progress.animateTo(1f, tween(holdMillis.toInt(), easing = LinearEasing))
                completed = true
                haptics.pop()
                pressing = false
                onConfirm()
            } finally {
                // Finger lifted early: stop the build-up straight away.
                if (!completed) haptics.cancel()
            }
        } else {
            progress.snapTo(0f)
        }
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .pointerInput(Unit) {
                detectTapGestures(onPress = {
                    pressing = true
                    tryAwaitRelease()
                    pressing = false
                })
            }
            .semantics(mergeDescendants = true) {
                role = Role.Button
                onClick(label = sendNow) { haptics.pop(); onConfirm(); true }
            },
        shape = MaterialTheme.shapes.extraLarge,
        color = container,
        contentColor = content,
    ) {
        Column(
            Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        ) {
            Text(
                stringResource(if (pressing) R.string.sos_keep_holding else R.string.sos_hold_to_send),
                style = MaterialTheme.typography.titleMediumEmphasized,
                textAlign = TextAlign.Center,
            )
            LinearWavyProgressIndicator(
                progress = { progress.value },
                modifier = Modifier.fillMaxWidth(),
                color = content,
                trackColor = content.copy(alpha = 0.25f),
            )
        }
    }
}
