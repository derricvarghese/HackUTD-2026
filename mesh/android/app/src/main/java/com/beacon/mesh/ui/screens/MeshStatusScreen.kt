package com.beacon.mesh.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bluetooth
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.GpsFixed
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.ui.SystemStatus
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.EmptyState
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.ageText
import com.beacon.mesh.ui.components.rememberNow
import com.beacon.mesh.ui.logic.MessageItem
import com.beacon.mesh.ui.logic.MessageUi
import androidx.compose.material.icons.rounded.Person
import com.beacon.mesh.ui.theme.LocalReduceMotion

/** Live view of the mesh: peers, held messages, gateway and GPS. */
@Composable
fun MeshStatusScreen(mesh: MeshSnapshot, items: List<MessageItem>, system: SystemStatus) {
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    val now = rememberNow()
    val held = MessageUi.heldOffline(items)
    ScreenScaffold(title = stringResource(R.string.nav_mesh)) { pad ->
        ScrollColumn(pad) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                maxItemsInEachRow = if (wide) 2 else 1,
                modifier = Modifier.fillMaxWidth(),
            ) {
                PeersCard(mesh, system, Modifier.weight(1f))
                HeldCard(held, items.size, Modifier.weight(1f))
                GatewayCard(mesh, now, Modifier.weight(1f))
                BackendCard(mesh, now, Modifier.weight(1f))
                HeartbeatCard(mesh, now, Modifier.weight(1f))
                ProfileSyncCard(mesh, Modifier.weight(1f))
                GpsCard(mesh, system, Modifier.weight(1f))
            }
            Text(
                stringResource(R.string.mesh_relay_id, mesh.relayId),
                style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun CardTitle(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        BadgeIcon(icon, MaterialTheme.colorScheme.secondaryContainer, MaterialTheme.colorScheme.onSecondaryContainer, size = 40.dp)
        Text(title, style = MaterialTheme.typography.titleMediumEmphasized)
    }
}

@Composable
private fun PeersCard(mesh: MeshSnapshot, system: SystemStatus, modifier: Modifier) {
    ElevatedSection(modifier) {
        CardTitle(Icons.Rounded.Bluetooth, stringResource(R.string.mesh_peers_title))
        Text("${mesh.peers.size}", style = MaterialTheme.typography.displayMediumEmphasized)
        when {
            !system.bluetoothOn -> Text(stringResource(R.string.mesh_bt_off), color = MaterialTheme.colorScheme.error)
            mesh.peers.isEmpty() -> EmptyState(
                icon = Icons.Rounded.WifiOff,
                title = stringResource(R.string.mesh_no_peers_title),
                body = stringResource(R.string.mesh_no_peers_body),
                loading = mesh.started,
            )
            else -> mesh.peers.forEachIndexed { i, peer ->
                Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.mesh_peer_n, i + 1), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Text(
                        peer.takeLast(8),
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun HeldCard(held: Int, total: Int, modifier: Modifier) {
    ElevatedSection(modifier) {
        CardTitle(Icons.Rounded.Inbox, stringResource(R.string.mesh_held_title))
        Text("$held", style = MaterialTheme.typography.displayMediumEmphasized)
        Text(
            if (total == 0) stringResource(R.string.mesh_held_none)
            else pluralStringResource(R.plurals.mesh_held_summary, held, held, total),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun GatewayCard(mesh: MeshSnapshot, now: Long, modifier: Modifier) {
    val uploading = mesh.uploadingIds.isNotEmpty()
    ElevatedSection(modifier) {
        CardTitle(if (mesh.isGateway) Icons.Rounded.CloudUpload else Icons.Rounded.CloudOff, stringResource(R.string.mesh_gateway_title))
        Text(
            stringResource(
                when {
                    uploading -> R.string.mesh_gw_uploading
                    mesh.isGateway -> R.string.mesh_gw_online
                    mesh.forceOffline && mesh.hasInternet -> R.string.mesh_gw_forced
                    else -> R.string.mesh_gw_offline
                }
            ),
            style = MaterialTheme.typography.titleLargeEmphasized,
        )
        if (uploading) {
            if (LocalReduceMotion.current) {
                LinearWavyProgressIndicator(progress = { 0.5f }, Modifier.fillMaxWidth())
            } else {
                LinearWavyProgressIndicator(Modifier.fillMaxWidth())
            }
            Text(pluralStringResource(R.plurals.mesh_gw_uploading_n, mesh.uploadingIds.size, mesh.uploadingIds.size))
        }
        val last = mesh.lastUpload
        Text(
            when {
                last == null -> stringResource(R.string.mesh_gw_last_none)
                last.ok -> stringResource(R.string.mesh_gw_last_ok, ageText(last.atMs, now))
                else -> stringResource(R.string.mesh_gw_last_failed, ageText(last.atMs, now), last.detail ?: "?")
            },
            style = MaterialTheme.typography.bodyMedium,
            color = if (last != null && !last.ok) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun GpsCard(mesh: MeshSnapshot, system: SystemStatus, modifier: Modifier) {
    ElevatedSection(modifier) {
        CardTitle(Icons.Rounded.GpsFixed, stringResource(R.string.mesh_gps_title))
        GpsLine(mesh.gps, system.locationPermission && system.locationOn)
    }
}

@Composable
private fun ProfileSyncCard(mesh: MeshSnapshot, modifier: Modifier) {
    val kind = com.beacon.mesh.ui.logic.ProfileStatusLogic.chip(mesh.profile)
    ElevatedSection(modifier) {
        CardTitle(Icons.Rounded.Person, stringResource(R.string.profile_title))
        Text(stringResource(profileChipLabel(kind)), style = MaterialTheme.typography.titleLargeEmphasized)
        profileErrorText(mesh.profile.lastError)?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
