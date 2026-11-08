package com.beacon.mesh.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.CloudUpload
import androidx.compose.material.icons.rounded.HourglassTop
import androidx.compose.material.icons.rounded.PauseCircle
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.logic.AgeUnit
import com.beacon.mesh.ui.logic.MessageItem
import com.beacon.mesh.ui.logic.MessageStatus
import com.beacon.mesh.ui.logic.MessageUi
import com.beacon.mesh.ui.theme.LocalCategoryColors

@Composable
fun ageText(fromMs: Long, nowMs: Long): String {
    val a = MessageUi.age(fromMs, nowMs)
    return when (a.unit) {
        AgeUnit.NOW -> stringResource(R.string.age_now)
        AgeUnit.MINUTES -> stringResource(R.string.age_minutes, a.amount)
        AgeUnit.HOURS -> stringResource(R.string.age_hours, a.amount)
        AgeUnit.DAYS -> stringResource(R.string.age_days, a.amount)
    }
}

@Composable
fun statusText(item: MessageItem): String = when (item.status) {
    MessageStatus.QUEUED -> stringResource(R.string.status_queued)
    MessageStatus.RELAYED -> pluralStringResource(R.plurals.status_relayed, item.relayedTo, item.relayedTo)
    MessageStatus.UPLOADING -> stringResource(R.string.status_uploading)
    MessageStatus.DELIVERED -> stringResource(R.string.status_delivered)
    MessageStatus.RELAYING -> stringResource(R.string.status_relaying)
    MessageStatus.HELD -> stringResource(R.string.status_held)
    MessageStatus.REJECTED -> stringResource(R.string.status_rejected)
    MessageStatus.ASSIGNED -> stringResource(R.string.status_assigned)
    MessageStatus.EN_ROUTE -> item.etaMinutes?.let { stringResource(R.string.status_en_route_eta, it) } ?: stringResource(R.string.status_en_route)
    MessageStatus.ON_SCENE -> stringResource(R.string.status_on_scene)
    MessageStatus.RESOLVED -> stringResource(R.string.status_resolved)
}

/** (icon, container, content) for a status pill. */
@Composable
fun statusStyle(status: MessageStatus): Triple<ImageVector, Color, Color> {
    val c = LocalCategoryColors.current
    val s = MaterialTheme.colorScheme
    return when (status) {
        MessageStatus.QUEUED -> Triple(Icons.Rounded.HourglassTop, c.warnContainer, c.onWarnContainer)
        MessageStatus.RELAYED -> Triple(Icons.Rounded.Wifi, s.secondaryContainer, s.onSecondaryContainer)
        MessageStatus.UPLOADING -> Triple(Icons.Rounded.CloudUpload, s.tertiaryContainer, s.onTertiaryContainer)
        MessageStatus.DELIVERED -> Triple(Icons.Rounded.CloudDone, c.safeContainer, c.onSafeContainer)
        MessageStatus.RELAYING -> Triple(Icons.Rounded.Sync, s.secondaryContainer, s.onSecondaryContainer)
        MessageStatus.HELD -> Triple(Icons.Rounded.PauseCircle, s.surfaceVariant, s.onSurfaceVariant)
        MessageStatus.REJECTED -> Triple(Icons.Rounded.PauseCircle, s.errorContainer, s.onErrorContainer)
        MessageStatus.ASSIGNED, MessageStatus.EN_ROUTE, MessageStatus.ON_SCENE, MessageStatus.RESOLVED ->
            Triple(Icons.Rounded.CloudDone, c.safeContainer, c.onSafeContainer)
    }
}

@Composable
fun StatusPill(item: MessageItem, modifier: Modifier = Modifier) {
    val (icon, bg, fg) = statusStyle(item.status)
    Pill(statusText(item), bg, fg, icon, modifier)
}

/** "hop 2/10 via A1B7 → C3D4" (or "origin" for own messages). */
@Composable
fun hopLine(item: MessageItem): String {
    val route = MessageUi.route(item)
    val via = if (route.isEmpty()) stringResource(R.string.route_origin) else route.joinToString(" → ")
    return stringResource(R.string.hop_line, item.hop, item.maxHops, via)
}

@Composable
fun MessageCard(
    item: MessageItem,
    nowMs: Long,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHaptics.current
    val style = categoryStyle(item.categoryWire)
    val label = stringResource(style.label)
    val age = ageText(item.createdAt, nowMs)
    val hop = hopLine(item)
    val status = statusText(item)
    val mine = if (item.isOwn) stringResource(R.string.label_mine) else ""
    Card(
        onClick = haptics.onClick(HapticEvent.LightTap, onClick),
        modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            contentDescription = listOf(label, mine, age, hop, status, item.text.orEmpty()).filter { it.isNotBlank() }.joinToString(", ")
        },
        shape = MaterialTheme.shapes.largeIncreased,
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Pill(label, style.container, style.content, style.icon)
                if (item.isOwn) Pill(mine, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
                Text(age, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item.text?.let {
                Text(it, style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            Text(hop, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            item.welfare?.let { com.beacon.mesh.ui.welfare.WelfareLine(it) }
            Row { StatusPill(item) }
        }
    }
}
