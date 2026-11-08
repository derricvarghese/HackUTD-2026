package com.beacon.mesh.ui.responder

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.Bluetooth
import androidx.compose.material.icons.rounded.CenterFocusStrong
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.FilterAlt
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.beacon.mesh.R
import com.beacon.mesh.responder.CaseFilter
import com.beacon.mesh.responder.CaseRules
import com.beacon.mesh.responder.Connection
import com.beacon.mesh.responder.MapTarget
import com.beacon.mesh.responder.MapTargets
import com.beacon.mesh.responder.ResponderAccount
import com.beacon.mesh.responder.ResponderCase
import com.beacon.mesh.responder.ResponderException
import com.beacon.mesh.responder.ResponderState
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.ui.components.EmptyState
import com.beacon.mesh.ui.components.Pill
import com.beacon.mesh.ui.components.categoryLabel
import com.beacon.mesh.ui.components.categoryStyle
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.ui.semantics.stateDescription
import com.beacon.mesh.ui.components.rememberNow
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.theme.LocalCategoryColors

/** Width at which the case list/detail moves beside the map instead of below / over it. */
private val SideBySide = 600.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ResponderDashboard(
    vm: ResponderViewModel,
    state: ResponderState,
    meshMessages: List<StoredMessage>,
    dark: Boolean,
) {
    val account = state.account ?: return
    val haptics = LocalHaptics.current
    val context = LocalContext.current
    val selectedId by vm.selectedId.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    val showMesh by vm.showMesh.collectAsStateWithLifecycle()
    val detail by vm.detail.collectAsStateWithLifecycle()
    val fitToken by vm.fitToken.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val now = rememberNow()

    val meshTitleFmt = stringResource(R.string.responder_mesh_title, "%s")
    val unnamed = stringResource(R.string.responder_unnamed)
    val categoryTitles = mapOf(
        "trapped" to categoryLabel("trapped"), "injured" to categoryLabel("injured"), "medical" to categoryLabel("medical"),
        "water_meds" to categoryLabel("water_meds"), "safe" to categoryLabel("safe"), "checkin" to categoryLabel("checkin"),
        "other" to categoryLabel("other"),
    )

    val ranked = remember(state.cases, account) { CaseRules.ranked(state.cases, account) }
    val visible = remember(ranked, filter, account) { CaseRules.applyFilter(ranked, filter, account) }
    val meshTargets = remember(meshMessages, state.cases, showMesh, now, categoryTitles) {
        if (!showMesh) emptyList()
        else MapTargets.fromMesh(meshMessages, state.cases.map { it.id }.toSet(), System.currentTimeMillis()) { cat ->
            meshTitleFmt.replace("%s", categoryTitles[cat] ?: categoryTitles.getValue("other"))
        }
    }
    val caseTitles = categoryTitles
    val serverTargets = remember(visible, account, caseTitles, unnamed) {
        visible.map { c -> MapTargets.fromCase(c, c.displayName ?: caseTitles[appCategory(c.category)] ?: unnamed, account) }
    }
    val targets = serverTargets + meshTargets
    val selectedCase = state.cases.firstOrNull { it.id == selectedId }
    val selectedMesh = meshTargets.firstOrNull { it.id == selectedId }

    // A selected case that disappeared (resolved elsewhere) closes its panel.
    LaunchedEffect(selectedId, state.loaded, selectedCase == null, selectedMesh == null) {
        if (selectedId != null && state.loaded && selectedCase == null && selectedMesh == null) vm.select(null)
    }

    // Haptics for results: a failure buzzes, an action that finished without error confirms.
    LaunchedEffect(state.error) { if (state.error != null) haptics.perform(HapticEvent.Error) }
    var wasBusy by remember { mutableStateOf(false) }
    LaunchedEffect(state.busy) {
        if (wasBusy && !state.busy && state.error == null) haptics.perform(HapticEvent.Success)
        wasBusy = state.busy
    }

    val actions = remember(selectedCase?.id, vm) {
        CaseActions(
            onClaim = { selectedCase?.let(vm::claim) },
            onAdvance = { s, o -> selectedCase?.let { vm.advance(it, s, o) } },
            onAddNote = { text, done -> selectedCase?.let { vm.addNote(it, text, done) } ?: done(false) },
            onRetryDetail = vm::retryDetail,
            onAddPhoto = { bytes, caption, done ->
                selectedCase?.let { c ->
                    val imageId = java.util.UUID.randomUUID().toString().lowercase()
                    vm.uploadImage(c.id, imageId, bytes, caption, done)
                } ?: done(false)
            },
            onGetImageBytes = { imageId ->
                selectedCase?.let { c -> vm.fetchImageBytes(c.id, imageId) }
            },
        )
    }

    var menu by remember { mutableStateOf(false) }
    var shareSheet by rememberSaveable { mutableStateOf(false) }
    val share by vm.share.collectAsStateWithLifecycle()
    val notice by vm.shareNotice.collectAsStateWithLifecycle()
    PermissionWatcher(vm, true)

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.responder_title), maxLines = 1) },
                actions = {
                    ConnectionPill(state.connection)
                    IconButton(onClick = haptics.onClick { shareSheet = true }) { Icon(Icons.Rounded.Tune, stringResource(R.string.responder_share_open)) }
                    IconButton(onClick = haptics.onClick { vm.fitAll() }) { Icon(Icons.Rounded.CenterFocusStrong, stringResource(R.string.responder_fit)) }
                    IconButton(onClick = haptics.onClick { vm.refresh() }) { Icon(Icons.Rounded.Refresh, stringResource(R.string.responder_refresh)) }
                    Box {
                        IconButton(onClick = haptics.onClick { menu = true }) {
                            Icon(Icons.Rounded.AccountCircle, stringResource(R.string.responder_account_menu))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            Text(
                                stringResource(R.string.responder_signed_in_as, account.name, account.role),
                                Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.titleSmall,
                            )
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.responder_show_mesh)) },
                                leadingIcon = { Icon(Icons.Rounded.Bluetooth, null) },
                                trailingIcon = { Checkbox(checked = showMesh, onCheckedChange = null) },
                                onClick = { haptics.toggle(!showMesh); vm.setShowMesh(!showMesh) },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.responder_sign_out)) },
                                onClick = { haptics.perform(HapticEvent.Warning); menu = false; vm.signOut() },
                            )
                        }
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
        SharingBanner(share, onOpen = { shareSheet = true }, onStop = vm::disableSharing)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val sideBySide = maxWidth >= SideBySide
            val listPanel: @Composable (Modifier) -> Unit = { m ->
                CasePanel(
                    modifier = m, state = state, visible = visible, meshTargets = meshTargets, filter = filter,
                    selectedId = selectedId, account = account, now = now,
                    onFilter = vm::setFilter, onSelect = vm::select, onDismissError = vm::clearError,
                    refreshing = refreshing, onRefresh = vm::refresh,
                )
            }
            val map: @Composable (Modifier) -> Unit = { m ->
                Box(m) {
                    ResponderMap(targets, selectedId, fitToken, dark, onSelect = { haptics.perform(HapticEvent.LightTap); vm.select(it) }, modifier = Modifier.fillMaxSize())
                    Legend(Modifier.align(Alignment.TopStart).padding(8.dp))
                }
            }
            if (sideBySide) {
                Row(Modifier.fillMaxSize()) {
                    AnimatedContent(
                        targetState = selectedCase?.id,
                        transitionSpec = { fadeIn() togetherWith fadeOut() },
                        modifier = Modifier.width(400.dp).fillMaxHeight(),
                        label = "responder-pane",
                    ) { id ->
                        val c = state.cases.firstOrNull { it.id == id }
                        if (c == null) {
                            listPanel(Modifier.fillMaxSize())
                        } else {
                            BackHandler { vm.select(null) }
                            Column(Modifier.fillMaxSize()) {
                                TextButton(onClick = haptics.onClick(HapticEvent.Navigate) { vm.select(null) }) {
                                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, null)
                                    Text(stringResource(R.string.responder_back_to_list), Modifier.padding(start = 8.dp))
                                }
                                CaseDetailContent(
                                    c, detail, account, state.busy, state.error, now, actions,
                                    Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp),
                                )
                            }
                        }
                    }
                    map(Modifier.weight(1f).fillMaxHeight())
                }
                selectedMesh?.let { MeshInfoDialog(it) { vm.select(null) } }
            } else {
                // Fixed map height (a share of the window, within limits) so the list header and chips below are never covered,
                // whatever the window size, keyboard or font scale.
                val mapHeight = (maxHeight * 0.4f).coerceIn(150.dp, 400.dp).coerceAtMost(maxHeight * 0.5f)
                Column(Modifier.fillMaxSize()) {
                    map(Modifier.fillMaxWidth().height(mapHeight))
                    listPanel(Modifier.weight(1f).fillMaxWidth())
                }
                if (selectedCase != null) {
                    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
                    LaunchedEffect(Unit) { haptics.perform(HapticEvent.SheetOpen) }
                    ModalBottomSheet(onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); vm.select(null) }, sheetState = sheet) {
                        CaseDetailContent(
                            selectedCase, detail, account, state.busy, state.error, now, actions,
                            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp),
                        )
                    }
                }
                selectedMesh?.let { MeshInfoDialog(it) { vm.select(null) } }
            }
        }
        }
    }
    if (shareSheet) {
        ShareSheet(
            share, state.available, notice,
            onEnable = { vm.enableSharing(it) }, onDisable = vm::disableSharing, onResume = { vm.resumeSharing(it) },
            onAvailable = vm::setAvailable, onDismiss = { shareSheet = false; vm.clearShareNotice() },
        )
    }
}

