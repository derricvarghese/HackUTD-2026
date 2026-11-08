package com.beacon.mesh.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Map
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingToolbarDefaults
import androidx.compose.material3.HorizontalFloatingToolbar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.EmptyState
import com.beacon.mesh.ui.components.MessageCard
import com.beacon.mesh.ui.components.Pill
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.components.StatusPill
import com.beacon.mesh.ui.components.ageText
import com.beacon.mesh.ui.components.categoryStyle
import com.beacon.mesh.ui.components.hopLine
import com.beacon.mesh.ui.components.rememberNow
import com.beacon.mesh.ui.components.statusText
import com.beacon.mesh.ui.logic.MessageItem
import com.beacon.mesh.ui.logic.MessageStatus
import com.beacon.mesh.ui.logic.MessageUi
import kotlinx.coroutines.launch
import androidx.compose.ui.platform.ClipEntry
import android.content.ClipData
import java.text.DateFormat
import java.util.Date

/**
 * Held and received messages. A ListDetailPaneScaffold shows list and detail side by side on wide
 * windows and as a stack on phones; its navigator handles predictive back (the detail slides away
 * under the finger) before the app's NavHost sees the gesture.
 */
@Composable
fun MessagesScreen(
    items: List<MessageItem>,
    relayId: String,
    requestedId: String?,
    onRequestConsumed: () -> Unit,
) {
    val haptics = LocalHaptics.current
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val scope = rememberCoroutineScope()
    var filter by rememberSaveable { mutableStateOf(MessageUi.Filter.ALL) }
    val now = rememberNow()

    LaunchedEffect(requestedId) {
        if (requestedId != null) {
            navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, requestedId)
            onRequestConsumed()
        }
    }

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AnimatedPane {
                ScreenScaffold(title = stringResource(R.string.nav_messages)) { pad ->
                    MessageList(
                        items = MessageUi.filter(items, filter),
                        allEmpty = items.isEmpty(),
                        filter = filter,
                        onFilter = { filter = it },
                        selectedId = navigator.currentDestination?.contentKey,
                        now = now,
                        padding = pad,
                        onOpen = { id -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, id) } },
                    )
                }
            }
        },
        detailPane = {
            AnimatedPane {
                val id = navigator.currentDestination?.contentKey
                val item = items.firstOrNull { it.id == id }
                val canGoBack = navigator.scaffoldDirective.maxHorizontalPartitions == 1
                ScreenScaffold(
                    title = stringResource(R.string.detail_title),
                    navigationIcon = {
                        if (canGoBack) {
                            IconButton(onClick = haptics.onClick(HapticEvent.Navigate) { scope.launch { navigator.navigateBack() } }) {
                                Icon(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.action_back))
                            }
                        }
                    },
                ) { pad ->
                    if (item == null) {
                        Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
                            EmptyState(Icons.Rounded.Inbox, stringResource(R.string.detail_none_title), stringResource(R.string.detail_none_body))
                        }
                    } else {
                        MessageDetail(item, relayId, now, pad)
                    }
                }
            }
        },
    )
}

@Composable
private fun MessageList(
    items: List<MessageItem>,
    allEmpty: Boolean,
    filter: MessageUi.Filter,
    onFilter: (MessageUi.Filter) -> Unit,
    selectedId: String?,
    now: Long,
    padding: PaddingValues,
    onOpen: (String) -> Unit,
) {
    val haptics = LocalHaptics.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp, end = 16.dp, top = padding.calculateTopPadding() + 8.dp,
            bottom = padding.calculateBottomPadding() + 16.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MessageUi.Filter.entries.forEach { f ->
                    FilterChip(
                        selected = f == filter,
                        onClick = { if (f != filter) haptics.perform(HapticEvent.Select); onFilter(f) },
                        label = {
                            Text(
                                stringResource(
                                    when (f) {
                                        MessageUi.Filter.ALL -> R.string.filter_all
                                        MessageUi.Filter.MINE -> R.string.filter_mine
                                        MessageUi.Filter.RECEIVED -> R.string.filter_received
                                        MessageUi.Filter.HELD -> R.string.filter_held
                                    }
                                )
                            )
                        },
                    )
                }
            }
        }
        if (items.isEmpty()) {
            item {
                EmptyState(
                    icon = Icons.Rounded.Inbox,
                    title = stringResource(if (allEmpty) R.string.messages_empty_title else R.string.messages_filter_empty_title),
                    body = stringResource(if (allEmpty) R.string.messages_empty_body else R.string.messages_filter_empty_body),
                )
            }
        }
        items(items, key = { it.id }) { m ->
            MessageCard(m, now, selected = m.id == selectedId, onClick = { onOpen(m.id) })
        }
    }
}

