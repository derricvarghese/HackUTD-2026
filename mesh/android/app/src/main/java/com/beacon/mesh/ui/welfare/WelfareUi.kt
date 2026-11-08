package com.beacon.mesh.ui.welfare

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.welfare.Countdown
import com.beacon.mesh.welfare.WelfareResponse
import com.beacon.mesh.welfare.WelfareState
import kotlinx.coroutines.delay

/** Wall clock ticking once a second, for countdowns. */
@Composable
fun rememberSecondNow(): State<Long> = produceState(System.currentTimeMillis()) {
    while (true) {
        value = System.currentTimeMillis()
        delay(1000)
    }
}

@Composable
fun welfareLabel(response: String): String = stringResource(
    when (response) {
        WelfareResponse.NO_LONGER_NEED_HELP -> R.string.welfare_no_longer
        WelfareResponse.NEED_URGENT_HELP -> R.string.welfare_urgent
        else -> R.string.welfare_still_here
    }
)

/** The three big answers with a large countdown (or the overdue notice). [onDismiss] only closes the screen; it never answers. */
@Composable
fun WelfareAnswerPanel(
    prompt: CheckinPrompt,
    onAnswer: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHaptics.current
    val now by rememberSecondNow()
    val left = (prompt.deadlineAtMs ?: Long.MAX_VALUE) - now
    val overdue = prompt.deadlineAtMs != null && left <= 0
    val countdown = Countdown.format(left)
    val leftDesc = stringResource(R.string.welfare_time_left_desc, countdown)
    Column(
        modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Rounded.NotificationsActive, null, tint = MaterialTheme.colorScheme.primary)
        Text(
            prompt.title ?: prompt.message ?: stringResource(R.string.welfare_notif_title),
            style = MaterialTheme.typography.headlineMediumEmphasized,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        if (prompt.title != null && prompt.message != null) {
            Text(prompt.message, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        }
        run {
            if (overdue) {
                Text(
                    stringResource(R.string.welfare_overdue),
                    style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            } else {
                Text(stringResource(R.string.welfare_time_left), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    countdown,
                    style = MaterialTheme.typography.displayLargeEmphasized.copy(fontFamily = FontFamily.Monospace),
                    color = if (left < 60_000) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.semantics { contentDescription = leftDesc },
                )
            }
            val choices = WelfareResponse.offered(prompt.choices)
            choices.forEach { r ->
                val primary = r == WelfareResponse.STILL_HERE
                val urgent = r == WelfareResponse.NEED_URGENT_HELP
                val onClick = haptics.onClick(if (urgent) HapticEvent.Warning else HapticEvent.Success) { onAnswer(r) }
                val shape = ButtonDefaults.shapes()
                val mod = Modifier.fillMaxWidth().heightIn(min = 80.dp)
                when {
                    primary -> Button(onClick = onClick, shapes = shape, modifier = mod) { Text(welfareLabel(r), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center) }
                    urgent -> Button(
                        onClick = onClick, shapes = shape, modifier = mod,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                    ) { Text(welfareLabel(r), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center) }
                    else -> FilledTonalButton(onClick = onClick, shapes = shape, modifier = mod) { Text(welfareLabel(r), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center) }
                }
            }
            TextButton(onClick = haptics.onClick(HapticEvent.LightTap, onDismiss), modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.welfare_later))
            }
        }
    }
}

/** In-app confirmation screen (opened from the notification or the Home card). Back = close without answering. */
@Composable
fun WelfareAnswerScreen(prompt: CheckinPrompt, onAnswer: (String) -> Unit, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        WelfareAnswerPanel(prompt, onAnswer = onAnswer, onDismiss = onClose)
    }
}

/** Home card: a check-in is due. One tap opens the confirmation screen. */
@Composable
fun WelfareDueCard(prompt: CheckinPrompt, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = LocalHaptics.current
    val now by rememberSecondNow()
    val leftMs = (prompt.deadlineAtMs ?: now) - now
    ElevatedSection(modifier, container = MaterialTheme.colorScheme.errorContainer) {
        Text(
            prompt.title ?: prompt.message ?: stringResource(R.string.welfare_notif_title),
            style = MaterialTheme.typography.titleMediumEmphasized, color = MaterialTheme.colorScheme.onErrorContainer,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            Text(
                if (leftMs > 0) stringResource(R.string.welfare_card_due, Countdown.format(leftMs)) else stringResource(R.string.welfare_card_overdue),
                style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = haptics.onClick(HapticEvent.SheetOpen, onOpen), shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.welfare_card_answer))
            }
        }
    }
}

/** Small status line on an own message: due countdown or what the person answered. */
@Composable
fun WelfareLine(state: WelfareState, modifier: Modifier = Modifier) {
    when (state) {
        is WelfareState.Due -> {
            val now by rememberSecondNow()
            val ms = state.deadlineAtMs - now
            if (ms > 0) Text(
                stringResource(R.string.welfare_card_due, Countdown.format(ms)),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error, modifier = modifier,
            )
        }
        WelfareState.Overdue -> Text(
            stringResource(R.string.welfare_card_overdue), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.error, modifier = modifier,
        )
        WelfareState.StillHere -> Text(stringResource(R.string.welfare_state_still), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
        WelfareState.UrgentHelp -> Text(stringResource(R.string.welfare_state_urgent), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error, modifier = modifier)
        WelfareState.ResolvedByYou -> Text(stringResource(R.string.welfare_state_resolved), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
    }
}
