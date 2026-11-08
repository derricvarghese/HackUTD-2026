package com.beacon.mesh.ui.screens

import android.content.ClipData
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.haptics.hapticClickable
import kotlinx.coroutines.launch

/** Demo / debug controls, one level below Settings: hop cap, force offline, backend URL, raw log. */
@Composable
fun DebugScreen(
    mesh: MeshSnapshot,
    onBack: () -> Unit,
    onHopCap: (Int?) -> Unit,
    onForceOffline: (Boolean) -> Unit,
    onTestWelfare: () -> Unit = {},
    onResetIdentity: () -> Unit = {},
) {
    var confirmReset by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val haptics = LocalHaptics.current
    val scope = rememberCoroutineScope()
    val cap = mesh.demoHopCap
    ScreenScaffold(
        title = stringResource(R.string.settings_debug),
        navigationIcon = {
            IconButton(onClick = haptics.onClick(HapticEvent.Navigate, onBack)) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.action_back)) }
        },
    ) { pad ->
        if (confirmReset) {
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { confirmReset = false },
                title = { Text(stringResource(R.string.debug_identity_dialog_title)) },
                text = { Text(stringResource(R.string.debug_identity_dialog_body)) },
                confirmButton = {
                    androidx.compose.material3.TextButton(onClick = haptics.onClick(HapticEvent.Warning) { confirmReset = false; onResetIdentity() }) {
                        Text(stringResource(R.string.debug_identity_confirm))
                    }
                },
                dismissButton = {
                    androidx.compose.material3.TextButton(onClick = haptics.onClick(HapticEvent.LightTap) { confirmReset = false }) {
                        Text(stringResource(R.string.action_cancel))
                    }
                },
            )
        }
        ScrollColumn(pad) {
            HapticsLab()

            ElevatedSection {
                SectionTitle(stringResource(R.string.profile_title))
                // sync bookkeeping only, never profile content
                Text(
                    stringResource(R.string.profile_dbg_line, mesh.profile.syncState.name.lowercase(), mesh.profile.profileVersion),
                    style = MaterialTheme.typography.bodyMedium,
                )
                mesh.profile.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_hopcap_title))
                Text(
                    stringResource(R.string.debug_hopcap_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onHopCap(cap?.minus(1)?.takeIf { it >= 1 }) }, enabled = cap != null) {
                        Icon(Icons.Rounded.Remove, stringResource(R.string.debug_hopcap_less))
                    }
                    Text(
                        cap?.toString() ?: stringResource(R.string.debug_hopcap_off),
                        style = MaterialTheme.typography.headlineSmallEmphasized,
                        modifier = Modifier.weight(1f),
                    )
                    FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onHopCap(((cap ?: 0) + 1).coerceAtMost(10)) }, enabled = (cap ?: 0) < 10) {
                        Icon(Icons.Rounded.Add, stringResource(R.string.debug_hopcap_more))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = haptics.onClick(HapticEvent.LightTap) { onHopCap(2) }, label = { Text(stringResource(R.string.debug_hopcap_demo)) })
                    AssistChip(onClick = haptics.onClick(HapticEvent.LightTap) { onHopCap(null) }, label = { Text(stringResource(R.string.debug_hopcap_clear)) })
                }
            }

            ElevatedSection {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.debug_force_offline), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(R.string.debug_force_offline_body),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = mesh.forceOffline, onCheckedChange = haptics.onToggle(onForceOffline))
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_welfare_title))
                Text(stringResource(R.string.debug_welfare_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FilledTonalButton(
                    onClick = haptics.onClick(HapticEvent.Tap, onTestWelfare),
                    shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.debug_welfare_test)) }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_identity_title))
                val shortId = mesh.deviceId?.take(8) ?: mesh.keyFingerprint.take(8)
                Text(
                    if (mesh.deviceId != null) stringResource(R.string.debug_identity_id, shortId)
                    else stringResource(R.string.debug_identity_id, stringResource(R.string.debug_identity_unregistered, shortId)),
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
                Text(stringResource(R.string.debug_identity_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton(
                        onClick = haptics.onClick(HapticEvent.Success) {
                            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("device id", mesh.deviceId ?: mesh.keyFingerprint))) }
                        },
                        shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.debug_identity_copy)) }
                    FilledTonalButton(
                        onClick = haptics.onClick(HapticEvent.Warning) { confirmReset = true },
                        shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.debug_identity_reset)) }
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_gateway))
                ServerLine(mesh.backendUrl)
                KeyStatusLines(mesh)
                Text(
                    mesh.deviceId?.let { stringResource(R.string.backend_device_registered, it) } ?: stringResource(R.string.backend_device_unregistered),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_log_title))
                if (mesh.log.isEmpty()) {
                    Text(stringResource(R.string.debug_log_empty), style = MaterialTheme.typography.bodyMedium)
                } else {
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
                        SelectionContainer {
                            Column(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp)) {
                                mesh.log.take(120).forEach {
                                    Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), softWrap = false)
                                }
                            }
                        }
                    }
                    FilledTonalButton(
                        onClick = haptics.onClick(HapticEvent.Success) { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("log", mesh.log.joinToString("\n")))) } },
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.debug_log_copy)) }
                }
            }
        }
    }
}

/** One button per semantic haptic event, collapsed by default, to compare them side by side. */
@Composable
private fun HapticsLab() {
    val haptics = LocalHaptics.current
    var open by rememberSaveable { mutableStateOf(false) }
    ElevatedSection {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).hapticClickable(
                if (open) HapticEvent.Collapse else HapticEvent.Expand,
                role = Role.Button,
            ) { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.debug_haptics_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            Icon(if (open) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, null)
        }
        AnimatedVisibility(open) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(if (haptics.isEnabled) R.string.debug_haptics_body else R.string.debug_haptics_off_note),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    HapticEvent.entries.forEach { e ->
                        FilledTonalButton(
                            // Lab buttons play their own effect; no extra tap on top.
                            onClick = { haptics.perform(e) },
                            shapes = ButtonDefaults.shapes(),
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(stringResource(e.labelRes())) }
                    }
                }
            }
        }
    }
}

private fun HapticEvent.labelRes(): Int = when (this) {
    HapticEvent.Tap -> R.string.haptic_tap
    HapticEvent.LightTap -> R.string.haptic_light_tap
    HapticEvent.ToggleOn -> R.string.haptic_toggle_on
    HapticEvent.ToggleOff -> R.string.haptic_toggle_off
    HapticEvent.Select -> R.string.haptic_select
    HapticEvent.Tick -> R.string.haptic_tick
    HapticEvent.FrequentTick -> R.string.haptic_frequent_tick
    HapticEvent.Success -> R.string.haptic_success
    HapticEvent.Error -> R.string.haptic_error
    HapticEvent.Warning -> R.string.haptic_warning
    HapticEvent.LongPress -> R.string.haptic_long_press
    HapticEvent.ContextClick -> R.string.haptic_context_click
    HapticEvent.SheetOpen -> R.string.haptic_sheet_open
    HapticEvent.SheetDismiss -> R.string.haptic_sheet_dismiss
    HapticEvent.GestureCommit -> R.string.haptic_gesture_commit
    HapticEvent.GestureThreshold -> R.string.haptic_gesture_threshold
    HapticEvent.Expand -> R.string.haptic_expand
    HapticEvent.Collapse -> R.string.haptic_collapse
    HapticEvent.Navigate -> R.string.haptic_navigate
}
