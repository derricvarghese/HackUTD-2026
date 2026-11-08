package com.beacon.mesh.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.GpsFixed
import androidx.compose.material.icons.rounded.GpsNotFixed
import androidx.compose.material.icons.rounded.GpsOff
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.beacon.mesh.GpsFix
import com.beacon.mesh.R
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.HoldToConfirmButton
import com.beacon.mesh.ui.components.categoryStyle
import com.beacon.mesh.ui.logic.SosDraft
import com.beacon.mesh.protocol.Category
import kotlinx.coroutines.launch

/**
 * Confirmation step for an alert: optional note, people count, GPS status and a hold-to-send
 * button for critical alerts. Dismissing (swipe, scrim, predictive back) discards the draft.
 */
@Composable
fun SosSheet(
    draft: SosDraft,
    gps: GpsFix?,
    locationAllowed: Boolean,
    onNote: (String) -> Unit,
    onPeople: (Int) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val haptics = LocalHaptics.current
    val style = categoryStyle(draft.category.wire)
    // Swipe down, scrim tap or back. (Opening plays SheetOpen at the tile / menu item that opened it.)
    ModalBottomSheet(onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); onDismiss() }, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                BadgeIcon(style.icon, style.container, style.content)
                Column {
                    Text(stringResource(R.string.sos_sheet_title), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(style.label), style = MaterialTheme.typography.headlineMediumEmphasized)
                }
            }

            GpsLine(gps, locationAllowed)

            if (draft.category != Category.SAFE || draft.people > 1) PeopleStepper(draft.people, onPeople)

            OutlinedTextField(
                value = draft.note,
                onValueChange = onNote,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.sos_note_label)) },
                placeholder = { Text(stringResource(R.string.sos_note_hint)) },
                supportingText = { Text("${draft.note.length}/${SosDraft.MAX_NOTE}") },
                minLines = 2,
                maxLines = 5,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
            )

            Text(
                stringResource(R.string.sos_offline_explainer),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            val dismiss: () -> Unit = {
                haptics.perform(HapticEvent.SheetDismiss)
                scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) onDismiss() }
            }
            val confirm: () -> Unit = {
                scope.launch { sheetState.hide() }.invokeOnCompletion { onConfirm() }
            }
            if (draft.requiresHold) {
                HoldToConfirmButton(onConfirm = confirm, container = style.strong, content = style.onStrong)
            } else {
                Button(
                    // No hold here, so no hold-to-send pop: play the success cue instead.
                    onClick = haptics.onClick(HapticEvent.Success, confirm),
                    shapes = ButtonDefaults.shapes(),
                    colors = ButtonDefaults.buttonColors(containerColor = style.strong, contentColor = style.onStrong),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
                ) { Text(stringResource(R.string.sos_send), style = MaterialTheme.typography.titleMediumEmphasized) }
            }
            TextButton(onClick = dismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(R.string.action_cancel))
            }
        }
    }
}

/** "GPS, about 8 m": source plus the rounded 68 % radius (Android's Location.accuracy), never a made-up precision. */
@Composable
fun gpsFixText(gps: GpsFix): String {
    val src = stringResource(when (gps.source) { "gps" -> R.string.gps_src_gps; "fused" -> R.string.gps_src_fused; "network" -> R.string.gps_src_network; else -> R.string.gps_src_other })
    val m = com.beacon.mesh.location.LocationSelector.displayMeters(gps.accuracyM ?: return src)
    return if (m >= 1000) stringResource(R.string.gps_fix_km, src, m / 1000f) else stringResource(R.string.gps_fix, src, m)
}

@Composable
fun GpsLine(gps: GpsFix?, locationAllowed: Boolean, modifier: Modifier = Modifier) {
    val (icon, text) = when {
        !locationAllowed -> Icons.Rounded.GpsOff to stringResource(R.string.gps_denied)
        gps == null -> Icons.Rounded.GpsNotFixed to stringResource(R.string.gps_searching)
        gps.accuracyM != null -> Icons.Rounded.GpsFixed to gpsFixText(gps)
        else -> Icons.Rounded.GpsFixed to stringResource(R.string.gps_fix_unknown)
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun PeopleStepper(people: Int, onPeople: (Int) -> Unit) {
    val haptics = LocalHaptics.current
    val peopleLabel = stringResource(R.string.sos_people_label)
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$peopleLabel: $people" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(peopleLabel, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onPeople(people - 1) }, enabled = people > 1, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Rounded.Remove, stringResource(R.string.sos_people_less))
        }
        Text("$people", style = MaterialTheme.typography.headlineSmallEmphasized, modifier = Modifier.widthIn(min = 32.dp))
        FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onPeople(people + 1) }, enabled = people < SosDraft.MAX_PEOPLE, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Rounded.Add, stringResource(R.string.sos_people_more))
        }
    }
}
