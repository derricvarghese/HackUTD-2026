package com.beacon.mesh.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.SyncProblem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.gateway.ProfileSync
import com.beacon.mesh.profile.ProfileRecord
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.ProfileStatus
import com.beacon.mesh.profile.UserProfile
import com.beacon.mesh.ui.ProfileViewModel
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.logic.ProfileChipKind
import com.beacon.mesh.ui.logic.ProfileForm
import com.beacon.mesh.ui.logic.ProfileStatusLogic
import java.text.DateFormat
import java.util.Date

// ---------------------------------------------------------------- consent + onboarding

/** Plain-language consent: what is collected, who sees what, deletion, optional. */
@Composable
fun ProfileConsentCard(
    required: Boolean,
    checked: Boolean,
    onChecked: (Boolean) -> Unit,
    onAgree: () -> Unit,
    onSkip: (() -> Unit)?,
) {
    val haptics = LocalHaptics.current
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BadgeIcon(Icons.Rounded.Person, MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer, size = 72.dp)
            Text(stringResource(R.string.profile_onboarding_title), style = MaterialTheme.typography.displaySmallEmphasized)
            Text(stringResource(R.string.profile_consent_intro), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ElevatedSection {
            ConsentBlock(R.string.profile_consent_collect_title, listOf(R.string.profile_consent_collect_body))
            ConsentBlock(R.string.profile_consent_see_title, listOf(R.string.profile_consent_see_name, R.string.profile_consent_see_private, R.string.profile_consent_mesh))
            ConsentBlock(R.string.profile_consent_delete_title, listOf(R.string.profile_consent_delete_body))
            Text(stringResource(R.string.profile_consent_optional), style = MaterialTheme.typography.bodyMedium)
            if (required) Text(stringResource(R.string.profile_consent_required_note), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .toggleable(value = checked, role = Role.Checkbox) { haptics.toggle(it); onChecked(it) },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Checkbox(checked = checked, onCheckedChange = null)
            Text(stringResource(R.string.profile_consent_check), style = MaterialTheme.typography.titleMedium)
        }
        Button(
            onClick = haptics.onClick(HapticEvent.Navigate, onAgree),
            enabled = checked,
            shapes = ButtonDefaults.shapes(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text(stringResource(R.string.profile_consent_agree)) }
        if (onSkip != null) {
            TextButton(onClick = haptics.onClick(action = onSkip), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(R.string.profile_skip))
            }
        }
    }
}

@Composable
private fun ConsentBlock(title: Int, lines: List<Int>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.titleMediumEmphasized)
        lines.forEach { Text(stringResource(it), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** The step after the permissions: consent card, then the form. Required unless the server says otherwise. */
@Composable
fun ProfileOnboardingScreen(vm: ProfileViewModel, modifier: Modifier = Modifier) {
    val haptics = LocalHaptics.current
    val status by vm.status.collectAsState()
    val consent by vm.consentGiven.collectAsState()
    val editor by vm.editor.collectAsState()
    var checked by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.refreshServerInfo() }

    // Predictive back: step back through the sections, then to the consent card.
    BackHandler(enabled = consent) {
        if (!editor.back()) vm.declineConsent()
    }

    ScrollColumn(PaddingValues(0.dp), modifier = modifier.windowInsetsPadding(WindowInsets.safeDrawing).padding(top = 16.dp)) {
        if (!consent) {
            ProfileConsentCard(
                required = status.serverRequired,
                checked = checked,
                onChecked = { checked = it },
                onAgree = vm::acceptConsent,
                onSkip = { vm.skip() },
            )
        } else {
            Text(stringResource(R.string.profile_onboarding_title), style = MaterialTheme.typography.headlineMediumEmphasized)
            ProfileFormPane(editor, R.string.profile_finish_now, onSave = {
                if (vm.save()) haptics.perform(HapticEvent.Success) else haptics.perform(HapticEvent.Error)
            })
            TextButton(onClick = haptics.onClick { vm.skip() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(R.string.profile_skip))
            }
        }
    }
}

// ---------------------------------------------------------------- status chip + banner

@Composable
fun profileChipLabel(kind: ProfileChipKind): Int = when (kind) {
    ProfileChipKind.SYNCED -> R.string.profile_status_synced
    ProfileChipKind.PENDING -> R.string.profile_status_pending
    ProfileChipKind.FAILED -> R.string.profile_status_failed
    ProfileChipKind.CONSENT -> R.string.profile_status_consent
    ProfileChipKind.ERASING -> R.string.profile_status_erasing
    ProfileChipKind.NONE -> R.string.profile_status_none
}

@Composable
fun profileErrorText(code: String?): String? = when (code) {
    null -> null
    ProfileSync.ERR_OFFLINE -> stringResource(R.string.profile_err_offline)
    ProfileSync.ERR_RATE_LIMITED -> stringResource(R.string.profile_err_rate)
    ProfileSync.ERR_REJECTED -> stringResource(R.string.profile_err_rejected)
    ProfileSync.ERR_AUTH -> stringResource(R.string.profile_err_auth)
    ProfileSync.ERR_CONSENT -> stringResource(R.string.profile_err_consent)
    else -> stringResource(R.string.profile_err_server)
}

/** "Synced" / "Will sync when online" / "Sync failed, retry". Tapping retries (failed) or opens the profile. */
@Composable
fun ProfileStatusChip(status: ProfileStatus, onOpen: () -> Unit, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val kind = ProfileStatusLogic.chip(status)
    if (kind == ProfileChipKind.NONE) return
    val haptics = LocalHaptics.current
    val icon = when (kind) {
        ProfileChipKind.SYNCED -> Icons.Rounded.CloudDone
        ProfileChipKind.FAILED, ProfileChipKind.CONSENT -> Icons.Rounded.SyncProblem
        else -> Icons.Rounded.CloudOff
    }
    val label = stringResource(profileChipLabel(kind))
    AssistChip(
        onClick = haptics.onClick(HapticEvent.LightTap) { if (kind == ProfileChipKind.FAILED) onRetry() else onOpen() },
        label = { Text(label) },
        leadingIcon = { Icon(icon, null) },
        modifier = modifier.heightIn(min = 48.dp),
    )
}

/** Dismissible nudge on Home: no profile (skipped) or only a name. */
@Composable
fun ProfileBanner(hasProfile: Boolean, onOpen: () -> Unit, onDismiss: () -> Unit, prominent: Boolean = false) {
    val haptics = LocalHaptics.current
    // The content colour must be the on-colour of the SAME container role (it used onTertiaryContainer on primaryContainer: unreadable in dark mode).
    val container = if (prominent) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.tertiaryContainer
    val content = if (prominent) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onTertiaryContainer
    ElevatedSection(container = container) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Rounded.Person, null, tint = content)
            Text(
                stringResource(R.string.profile_banner_title),
                style = MaterialTheme.typography.titleMediumEmphasized,
                color = content,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = haptics.onClick(HapticEvent.LightTap, onDismiss), modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Rounded.Close, contentDescription = stringResource(R.string.profile_banner_dismiss), tint = content)
            }
        }
        Text(
            stringResource(if (hasProfile) R.string.profile_banner_body else R.string.profile_banner_set_up),
            style = MaterialTheme.typography.bodyMedium,
            color = content,
        )
        if (prominent) {
            Text(
                stringResource(R.string.profile_banner_why),
                style = MaterialTheme.typography.titleSmall,
                color = content,
            )
        }
        FilledTonalButton(onClick = haptics.onClick(HapticEvent.Navigate, onOpen), shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(if (hasProfile) R.string.profile_banner_action else R.string.profile_banner_set_up_action))
        }
    }
}

