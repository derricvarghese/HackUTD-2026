package com.beacon.mesh.ui.responder

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.DirectionsWalk
import androidx.compose.material.icons.rounded.AddComment
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.DirectionsCar
import androidx.compose.material.icons.rounded.Navigation
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material.icons.rounded.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.responder.CaseDetail
import com.beacon.mesh.responder.CaseRules
import com.beacon.mesh.responder.FullProfile
import com.beacon.mesh.responder.PinTone
import com.beacon.mesh.responder.ResolveOutcomes
import com.beacon.mesh.responder.ResponderAccount
import com.beacon.mesh.responder.ResponderCase
import com.beacon.mesh.responder.ResponderException
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.Pill
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.components.categoryLabel
import com.beacon.mesh.ui.components.categoryStyle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.theme.LocalCategoryColors

/** What a responder can do with a case. Everything is a plain callback so the content works in a sheet or a side pane. */
class CaseActions(
    val onClaim: () -> Unit,
    val onAdvance: (status: String, outcome: String?) -> Unit,
    val onAddNote: (text: String, done: (Boolean) -> Unit) -> Unit,
    val onRetryDetail: () -> Unit,
)

@Composable
fun toneColors(t: PinTone): Pair<androidx.compose.ui.graphics.Color, androidx.compose.ui.graphics.Color> {
    val c = LocalCategoryColors.current
    val s = MaterialTheme.colorScheme
    return when (t) {
        PinTone.CRITICAL -> c.danger to c.onDanger
        PinTone.HIGH -> c.warn to c.onWarn
        PinTone.NORMAL -> s.secondary to s.onSecondary
        PinTone.SAFE -> c.safe to c.onSafe
    }
}

