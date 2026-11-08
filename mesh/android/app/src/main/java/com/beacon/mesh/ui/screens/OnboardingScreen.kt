package com.beacon.mesh.ui.screens

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bluetooth
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Radar
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.ui.graphics.vector.ImageVector
import com.beacon.mesh.R
import com.beacon.mesh.ui.SystemIntents
import com.beacon.mesh.ui.SystemStatus
import com.beacon.mesh.ui.SystemStatusHolder
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.logic.GroupStatus
import com.beacon.mesh.ui.logic.PermGroup
import com.beacon.mesh.ui.logic.PermissionPlan
import com.beacon.mesh.ui.safeStart

/**
 * Onboarding: explains why each permission is needed, requests them here (never mid-crisis),
 * handles "denied permanently -> open settings", and checks that Bluetooth and location are ON.
 */
@Composable
fun OnboardingScreen(
    holder: SystemStatusHolder,
    askedPermissions: Set<String>,
    onAsked: (Collection<String>) -> Unit,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val status = holder.status
    val sdk = status.sdk

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        onAsked(result.keys)
        holder.refresh()
    }
    val enableBt = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { holder.refresh() }

    fun groupStatus(g: PermGroup) =
        PermissionPlan.status(g, sdk, status.granted, askedPermissions, status.rationale)

    fun request(g: PermGroup) = launcher.launch(PermissionPlan.permissions(g, sdk).toTypedArray())

    val ready = status.readiness.canRunMesh
    val insets = WindowInsets.safeDrawing

    ScrollColumn(PaddingValues(0.dp), modifier = modifier.windowInsetsPadding(insets).padding(top = 16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BadgeIcon(Icons.Rounded.Radar, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer, size = 72.dp)
            Text(
                stringResource(R.string.onboarding_title),
                style = MaterialTheme.typography.displaySmallEmphasized,
            )
            Text(
                stringResource(R.string.onboarding_body),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // Bluetooth permission (Android 12+) -- required.
        PermissionCard(
            icon = Icons.Rounded.Bluetooth,
            title = stringResource(R.string.perm_bluetooth_title),
            why = stringResource(R.string.perm_bluetooth_why),
            status = groupStatus(PermGroup.BLUETOOTH),
            required = true,
            onRequest = { request(PermGroup.BLUETOOTH) },
            onOpenSettings = { context.safeStart(SystemIntents.appSettings(context)) },
        )
        // Bluetooth switch.
        ToggleCard(
            icon = Icons.Rounded.Bluetooth,
            title = stringResource(R.string.service_bluetooth_title),
            why = stringResource(R.string.service_bluetooth_why),
            on = status.bluetoothOn,
            actionLabel = stringResource(R.string.action_turn_on),
            enabled = true,
            onAction = {
                if (status.bluetoothPermission) enableBt.launch(SystemIntents.enableBluetooth())
                else context.safeStart(SystemIntents.bluetoothSettings())
            },
        )
        // Location permission: required before Android 12 for BLE scanning, otherwise GPS on the SOS.
        PermissionCard(
            icon = Icons.Rounded.LocationOn,
            title = stringResource(R.string.perm_location_title),
            why = stringResource(if (sdk < 31) R.string.perm_location_why_required else R.string.perm_location_why),
            status = groupStatus(PermGroup.LOCATION),
            required = sdk < 31,
            onRequest = { request(PermGroup.LOCATION) },
            onOpenSettings = { context.safeStart(SystemIntents.appSettings(context)) },
        )
        ToggleCard(
            icon = Icons.Rounded.LocationOn,
            title = stringResource(R.string.service_location_title),
            why = stringResource(R.string.service_location_why),
            on = status.locationOn,
            actionLabel = stringResource(R.string.action_turn_on),
            enabled = true,
            onAction = { context.safeStart(SystemIntents.locationSettings()) },
        )
        PermissionCard(
            icon = Icons.Rounded.Notifications,
            title = stringResource(R.string.perm_notifications_title),
            why = stringResource(R.string.perm_notifications_why),
            status = groupStatus(PermGroup.NOTIFICATIONS),
            required = false,
            onRequest = { request(PermGroup.NOTIFICATIONS) },
            onOpenSettings = { context.safeStart(SystemIntents.notificationSettings(context)) },
        )

        Column(Modifier.padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onFinish,
                enabled = ready,
                shapes = ButtonDefaults.shapes(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.onboarding_continue)) }
            if (!ready) {
                Text(
                    stringResource(R.string.onboarding_blocked),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onFinish, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(R.string.onboarding_skip))
            }
        }
    }
}

@Composable
private fun PermissionCard(
    icon: ImageVector,
    title: String,
    why: String,
    status: GroupStatus,
    required: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    if (status == GroupStatus.NOT_NEEDED) return
    val granted = status == GroupStatus.GRANTED
    ElevatedSection(
        container = if (granted) MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        CardHeader(icon, title, granted, required)
        Text(why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        when (status) {
            GroupStatus.GRANTED, GroupStatus.NOT_NEEDED -> Unit
            GroupStatus.NOT_ASKED -> FilledTonalButton(onClick = onRequest, shapes = ButtonDefaults.shapes(), modifier = actionModifier()) {
                Text(stringResource(R.string.action_allow))
            }
            GroupStatus.DENIED -> {
                Text(stringResource(R.string.perm_denied_rationale), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                FilledTonalButton(onClick = onRequest, shapes = ButtonDefaults.shapes(), modifier = actionModifier()) {
                    Text(stringResource(R.string.action_try_again))
                }
            }
            GroupStatus.DENIED_PERMANENTLY -> {
                Text(stringResource(R.string.perm_denied_permanent), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                FilledTonalButton(onClick = onOpenSettings, shapes = ButtonDefaults.shapes(), modifier = actionModifier()) {
                    Text(stringResource(R.string.action_open_settings))
                }
            }
        }
    }
}

@Composable
private fun ToggleCard(
    icon: ImageVector,
    title: String,
    why: String,
    on: Boolean,
    actionLabel: String,
    enabled: Boolean,
    onAction: () -> Unit,
) {
    ElevatedSection(
        container = if (on) MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        CardHeader(icon, title, on, required = false)
        Text(why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!on) {
            FilledTonalButton(onClick = onAction, enabled = enabled, shapes = ButtonDefaults.shapes(), modifier = actionModifier()) {
                Text(actionLabel)
            }
        }
    }
}

@Composable
private fun actionModifier() = Modifier.heightIn(min = 48.dp)

@Composable
private fun CardHeader(icon: ImageVector, title: String, done: Boolean, required: Boolean) {
    val doneDesc = stringResource(if (done) R.string.state_done else R.string.state_todo)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "$title, $doneDesc" },
    ) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMediumEmphasized)
            if (required) {
                Text(stringResource(R.string.label_required), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            }
        }
        Icon(
            if (done) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked,
            contentDescription = null,
            tint = if (done) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(28.dp),
        )
    }
}