/** Shown when the server announced a newer consent version: the profile does not sync until the user agrees again. */
@Composable
fun ProfileReconsentDialog(onAgree: () -> Unit, onLater: () -> Unit) {
    val haptics = LocalHaptics.current
    AlertDialog(
        onDismissRequest = onLater,
        title = { Text(stringResource(R.string.profile_reconsent_title)) },
        text = { Text(stringResource(R.string.profile_reconsent_body)) },
        confirmButton = { TextButton(onClick = haptics.onClick(HapticEvent.Success, onAgree)) { Text(stringResource(R.string.profile_reconsent_agree)) } },
        dismissButton = { TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss, onLater)) { Text(stringResource(R.string.profile_reconsent_later)) } },
    )
}

// ---------------------------------------------------------------- Settings > My profile

@Composable
fun ProfileSettingsScreen(vm: ProfileViewModel, onBack: () -> Unit) {
    val haptics = LocalHaptics.current
    val status by vm.status.collectAsState()
    val record by vm.record.collectAsState()
    val editor by vm.editor.collectAsState()
    val form by editor.form.collectAsState()
    var editing by rememberSaveable { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }
    var setupStarted by rememberSaveable { mutableStateOf(false) }
    var confirmDiscard by rememberSaveable { mutableStateOf(false) }
    val hasProfile = record.profile != null
    val dirty = form != ProfileForm.fromProfile(record.profile)

    fun leaveEdit() { vm.discardEdit(); editing = false }
    BackHandler(enabled = editing) { if (dirty) confirmDiscard = true else leaveEdit() }
    val consented by vm.consentGiven.collectAsState()

    ScreenScaffold(
        title = stringResource(R.string.profile_title),
        navigationIcon = {
            IconButton(onClick = haptics.onClick(HapticEvent.Navigate) { if (editing) { if (dirty) confirmDiscard = true else leaveEdit() } else onBack() }) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = stringResource(R.string.action_back))
            }
        },
    ) { pad ->
        ScrollColumn(pad) {
            if (editing || (!hasProfile && consented)) {
                ProfileFormPane(editor, R.string.profile_save_changes, onSave = {
                    if (vm.save()) { haptics.perform(HapticEvent.Success); editing = false } else haptics.perform(HapticEvent.Error)
                })
            } else if (!hasProfile) {
                if (!setupStarted) NotSetUpCard(onSetUp = { setupStarted = true }) else NoProfileCard(vm)
            } else {
                SyncRow(status, record, onRetry = if (status.syncState == com.beacon.mesh.profile.SyncState.NEEDS_CONSENT) vm::reconsent else vm::retrySync)
                ProfileSummaryCard(record.profile!!)
                Button(
                    onClick = haptics.onClick(HapticEvent.Tap) { vm.beginEdit(); editing = true },
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) {
                    Icon(Icons.Rounded.Edit, null)
                    Text(stringResource(R.string.profile_edit), modifier = Modifier.padding(start = 8.dp))
                }
                ConsentInfo(record)
                OutlinedButton(
                    onClick = haptics.onClick(HapticEvent.Warning) { confirmDelete = true },
                    shapes = ButtonDefaults.shapes(),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) {
                    Icon(Icons.Rounded.Delete, null)
                    Text(stringResource(R.string.profile_delete), modifier = Modifier.padding(start = 8.dp))
                }
            }
            if (status.pendingErase) SyncRow(status, record, onRetry = vm::retrySync)
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.profile_delete_title)) },
            text = { Text(stringResource(R.string.profile_delete_body)) },
            confirmButton = {
                TextButton(onClick = haptics.onClick(HapticEvent.Success) { confirmDelete = false; editing = false; vm.deleteProfile() }) {
                    Text(stringResource(R.string.profile_delete_confirm), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss) { confirmDelete = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.profile_discard_title)) },
            text = { Text(stringResource(R.string.profile_discard_body)) },
            confirmButton = { TextButton(onClick = haptics.onClick(HapticEvent.Warning) { confirmDiscard = false; leaveEdit() }) { Text(stringResource(R.string.profile_discard_confirm)) } },
            dismissButton = { TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss) { confirmDiscard = false }) { Text(stringResource(R.string.profile_discard_keep)) } },
        )
    }
}