@Composable
fun caseTitle(c: ResponderCase): String = c.displayName ?: categoryLabel(appCategory(c.category))

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CaseDetailContent(
    c: ResponderCase,
    detail: DetailState,
    account: ResponderAccount?,
    busy: Boolean,
    error: ResponderException?,
    now: Long,
    actions: CaseActions,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    val mine = c.isMine(account)
    val claimedByOther = c.claimedByOther(account)
    val d = (detail as? DetailState.Ready)?.detail?.takeIf { it.case.id == c.id }
    var resolveDialog by rememberSaveable { mutableStateOf(false) }
    var releaseDialog by rememberSaveable { mutableStateOf(false) }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // ---- header ----
        val style = categoryStyle(appCategory(c.category))
        val (toneBg, toneFg) = toneColors(CaseRules.tone(c))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            com.beacon.mesh.ui.components.BadgeIcon(style.icon, toneBg, toneFg, size = 56.dp)
            Column(Modifier.weight(1f)) {
                Text(caseTitle(c), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                Text(
                    stringResource(R.string.responder_header_sub, stringResource(style.label), c.score),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (mine) Pill(stringResource(R.string.responder_badge_yours), MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.onPrimary)
            if (c.silent) Pill(stringResource(R.string.responder_silent_badge), MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.onTertiaryContainer, Icons.Rounded.NotificationsOff)
            if (c.unresponsive) Pill(stringResource(R.string.responder_unresponsive_badge), MaterialTheme.colorScheme.errorContainer, MaterialTheme.colorScheme.onErrorContainer)
        }

        // ---- actions ----
        ElevatedSection {
            SectionTitle(stringResource(R.string.responder_section_actions))
            when {
                account?.canAct != true -> Text(stringResource(R.string.responder_read_only), style = MaterialTheme.typography.bodyMedium)
                mine -> {
                    if (c.assignmentStatus == "assigned") {
                        ActionButton(stringResource(R.string.responder_en_route), Icons.Rounded.DirectionsCar, !busy, primary = true) { actions.onAdvance("en_route", null) }
                    }
                    if (c.assignmentStatus == "assigned" || c.assignmentStatus == "en_route") {
                        ActionButton(stringResource(R.string.responder_on_scene), Icons.AutoMirrored.Rounded.DirectionsWalk, !busy) { actions.onAdvance("on_scene", null) }
                    }
                    ActionButton(stringResource(R.string.responder_resolve), Icons.Rounded.CheckCircle, !busy) { resolveDialog = true }
                    OutlinedButton(
                        onClick = haptics.onClick(HapticEvent.Warning) { releaseDialog = true },
                        enabled = !busy,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Icon(Icons.Rounded.Undo, null, Modifier.size(18.dp)); Text(stringResource(R.string.responder_release), Modifier.padding(start = 8.dp)) }
                }
                claimedByOther -> Text(
                    stringResource(R.string.responder_claimed_by, c.assigneeName ?: stringResource(R.string.responder_claimed_by_other)),
                    style = MaterialTheme.typography.bodyLarge,
                )
                else -> ActionButton(stringResource(R.string.responder_claim), Icons.Rounded.PanTool, !busy, primary = true) { actions.onClaim() }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (error != null && error.kind != ResponderException.Kind.SIGNED_OUT) {
                Text(
                    errorText(error), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                )
            }
        }

        // ---- location: exact coordinates and navigation only when the API returned them ----
        ElevatedSection {
            SectionTitle(stringResource(R.string.responder_section_location))
            if (c.hasExactLocation) {
                Text(stringResource(R.string.responder_exact_gps, "%.5f".format(c.lat), "%.5f".format(c.lng)), style = MaterialTheme.typography.bodyLarge)
            } else {
                Text(stringResource(R.string.responder_area_within, com.beacon.mesh.units.Units.formatDistance(c.radiusM, com.beacon.mesh.ui.LocalUnitSystem.current, com.beacon.mesh.ui.currentLocale())), style = MaterialTheme.typography.bodyLarge)
                if (!claimedByOther && account?.canAct == true) {
                    Text(stringResource(R.string.responder_claim_for_exact), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // Same as iOS: every case has a directions button; without an exact spot it targets the area's centre.
            Button(
                onClick = haptics.onClick { ResponderIntents.navigate(context, c.lat, c.lng) },
                shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.Rounded.Navigation, null, Modifier.size(18.dp))
                Text(
                    stringResource(if (c.hasExactLocation) R.string.responder_directions else R.string.responder_directions_area),
                    Modifier.padding(start = 8.dp),
                )
            }
            if (!c.hasExactLocation) {
                Text(stringResource(R.string.responder_directions_area_note, com.beacon.mesh.units.Units.formatDistance(1000.0, com.beacon.mesh.ui.LocalUnitSystem.current, com.beacon.mesh.ui.currentLocale())), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        // ---- details ----
        ElevatedSection {
            SectionTitle(stringResource(R.string.responder_section_details))
            c.text?.let { Text(stringResource(R.string.responder_text_quote, it), style = MaterialTheme.typography.bodyLarge) }
            c.peopleCount?.let { Fact(stringResource(R.string.responder_people), it.toString()) }
            c.profile?.ageRange?.let { Fact(stringResource(R.string.responder_age), it) }
            c.profile?.flags?.takeIf { it.isNotEmpty() }?.let { f -> Fact(stringResource(R.string.responder_needs), f.map { x -> flagText(x) }.joinToString(", ")) }
            Fact(stringResource(R.string.responder_status), statusText(c.status))
            Fact(stringResource(R.string.responder_last_heard), agoText(c.lastHeardAtMs, now))
            if (c.silent) Text(stringResource(R.string.responder_gone_quiet), color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodyMedium)
            if (c.unresponsive) Text(stringResource(R.string.responder_not_answering), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            d?.takeIf { it.welfareMissed > 0 }?.let { Fact(stringResource(R.string.responder_welfare_missed, it.welfareMissed), "") }
            c.hop?.let { h ->
                if (h.hopCount != null && h.maxHops != null) Fact(stringResource(R.string.responder_hops), stringResource(R.string.responder_hops_value, h.hopCount, h.maxHops))
                if (h.path.isNotEmpty()) Text(stringResource(R.string.responder_hop_path, h.path.joinToString(" → ")), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        // ---- triage, profile, history: from GET /sos/{id} ----
        when (detail) {
            DetailState.Loading -> ElevatedSection {
                Text(stringResource(R.string.responder_detail_loading), style = MaterialTheme.typography.bodyMedium)
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            DetailState.Failed -> ElevatedSection {
                Text(stringResource(R.string.responder_detail_failed), style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = haptics.onClick { actions.onRetryDetail() }) { Text(stringResource(R.string.action_try_again)) }
            }
            else -> Unit
        }
        if (d != null) {
            TriageSection(d)
            if (d.profileFull != null) ProfileSection(d.profileFull) else if (c.profile != null && !mine) {
                ElevatedSection {
                    SectionTitle(stringResource(R.string.responder_section_profile))
                    Text(stringResource(R.string.responder_profile_limited), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HistorySection(d, now)
            if (account?.canAct == true) NotesSection(d, actions)
        }
    }

    if (resolveDialog) {
        var outcome by rememberSaveable { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); resolveDialog = false },
            title = { Text(stringResource(R.string.responder_resolve_title)) },
            text = {
                Column(Modifier.selectableGroup()) {
                    ResolveOutcomes.forEach { o ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .selectable(selected = outcome == o, role = Role.RadioButton) { haptics.perform(HapticEvent.Select); outcome = o },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = outcome == o, onClick = null)
                            Text(outcomeText(o), Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = outcome != null,
                    onClick = haptics.onClick { outcome?.let { actions.onAdvance("resolved", it) }; resolveDialog = false },
                ) { Text(stringResource(R.string.responder_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss) { resolveDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
    if (releaseDialog) {
        AlertDialog(
            onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); releaseDialog = false },
            title = { Text(stringResource(R.string.responder_release_title)) },
            text = { Text(stringResource(R.string.responder_release_body)) },
            confirmButton = {
                TextButton(onClick = haptics.onClick { actions.onAdvance("released", null); releaseDialog = false }) {
                    Text(stringResource(R.string.responder_release))
                }
            },
            dismissButton = {
                TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss) { releaseDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

@Composable
private fun ActionButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, enabled: Boolean, primary: Boolean = false, onClick: () -> Unit) {
    val haptics = LocalHaptics.current
    val mod = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    val content: @Composable () -> Unit = { Icon(icon, null, Modifier.size(18.dp)); Text(label, Modifier.padding(start = 8.dp)) }
    if (primary) Button(onClick = haptics.onClick(action = onClick), enabled = enabled, shapes = ButtonDefaults.shapes(), modifier = mod) { content() }
    else FilledTonalButton(onClick = haptics.onClick(action = onClick), enabled = enabled, shapes = ButtonDefaults.shapes(), modifier = mod) { content() }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (value.isNotEmpty()) Text(value, Modifier.weight(1.4f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun TriageSection(d: CaseDetail) {
    if (d.summary == null && d.reasons.isEmpty()) return
    ElevatedSection {
        SectionTitle(stringResource(R.string.responder_section_triage))
        d.summary?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
        d.confidence?.let { Text(stringResource(R.string.responder_confidence, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        d.reasons.forEach { r ->
            Text(
                if (r.weight != null) stringResource(R.string.responder_reason_weight, r.text, r.weight) else r.text,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun ProfileSection(p: FullProfile) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    ElevatedSection {
        SectionTitle(stringResource(R.string.responder_section_profile))
        p.fullName?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
        p.phone?.let { phone ->
            Fact(stringResource(R.string.responder_profile_phone), phone)
            CallButton(stringResource(R.string.responder_call)) { ResponderIntents.dial(context, phone) }
        }
        if (p.conditions.isNotEmpty()) Fact(stringResource(R.string.responder_profile_conditions), p.conditions.joinToString(", "))
        if (p.medications.isNotEmpty()) Fact(stringResource(R.string.responder_profile_medications), p.medications.joinToString(", "))
        if (p.allergies.isNotEmpty()) Fact(stringResource(R.string.responder_profile_allergies), p.allergies.joinToString(", "))
        p.bloodType?.let { Fact(stringResource(R.string.responder_profile_blood), it) }
        if (p.mobilityNeeds.isNotEmpty() || p.mobilityNotes != null) {
            Fact(stringResource(R.string.responder_profile_mobility), (p.mobilityNeeds + listOfNotNull(p.mobilityNotes)).joinToString(", ") { it.replace('_', ' ') })
        }
        p.contactName?.let { name ->
            Fact(
                stringResource(R.string.responder_profile_contact),
                p.contactRelationship?.let { stringResource(R.string.responder_contact_value, name, it) } ?: name,
            )
            p.contactPhone?.let { phone -> CallButton(stringResource(R.string.responder_call_contact, name)) { ResponderIntents.dial(context, phone) } }
        }
    }
}

@Composable
private fun CallButton(label: String, onClick: () -> Unit) {
    val haptics = LocalHaptics.current
    FilledTonalButton(onClick = haptics.onClick(action = onClick), shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp)) {
        Icon(Icons.Rounded.Call, null, Modifier.size(18.dp)); Text(label, Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun HistorySection(d: CaseDetail, now: Long) {
    if (d.events.isEmpty() && d.checkins.isEmpty()) return
    ElevatedSection {
        SectionTitle(stringResource(R.string.responder_section_history))
        d.checkins.forEach { k ->
            val state = stringResource(
                when {
                    k.respondedAtMs != null -> R.string.responder_checkin_answered
                    k.missed -> R.string.responder_checkin_missed
                    else -> R.string.responder_checkin_waiting
                },
            )
            Text(stringResource(R.string.responder_checkin_line, agoText(k.sentAtMs, now), state), style = MaterialTheme.typography.bodyMedium)
        }
        d.events.sortedByDescending { it.atMs ?: 0L }.forEach { e ->
            Text(stringResource(R.string.responder_event_line, eventText(e.type), agoText(e.atMs, now)), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun NotesSection(d: CaseDetail, actions: CaseActions) {
    val haptics = LocalHaptics.current
    var note by rememberSaveable { mutableStateOf("") }
    var sending by rememberSaveable { mutableStateOf(false) }
    ElevatedSection {
        SectionTitle(stringResource(R.string.responder_notes))
        d.notes.forEach { Text(it.text, style = MaterialTheme.typography.bodyMedium) }
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(500) },
            label = { Text(stringResource(R.string.responder_note_label)) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        FilledTonalButton(
            onClick = haptics.onClick {
                sending = true
                actions.onAddNote(note) { ok -> sending = false; if (ok) note = "" }
            },
            enabled = note.isNotBlank() && !sending,
            shapes = ButtonDefaults.shapes(),
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Icon(Icons.Rounded.AddComment, null, Modifier.size(18.dp)); Text(stringResource(R.string.responder_note_add), Modifier.padding(start = 8.dp)) }
    }
}