@Composable
private fun ConnectionPill(c: Connection) {
    val cat = LocalCategoryColors.current
    val (text, desc, container, content) = when (c) {
        Connection.LIVE -> Quad(stringResource(R.string.responder_live), stringResource(R.string.responder_live_desc), cat.safeContainer, cat.onSafeContainer)
        Connection.CONNECTING -> Quad(stringResource(R.string.responder_connecting), stringResource(R.string.responder_connecting), MaterialTheme.colorScheme.surfaceContainerHigh, MaterialTheme.colorScheme.onSurface)
        Connection.RECONNECTING -> Quad(stringResource(R.string.responder_reconnecting), stringResource(R.string.responder_reconnecting_desc), cat.warnContainer, cat.onWarnContainer)
        Connection.IDLE -> Quad(stringResource(R.string.responder_idle), stringResource(R.string.responder_idle), MaterialTheme.colorScheme.surfaceContainerHigh, MaterialTheme.colorScheme.onSurface)
    }
    Pill(
        text, container, content,
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = desc; liveRegion = LiveRegionMode.Polite },
    )
}

private data class Quad(val a: String, val b: String, val c: Color, val d: Color)

@Composable
private fun Legend(modifier: Modifier) {
    Surface(modifier, shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)) {
        Column(Modifier.padding(8.dp)) {
            Text(stringResource(R.string.responder_legend_circle), style = MaterialTheme.typography.labelSmall)
            Text(stringResource(R.string.responder_legend_claim), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun MeshInfoDialog(t: MapTarget, onDismiss: () -> Unit) {
    val haptics = LocalHaptics.current
    androidx.compose.material3.AlertDialog(
        onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); onDismiss() },
        title = { Text(t.title) },
        text = { Text(stringResource(R.string.responder_mesh_info, com.beacon.mesh.units.Units.formatDistance(1000.0, com.beacon.mesh.ui.LocalUnitSystem.current, com.beacon.mesh.ui.currentLocale()))) },
        confirmButton = { TextButton(onClick = haptics.onClick { onDismiss() }) { Text(stringResource(R.string.state_done)) } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CasePanel(
    modifier: Modifier,
    state: ResponderState,
    visible: List<ResponderCase>,
    meshTargets: List<MapTarget>,
    filter: CaseFilter,
    selectedId: String?,
    account: ResponderAccount,
    now: Long,
    onFilter: (CaseFilter) -> Unit,
    onSelect: (String?) -> Unit,
    onDismissError: () -> Unit,
    refreshing: Boolean,
    onRefresh: () -> Unit,
) {
    val haptics = LocalHaptics.current
    var meshOpen by rememberSaveable { mutableStateOf(false) }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 10.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(openCasesText(state.cases.size), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            state.lastUpdatedMs?.let {
                Text(stringResource(R.string.responder_updated, agoText(it, now)), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(CaseFilter.entries.toList()) { f ->
                FilterChip(
                    selected = filter == f,
                    onClick = haptics.onSelect { onFilter(f) },
                    label = { Text(filterLabel(f)) },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
        state.error?.let { e ->
            if (e.kind != ResponderException.Kind.SIGNED_OUT) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                    Text(errorText(e), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    IconButton(onClick = haptics.onClick { onDismissError() }) { Icon(Icons.Rounded.Close, stringResource(R.string.action_dismiss)) }
                }
            }
        }
        androidx.compose.material3.pulltorefresh.PullToRefreshBox(isRefreshing = refreshing, onRefresh = { haptics.perform(HapticEvent.LightTap); onRefresh() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (visible.isEmpty() && meshTargets.isEmpty()) item {
                when {
                    !state.loaded -> EmptyState(Icons.Rounded.Inbox, stringResource(R.string.responder_loading), stringResource(R.string.responder_loading_body), loading = true)
                    state.cases.isEmpty() -> EmptyState(Icons.Rounded.Inbox, stringResource(R.string.responder_empty_title), stringResource(R.string.responder_empty_body))
                    else -> EmptyState(Icons.Rounded.FilterAlt, stringResource(R.string.responder_no_match_title), stringResource(R.string.responder_no_match_body))
                }
            }
            items(visible, key = { it.id }) { c ->
                CaseRow(c, c.isMine(account), c.id == selectedId, now) { haptics.perform(HapticEvent.LightTap); onSelect(c.id) }
            }
            if (meshTargets.isNotEmpty()) {
                item(key = "mesh-group") { MeshGroupHeader(meshTargets.size, meshOpen) { haptics.toggle(!meshOpen); meshOpen = !meshOpen } }
                if (meshOpen) items(meshTargets, key = { it.id }) { t ->
                    MeshRow(t, t.id == selectedId) { haptics.perform(HapticEvent.LightTap); onSelect(t.id) }
                }
            }
        }
        }
    }
}

@Composable
private fun filterLabel(f: CaseFilter) = stringResource(
    when (f) {
        CaseFilter.ALL -> R.string.responder_filter_all
        CaseFilter.CRITICAL -> R.string.responder_filter_critical
        CaseFilter.SILENT -> R.string.responder_filter_silent
        CaseFilter.MINE -> R.string.responder_filter_mine
        CaseFilter.UNCLAIMED -> R.string.responder_filter_unclaimed
    },
)

@Composable
private fun CaseRow(c: ResponderCase, mine: Boolean, selected: Boolean, now: Long, onClick: () -> Unit) {
    val style = categoryStyle(appCategory(c.category))
    val (toneBg, toneFg) = toneColors(CaseRules.tone(c))
    val title = caseTitle(c)
    val catName = stringResource(style.label)
    val status = statusText(c.status)
    val ago = agoText(c.lastHeardAtMs, now)
    val summary = stringResource(R.string.responder_row_summary, title, catName, c.score, status, ago) +
        (if (mine) ", " + stringResource(R.string.responder_badge_yours) else "") +
        (if (c.silent) ", " + stringResource(R.string.responder_silent_badge) else "") +
        (if (c.unresponsive) ", " + stringResource(R.string.responder_unresponsive_badge) else "")
    Card(
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
            .semantics(mergeDescendants = true) { contentDescription = summary; this.selected = selected }
            .clickable(role = Role.Button, onClick = onClick),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        ),
        border = if (mine) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            com.beacon.mesh.ui.components.BadgeIcon(style.icon, toneBg, toneFg, size = 44.dp)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (mine) Pill(stringResource(R.string.responder_badge_yours), MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.onPrimary)
                    if (c.silent) Icon(Icons.Rounded.NotificationsOff, stringResource(R.string.responder_silent_badge), Modifier.size(18.dp), tint = LocalCategoryColors.current.warn)
                }
                Text(
                    stringResource(R.string.responder_row_sub, catName, status, ago),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                c.hop?.let { h ->
                    if (h.hopCount != null && h.maxHops != null) {
                        Text(
                            stringResource(R.string.responder_hops_value, h.hopCount, h.maxHops),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Text(
                c.score.toString(),
                style = MaterialTheme.typography.titleLarge,
                color = if (c.score >= CaseRules.CRITICAL_SCORE) LocalCategoryColors.current.danger else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun MeshGroupHeader(count: Int, open: Boolean, onToggle: () -> Unit) {
    val label = stringResource(R.string.responder_mesh_group, count)
    val stateText = stringResource(if (open) R.string.responder_mesh_group_open else R.string.responder_mesh_group_closed)
    Card(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .semantics(mergeDescendants = true) { contentDescription = label; stateDescription = stateText }
            .clickable(role = Role.Button, onClick = onToggle),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Rounded.Bluetooth, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.responder_mesh_row_sub), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(if (open) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, null)
        }
    }
}

@Composable
private fun MeshRow(t: MapTarget, selected: Boolean, onClick: () -> Unit) {
    val (toneBg, toneFg) = toneColors(t.tone)
    val style = categoryStyle(t.category ?: "other")
    Card(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .semantics(mergeDescendants = true) { this.selected = selected }
            .clickable(role = Role.Button, onClick = onClick),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow),
        border = BorderStroke(1.dp, toneBg.copy(alpha = 0.6f)),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            com.beacon.mesh.ui.components.BadgeIcon(style.icon, toneBg, toneFg, size = 36.dp)
            Text(t.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        }
    }
}