@Composable
private fun NotSetUpCard(onSetUp: () -> Unit) {
    val haptics = LocalHaptics.current
    ElevatedSection(container = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Text(stringResource(R.string.profile_not_set_up), style = MaterialTheme.typography.titleLargeEmphasized)
        Text(stringResource(R.string.profile_not_set_up_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = haptics.onClick(HapticEvent.Navigate, onSetUp), shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Text(stringResource(R.string.profile_set_up))
        }
    }
}

@Composable
private fun NoProfileCard(vm: ProfileViewModel) {
    var checked by rememberSaveable { mutableStateOf(false) }
    ProfileConsentCard(required = false, checked = checked, onChecked = { checked = it }, onAgree = vm::acceptConsent, onSkip = null)
}

@Composable
private fun SyncRow(status: ProfileStatus, record: ProfileRecord, onRetry: () -> Unit) {
    val haptics = LocalHaptics.current
    val kind = ProfileStatusLogic.chip(status)
    val df = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    ElevatedSection(container = MaterialTheme.colorScheme.surfaceContainerHigh) {
        SectionTitle(stringResource(R.string.profile_sync_title))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (kind == ProfileChipKind.SYNCED) Icons.Rounded.CloudDone else if (kind == ProfileChipKind.PENDING) Icons.Rounded.CloudOff else Icons.Rounded.SyncProblem, null)
            Column(Modifier.weight(1f)) {
                Text(stringResource(profileChipLabel(kind)), style = MaterialTheme.typography.titleMedium)
                profileErrorText(status.lastError)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (status.lastSyncedAtMs > 0) Text(stringResource(R.string.profile_sync_last, df.format(Date(status.lastSyncedAtMs))), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (status.profileVersion > 0) Text(stringResource(R.string.profile_status_version, status.profileVersion), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (kind != ProfileChipKind.SYNCED) {
                FilledTonalButton(onClick = haptics.onClick(HapticEvent.Tap, onRetry), shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.profile_status_retry))
                }
            }
        }
    }
}

