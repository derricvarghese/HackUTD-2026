package com.beacon.mesh.ui.screens

import android.net.Uri
import android.os.Build
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.BugReport
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.ToggleButton
import androidx.compose.material3.ToggleButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.beacon.mesh.BuildConfig
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.ui.SystemIntents
import com.beacon.mesh.ui.SystemStatus
import com.beacon.mesh.ui.UiSettings
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.haptics.hapticClickable
import com.beacon.mesh.ui.logic.GroupStatus
import com.beacon.mesh.ui.logic.PermGroup
import com.beacon.mesh.ui.logic.PermissionPlan
import com.beacon.mesh.ui.safeStart
import com.beacon.mesh.ui.theme.ThemeMode

@Composable
fun SettingsScreen(
    settings: UiSettings,
    mesh: MeshSnapshot,
    system: SystemStatus,
    onTheme: (ThemeMode) -> Unit,
    onDynamic: (Boolean) -> Unit,
    onOpenDebug: () -> Unit,
    onHaptics: (Boolean) -> Unit = {},
) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    ScreenScaffold(title = stringResource(R.string.nav_settings)) { pad ->
        ScrollColumn(pad) {
            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_appearance))
                Text(stringResource(R.string.settings_theme), style = MaterialTheme.typography.titleMedium)
                ThemeModeGroup(settings.themeMode, onTheme)
                val dynamicSupported = Build.VERSION.SDK_INT >= 31
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.settings_dynamic), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(if (dynamicSupported) R.string.settings_dynamic_body else R.string.settings_dynamic_unsupported),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = settings.dynamicColor && dynamicSupported,
                        onCheckedChange = haptics.onToggle(onDynamic),
                        enabled = dynamicSupported,
                    )
                }
                SystemIntents.appLanguage(context)?.let { intent ->
                    FilledTonalButton(
                        onClick = haptics.onClick { context.safeStart(intent) },
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.settings_language)) }
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_feedback))
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.settings_haptics), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(R.string.settings_haptics_body),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = settings.hapticsEnabled,
                        // Play the cue before the switch takes effect, so turning it off is still felt once.
                        onCheckedChange = { on ->
                            if (!on) haptics.toggle(false)
                            onHaptics(on)
                            if (on) haptics.toggle(true)
                        },
                    )
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_permissions))
                val sdk = system.sdk
                PermRow(R.string.perm_bluetooth_title, PermissionPlan.status(PermGroup.BLUETOOTH, sdk, system.granted, emptySet(), emptySet()) == GroupStatus.GRANTED || sdk < 31)
                PermRow(R.string.service_bluetooth_title, system.bluetoothOn)
                PermRow(R.string.perm_location_title, system.locationPermission)
                PermRow(R.string.service_location_title, system.locationOn)
                if (sdk >= 33) PermRow(R.string.perm_notifications_title, system.notificationsPermission)
                FilledTonalButton(
                    onClick = haptics.onClick { context.safeStart(SystemIntents.appSettings(context)) },
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.action_open_settings)) }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_advanced))
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp)
                        .hapticClickable(HapticEvent.Navigate, role = Role.Button, onClick = onOpenDebug),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Rounded.BugReport, null)
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.settings_debug), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.settings_debug_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null)
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_about))
                Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.mesh_relay_id, mesh.relayId), style = MaterialTheme.typography.bodyMedium)
                ServerLine(mesh.backendUrl)
                Text(stringResource(R.string.about_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun PermRow(label: Int, ok: Boolean) {
    val okText = stringResource(if (ok) R.string.state_done else R.string.state_todo)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            if (ok) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline,
            contentDescription = okText,
            tint = if (ok) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.error,
        )
        Text(stringResource(label), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Text(okText, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** System / Light / Dark as a connected button group (expressive connected toggle buttons). */
@Composable
fun ThemeModeGroup(mode: ThemeMode, onChange: (ThemeMode) -> Unit) {
    val haptics = LocalHaptics.current
    val options = ThemeMode.entries
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween),
    ) {
        options.forEachIndexed { i, option ->
            ToggleButton(
                checked = option == mode,
                onCheckedChange = { if (option != mode) { haptics.perform(HapticEvent.Select); onChange(option) } },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { role = Role.RadioButton },
                shapes = when (i) {
                    0 -> ButtonGroupDefaults.connectedLeadingButtonShapes()
                    options.lastIndex -> ButtonGroupDefaults.connectedTrailingButtonShapes()
                    else -> ButtonGroupDefaults.connectedMiddleButtonShapes()
                },
            ) {
                Text(
                    stringResource(
                        when (option) {
                            ThemeMode.SYSTEM -> R.string.theme_system
                            ThemeMode.LIGHT -> R.string.theme_light
                            ThemeMode.DARK -> R.string.theme_dark
                        }
                    ),
                    maxLines = 2,
                )
            }
        }
    }
}

/** Read-only: which server this build uploads to (fixed at build time). */
@Composable
fun ServerLine(url: String, modifier: Modifier = Modifier) {
    val host = remember(url) { runCatching { Uri.parse(url).host }.getOrNull() ?: url }
    Text(stringResource(R.string.server_line, host), style = MaterialTheme.typography.bodyMedium, modifier = modifier)
}
