package com.beacon.mesh.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Button
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.backend.KeyStatus
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.components.ageText
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.safeStart

@Composable
fun keyStatusText(s: KeyStatus): String = stringResource(
    when (s) {
        KeyStatus.NONE -> R.string.key_status_none
        KeyStatus.BUILT_IN -> R.string.key_status_built_in
        KeyStatus.CACHED -> R.string.key_status_cached
    }
)

/** Just the security-key lines (used by the Debug screen too). */
@Composable
fun KeyStatusLines(mesh: MeshSnapshot) {
    StatusLine(stringResource(R.string.backend_enc_key), keyStatusText(mesh.encKeyStatus), error = mesh.encKeyStatus == KeyStatus.NONE)
    StatusLine(stringResource(R.string.backend_sign_key), keyStatusText(mesh.signKeyStatus), error = false)
}

@Composable
private fun StatusLine(label: String, value: String, error: Boolean = false) {
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Mesh status card: security keys, device registration, server reachability, last upload result, heartbeat. */
@Composable
fun BackendCard(mesh: MeshSnapshot, now: Long, modifier: Modifier = Modifier) {
    ElevatedSection(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BadgeIcon(Icons.Rounded.Cloud, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer, size = 40.dp)
            Text(stringResource(R.string.backend_title), style = MaterialTheme.typography.titleMediumEmphasized)
        }
        KeyStatusLines(mesh)
        if (mesh.encKeyStatus == KeyStatus.NONE) {
            Text(stringResource(R.string.backend_no_key_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        StatusLine(
            stringResource(R.string.backend_device),
            mesh.deviceId?.let { stringResource(R.string.backend_device_registered, it.take(8)) } ?: stringResource(R.string.backend_device_unregistered),
        )
        StatusLine(
            stringResource(R.string.backend_server),
            stringResource(
                when (mesh.serverReachable) {
                    true -> R.string.backend_server_ok
                    false -> R.string.backend_server_down
                    null -> R.string.backend_server_unknown
                }
            ),
            error = mesh.serverReachable == false,
        )
        val s = mesh.lastUpload?.summary
        Text(
            if (s == null) stringResource(R.string.backend_upload_none)
            else stringResource(
                R.string.backend_upload_counts, ageText(s.atMs, now), s.created, s.duplicate, s.rejected, s.deferred, s.direct,
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = if (s != null && !s.ok) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (s != null && s.rejectReasons.isNotEmpty()) {
            Text(
                s.rejectReasons.entries.joinToString { "${it.key} x${it.value}" },
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun HeartbeatCard(mesh: MeshSnapshot, now: Long, modifier: Modifier = Modifier) {
    val hb = mesh.heartbeat
    ElevatedSection(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BadgeIcon(Icons.Rounded.Favorite, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer, size = 40.dp)
            Text(stringResource(R.string.heartbeat_title), style = MaterialTheme.typography.titleMediumEmphasized)
        }
        Text(
            stringResource(if (hb.active) R.string.heartbeat_active else R.string.heartbeat_inactive),
            style = MaterialTheme.typography.titleLargeEmphasized,
        )
        Text(
            when {
                !hb.active -> stringResource(R.string.heartbeat_inactive_body)
                hb.lastSentMs == 0L -> stringResource(R.string.heartbeat_never)
                else -> stringResource(
                    if (hb.lastViaMesh) R.string.heartbeat_last_mesh else R.string.heartbeat_last_direct,
                    ageText(hb.lastSentMs, now),
                ) + "\n" + stringResource(R.string.heartbeat_automatic, (hb.intervalSeconds / 60).coerceAtLeast(1))
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Welfare check-in readiness: check-ins reach the person as notifications, so they must be allowed. */
@Composable
fun WelfareReadinessCard(system: com.beacon.mesh.ui.SystemStatus, modifier: Modifier = Modifier) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val haptics = LocalHaptics.current
    val ok = system.notificationsEnabled && system.notificationsPermission
    ElevatedSection(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BadgeIcon(Icons.Rounded.Favorite, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer, size = 40.dp)
            Text(stringResource(R.string.welfare_ready_title), style = MaterialTheme.typography.titleMediumEmphasized)
        }
        Text(
            stringResource(if (ok) R.string.welfare_ready_ok else R.string.welfare_ready_needs_fix),
            style = MaterialTheme.typography.bodyMedium,
            color = if (ok) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
        )
        if (!ok) FilledTonalButton(
            onClick = haptics.onClick(HapticEvent.Tap) { context.safeStart(com.beacon.mesh.ui.SystemIntents.notificationSettings(context)) },
            shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(stringResource(R.string.welfare_perm_fix)) }
    }
}
