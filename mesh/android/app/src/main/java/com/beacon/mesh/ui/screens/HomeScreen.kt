package com.beacon.mesh.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.SignalCellularConnectedNoInternet0Bar
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FloatingActionButtonMenu
import androidx.compose.material3.FloatingActionButtonMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ToggleFloatingActionButton
import androidx.compose.material3.ToggleFloatingActionButtonDefaults.animateIcon
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalConfiguration
import com.beacon.mesh.GpsFix
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.ui.SystemStatus
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.EmptyState
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.MessageCard
import com.beacon.mesh.ui.components.MorphShape
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.components.categoryLabel
import com.beacon.mesh.ui.components.categoryStyle
import com.beacon.mesh.ui.components.rememberNow
import com.beacon.mesh.ui.logic.MessageItem
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.theme.LocalReduceMotion
import androidx.graphics.shapes.Morph

private val BigFour = listOf(Category.INJURED, Category.TRAPPED, Category.WATER_MEDS, Category.SAFE)
private val MoreMenu = listOf(Category.CHECKIN, Category.MEDICAL, Category.OTHER)

@Composable
fun HomeScreen(
    mesh: MeshSnapshot,
    items: List<MessageItem>,
    system: SystemStatus,
    onSos: (Category) -> Unit,
    onOpenMessage: (String) -> Unit,
    onFixSetup: () -> Unit,
    onOpenMesh: () -> Unit,
    onCheckinReply: (com.beacon.mesh.store.CheckinPrompt, String) -> Unit = { _, _ -> },
) {
    val haptics = LocalHaptics.current
    var menuOpen by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = menuOpen) { menuOpen = false }
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    val now = rememberNow()

    ScreenScaffold(
        title = null,
        floatingActionButton = {
            FloatingActionButtonMenu(
                expanded = menuOpen,
                button = {
                    ToggleFloatingActionButton(
                        checked = menuOpen,
                        onCheckedChange = { menuOpen = it; haptics.perform(if (it) HapticEvent.Expand else HapticEvent.Collapse) },
                        modifier = Modifier.semantics { stateDescription = "" },
                    ) {
                        val image = if (checkedProgress > 0.5f) Icons.Rounded.Close else Icons.Rounded.Add
                        Icon(
                            image,
                            contentDescription = stringResource(R.string.home_more_alerts),
                            modifier = Modifier.animateIcon({ checkedProgress }),
                        )
                    }
                },
            ) {
                MoreMenu.forEach { cat ->
                    val st = categoryStyle(cat.wire)
                    FloatingActionButtonMenuItem(
                        onClick = haptics.onClick(HapticEvent.SheetOpen) { menuOpen = false; onSos(cat) },
                        icon = { Icon(st.icon, null) },
                        text = { Text(stringResource(st.label)) },
                    )
                }
            }
        },
    ) { pad ->
        ScrollColumn(pad) {
            if (!system.readiness.canRunMesh) {
                SetupBanner(onFixSetup)
            } else {
                MeshSummary(mesh, system, onOpenMesh)
            }
            mesh.checkins.forEach { c -> CheckinCard(c, onReply = { onCheckinReply(c, it) }) }

            SectionTitle(stringResource(R.string.home_send_title))
            val perRow = if (wide) 4 else 2
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                maxItemsInEachRow = perRow,
                modifier = Modifier.fillMaxWidth(),
            ) {
                BigFour.forEach { cat -> SosTile(cat, onClick = { onSos(cat) }, modifier = Modifier.weight(1f)) }
            }
            Text(
                stringResource(R.string.home_tile_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionTitle(stringResource(R.string.home_my_alerts))
            val mine = items.filter { it.isOwn }.take(3)
            if (mine.isEmpty()) {
                EmptyState(
                    icon = Icons.Rounded.Hub,
                    title = stringResource(R.string.home_empty_title),
                    body = stringResource(R.string.home_empty_body),
                )
            } else {
                mine.forEach { MessageCard(it, now, selected = false, onClick = { onOpenMessage(it.id) }) }
            }
            // Room so the floating menu never covers the last card.
            Spacer(Modifier.height(88.dp))
        }
    }
}

@Composable
private fun SosTile(category: Category, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val st = categoryStyle(category.wire)
    val haptics = LocalHaptics.current
    Button(
        // Opens the SOS sheet, so the sheet-open effect is the only feedback (no tap + sheet double).
        onClick = haptics.onClick(HapticEvent.SheetOpen, onClick),
        shapes = ButtonDefaults.shapes(),
        colors = ButtonDefaults.buttonColors(containerColor = st.strong, contentColor = st.onStrong),
        contentPadding = PaddingValues(16.dp),
        modifier = modifier.heightIn(min = 136.dp),
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(st.icon, contentDescription = null, modifier = Modifier.size(40.dp))
            Text(
                stringResource(st.label),
                style = MaterialTheme.typography.titleLargeEmphasized,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SetupBanner(onFix: () -> Unit) {
    val haptics = LocalHaptics.current
    ElevatedSection(container = MaterialTheme.colorScheme.errorContainer) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Rounded.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
            Text(
                stringResource(R.string.home_setup_title),
                style = MaterialTheme.typography.titleMediumEmphasized,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
        }
        Text(
            stringResource(R.string.home_setup_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
        Button(
            onClick = haptics.onClick(action = onFix),
            shapes = ButtonDefaults.shapes(),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(stringResource(R.string.home_setup_action)) }
    }
}

/** Peers, gateway state and GPS at a glance. The badge morphs between shapes when the role changes. */
@Composable
private fun MeshSummary(mesh: MeshSnapshot, system: SystemStatus, onOpenMesh: () -> Unit) {
    val haptics = LocalHaptics.current
    val reduce = LocalReduceMotion.current
    val morph = remember { Morph(MaterialShapes.Circle, MaterialShapes.SoftBurst) }
    val target = if (mesh.isGateway) 1f else 0f
    val progress by animateFloatAsState(target, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "badge")
    val searching = mesh.peers.isEmpty()
    ElevatedSection(container = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(
                Modifier.size(64.dp)
                    .clip(MorphShape(morph, if (reduce) target else progress.coerceIn(0f, 1f)))
                    .background(if (mesh.isGateway) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.secondaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                if (searching && !reduce) {
                    LoadingIndicator(Modifier.size(48.dp))
                } else {
                    Icon(
                        if (mesh.isGateway) Icons.Rounded.CloudUpload else Icons.Rounded.Hub,
                        contentDescription = null,
                        tint = if (mesh.isGateway) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
            }
            Column(Modifier.weight(1f)) {
                Text(
                    if (searching) stringResource(R.string.home_searching)
                    else pluralStringResource(R.plurals.home_peers, mesh.peers.size, mesh.peers.size),
                    style = MaterialTheme.typography.titleLargeEmphasized,
                )
                Text(
                    stringResource(if (mesh.isGateway) R.string.home_role_gateway else R.string.home_role_relay),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        GpsLine(mesh.gps, system.locationPermission && system.locationOn)
        TextButton(onClick = haptics.onClick(HapticEvent.Navigate, onOpenMesh), modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.home_open_mesh))
        }
    }
}