@Composable
private fun ConsentInfo(record: ProfileRecord) {
    val c = record.consent ?: return
    val df = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    val at = com.beacon.mesh.protocol.Iso.parse(c.acceptedAt)?.let { df.format(Date(it)) } ?: c.acceptedAt
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Rounded.Lock, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.profile_consent_info, c.version, at), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ProfileSummaryCard(p: UserProfile) {
    val none = stringResource(R.string.profile_view_empty)
    fun v(s: String) = s.ifBlank { none }
    fun l(s: List<String>) = if (s.isEmpty()) none else s.joinToString(", ")
    val needs = p.mobilityNeeds.map { mobilityNeedLabel(it) }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_identity))
        Info(R.string.profile_f_full_name, v(p.fullName)); Info(R.string.profile_f_preferred_name, v(p.preferredName))
        Info(R.string.profile_f_birth_year, p.birthYear?.toString() ?: none); Info(R.string.profile_f_languages, l(p.languages)); Info(R.string.profile_f_phone, v(p.phone))
    }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_appearance))
        Info(R.string.profile_f_height, p.heightCm?.toString() ?: none); Info(R.string.profile_f_hair, v(p.hair))
        Info(R.string.profile_f_clothing, v(p.clothing)); Info(R.string.profile_f_marks, v(p.distinguishingMarks))
    }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_medical))
        Info(R.string.profile_f_conditions, l(p.conditions)); Info(R.string.profile_f_medications, l(p.medications)); Info(R.string.profile_f_allergies, l(p.allergies))
        Info(R.string.profile_f_blood_type, p.bloodType?.let { if (it == com.beacon.mesh.profile.BloodType.UNKNOWN) stringResource(R.string.profile_blood_unknown) else it.wire } ?: none)
        Info(R.string.profile_f_mobility_needs, l(needs))
        Info(R.string.profile_f_mobility_notes, v(p.mobilityNotes))
    }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_household))
        Info(R.string.profile_f_people, p.peopleCount?.toString() ?: none); Info(R.string.profile_f_children, p.children?.toString() ?: none)
        Info(R.string.profile_f_elderly, p.elderly?.toString() ?: none)
        Info(R.string.profile_f_pets, if (p.pets.isEmpty()) none else p.pets.joinToString(", ") { pet -> pet.kind + (pet.count?.let { " x$it" } ?: "") })
    }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_contact))
        Info(R.string.profile_f_contact_name, v(p.emergencyContact?.name ?: "")); Info(R.string.profile_f_contact_phone, v(p.emergencyContact?.phone ?: ""))
        Info(R.string.profile_f_contact_rel, v(p.emergencyContact?.relationship ?: "")); Info(R.string.profile_f_address, v(p.homeAddress))
    }
    ElevatedSection {
        SectionTitle(stringResource(R.string.profile_sec_notes))
        Text(v(p.notes), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun Info(label: Int, value: String) {
    val l = stringResource(label)
    Column(Modifier.semantics(mergeDescendants = true) { contentDescription = "$l: $value" }) {
        Text(l, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}