@Composable
private fun MessageDetail(item: MessageItem, relayId: String, now: Long, pad: PaddingValues) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val style = categoryStyle(item.categoryWire)
    val label = stringResource(style.label)
    val format = remember(item.id) { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    val hasLocation = item.lat != null && item.lng != null
    val hop = hopLine(item)
    val status = statusText(item)
    val copyLabel = stringResource(R.string.detail_copy_id)
    val shareLabel = stringResource(R.string.detail_share)
    val mapLabel = stringResource(R.string.detail_open_map)
    val shareText = stringResource(R.string.detail_share_text, label, item.text.orEmpty(), hop)

    Box(Modifier.fillMaxSize()) {
        ScrollColumn(pad) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                BadgeIcon(style.icon, style.container, style.content, size = 64.dp)
                androidx.compose.foundation.layout.Column {
                    Text(label, style = MaterialTheme.typography.headlineMediumEmphasized)
                    Text(
                        stringResource(R.string.detail_created, ageText(item.createdAt, now)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row { StatusPill(item) }
            if (item.statusMessage != null || item.rejectReason != null) {
                ElevatedSection {
                    SectionTitle(stringResource(R.string.detail_backend_status))
                    item.statusMessage?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
                    item.etaMinutes?.let { Text(stringResource(R.string.detail_eta, it), style = MaterialTheme.typography.titleMediumEmphasized) }
                    item.rejectReason?.let { Text(stringResource(R.string.detail_rejected_reason, it), color = MaterialTheme.colorScheme.error) }
                }
            }
            item.text?.let {
                ElevatedSection { SectionTitle(stringResource(R.string.detail_note)); Text(it, style = MaterialTheme.typography.bodyLarge) }
            }
            item.people?.let {
                ElevatedSection {
                    SectionTitle(stringResource(R.string.sos_people_label))
                    Text("$it", style = MaterialTheme.typography.headlineSmallEmphasized)
                }
            }
            ElevatedSection {
                SectionTitle(stringResource(R.string.detail_route))
                Text(hop, style = MaterialTheme.typography.bodyLarge)
                RouteChips(item, relayId)
                Text(
                    stringResource(
                        when (item.status) {
                            MessageStatus.QUEUED -> R.string.detail_explain_queued
                            MessageStatus.RELAYED -> R.string.detail_explain_relayed
                            MessageStatus.UPLOADING -> R.string.detail_explain_uploading
                            MessageStatus.DELIVERED -> R.string.detail_explain_delivered
                            MessageStatus.RELAYING -> R.string.detail_explain_relaying
                            MessageStatus.HELD -> R.string.detail_explain_held
                            MessageStatus.REJECTED -> R.string.detail_explain_rejected
                            MessageStatus.ASSIGNED -> R.string.detail_explain_assigned
                            MessageStatus.EN_ROUTE -> R.string.detail_explain_en_route
                            MessageStatus.ON_SCENE -> R.string.detail_explain_on_scene
                            MessageStatus.RESOLVED -> R.string.detail_explain_resolved
                        }
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (hasLocation) {
                ElevatedSection {
                    SectionTitle(stringResource(R.string.detail_location))
                    Text(
                        "%.5f, %.5f".format(item.lat, item.lng) +
                            (item.accuracyM?.let { "  ±${it.toInt()} m" } ?: ""),
                        style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                    )
                }
            }
            ElevatedSection {
                SectionTitle(stringResource(R.string.detail_technical))
                Text(stringResource(R.string.detail_id, item.id), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                Text(stringResource(R.string.detail_expires, format.format(Date(item.expiresAt))), style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(96.dp))
        }
        HorizontalFloatingToolbar(
            expanded = true,
            colors = FloatingToolbarDefaults.vibrantFloatingToolbarColors(),
            modifier = Modifier.align(Alignment.BottomCenter).padding(pad).padding(bottom = 16.dp),
        ) {
            IconButton(onClick = haptics.onClick(HapticEvent.Success) {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("id", item.id))) }
            }) { Icon(Icons.Rounded.ContentCopy, copyLabel) }
            IconButton(onClick = haptics.onClick {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, shareText)
                context.startActivity(Intent.createChooser(send, shareLabel))
            }) { Icon(Icons.Rounded.Share, shareLabel) }
            if (hasLocation) {
                IconButton(onClick = haptics.onClick {
                    val geo = Intent(Intent.ACTION_VIEW, Uri.parse("geo:${item.lat},${item.lng}?q=${item.lat},${item.lng}"))
                    try { context.startActivity(geo) } catch (_: Exception) {}
                }) { Icon(Icons.Rounded.Map, mapLabel) }
            }
        }
    }
}

/** origin -> relay ids -> you, as a wrapping chain of pills. */
@Composable
private fun RouteChips(item: MessageItem, relayId: String) {
    val origin = stringResource(R.string.route_origin)
    val you = stringResource(R.string.route_you)
    val nodes = buildList {
        if (item.isOwn) add(you) else {
            val ids = MessageUi.route(item)
            if (ids.isEmpty()) add(origin) else addAll(ids)
            add(you)
        }
    }
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        nodes.forEachIndexed { i, n ->
            val last = i == nodes.lastIndex
            Pill(
                if (last && !item.isOwn) "$n ($relayId)" else n,
                if (last) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                if (last) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!last) Text("→", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
