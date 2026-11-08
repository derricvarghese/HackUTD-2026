package com.beacon.mesh.ui.responder

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.MyLocation
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.beacon.mesh.R
import com.beacon.mesh.ui.SystemIntents
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.safeStart

private fun Context.hasPerm(p: String) = ContextCompat.checkSelfPermission(this, p) == android.content.pm.PackageManager.PERMISSION_GRANTED
private fun Context.activity(): Activity? { var c = this; while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }; return null }

/** Always-visible strip while the position is being shared (the system location indicator stays too). */
@Composable
fun SharingBanner(share: ShareUi, onOpen: () -> Unit, onStop: () -> Unit, modifier: Modifier = Modifier) {
    if (!share.active) return
    val haptics = LocalHaptics.current
    val desc = stringResource(R.string.responder_sharing_chip_desc)
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer) {
        Row(
            Modifier.padding(start = 16.dp, end = 8.dp).heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                Modifier.weight(1f).heightIn(min = 48.dp)
                    .semantics(mergeDescendants = true) { contentDescription = desc }
                    .clickable(role = Role.Button, onClick = haptics.onClick(HapticEvent.Navigate, onOpen)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Rounded.MyLocation, null, Modifier.size(20.dp))
                Text(stringResource(R.string.responder_sharing_chip), style = MaterialTheme.typography.labelLarge)
            }
            TextButton(onClick = haptics.onClick(HapticEvent.Warning, onStop)) { Text(stringResource(R.string.responder_share_stop)) }
        }
    }
}

@Composable
fun ShareSheet(
    share: ShareUi,
    available: Boolean?,
    notice: ShareNotice?,
    onEnable: (fine: Boolean) -> Unit,
    onDisable: () -> Unit,
    onResume: (fine: Boolean) -> Unit,
    onAvailable: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    var rationale by rememberSaveable { mutableStateOf(false) }
    var deniedPermanently by rememberSaveable { mutableStateOf(false) }
    var denied by rememberSaveable { mutableStateOf(false) }
    fun fine() = context.hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)
    fun any() = fine() || context.hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION)

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (any()) { denied = false; deniedPermanently = false; haptics.perform(HapticEvent.Success); onEnable(fine()) }
        else {
            haptics.perform(HapticEvent.Error)
            denied = true
            // Asked just now and Android will not explain again: it is a permanent denial.
            deniedPermanently = context.activity()?.let { !ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.ACCESS_FINE_LOCATION) } ?: true
        }
    }
    fun requestOrEnable() {
        if (any()) onEnable(fine())
        else launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    LaunchedEffect(Unit) { haptics.perform(HapticEvent.SheetOpen) }
    ModalBottomSheet(
        onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.responder_share_open), style = MaterialTheme.typography.titleLarge)
            SwitchRow(
                stringResource(R.string.responder_share_title),
                stringResource(if (share.needsResume) R.string.responder_share_resume_body else R.string.responder_share_body),
                checked = share.wanted,
                enabled = !share.clearing,
                onChange = { on -> if (on) rationale = true else onDisable() },
            )
            if (share.needsResume) {
                FilledTonalButton(
                    onClick = haptics.onClick { if (any()) onResume(fine()) else requestOrEnable() },
                    shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(stringResource(R.string.responder_share_resume)) }
            }
            if (share.active) {
                Text(
                    stringResource(
                        when {
                            share.failing -> R.string.responder_sharing_retrying
                            !share.hasSent -> R.string.responder_sharing_waiting
                            else -> R.string.responder_sharing_chip
                        },
                    ),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (share.clearing) Text(stringResource(R.string.responder_sharing_stopping), style = MaterialTheme.typography.bodyMedium)
            if (share.approximate && (share.active || share.wanted)) {
                Text(stringResource(R.string.responder_share_approximate), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary)
            }
            if (denied) {
                Text(
                    stringResource(if (deniedPermanently) R.string.responder_share_denied_permanent else R.string.responder_share_denied),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error,
                )
                if (deniedPermanently) {
                    Button(
                        onClick = haptics.onClick { context.safeStart(SystemIntents.appSettings(context)) },
                        shapes = ButtonDefaults.shapes(), modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.action_open_settings)) }
                }
            }
            when (notice) {
                ShareNotice.PERMISSION_REVOKED -> Text(stringResource(R.string.responder_share_revoked), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                ShareNotice.NO_PROVIDER -> Text(stringResource(R.string.responder_share_no_provider), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                null -> Unit
            }
            SwitchRow(
                stringResource(R.string.responder_available_title),
                stringResource(R.string.responder_available_body),
                checked = available == true,
                enabled = available != null,
                onChange = onAvailable,
            )
        }
    }

    if (rationale) {
        AlertDialog(
            onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); rationale = false },
            title = { Text(stringResource(R.string.responder_share_rationale_title)) },
            text = { Text(stringResource(R.string.responder_share_rationale)) },
            confirmButton = { TextButton(onClick = haptics.onClick { rationale = false; requestOrEnable() }) { Text(stringResource(R.string.responder_share_continue)) } },
            dismissButton = { TextButton(onClick = haptics.onClick(HapticEvent.SheetDismiss) { rationale = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
private fun SwitchRow(title: String, body: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    val haptics = LocalHaptics.current
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, enabled = enabled, onCheckedChange = haptics.onToggle(onChange))
    }
}

/** Call from the screen: re-checks the permission whenever the app returns to the foreground or permission is requested. */
@Composable
fun PermissionWatcher(vm: ResponderViewModel, signedIn: Boolean) {
    val context = LocalContext.current
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    fun fine() = context.hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)
    fun coarse() = context.hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION)

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.onPermissionState(fine(), coarse())
    }

    val requestTrigger by vm.requestPermissionTrigger.collectAsStateWithLifecycle()
    LaunchedEffect(requestTrigger) {
        if (requestTrigger > 0) {
            if (!fine() && !coarse()) {
                launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            } else {
                vm.onPermissionState(fine(), coarse())
            }
        }
    }

    LaunchedEffect(signedIn) {
        if (signedIn) {
            if (!fine() && !coarse()) {
                launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            } else {
                vm.onPermissionState(fine(), coarse())
            }
        }
    }

    androidx.compose.runtime.DisposableEffect(owner, signedIn) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e ->
            if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME && signedIn) {
                vm.onPermissionState(fine(), coarse())
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
}
