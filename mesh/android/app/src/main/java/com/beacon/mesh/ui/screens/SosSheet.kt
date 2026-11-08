package com.beacon.mesh.ui.screens

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.GpsFixed
import androidx.compose.material.icons.rounded.GpsNotFixed
import androidx.compose.material.icons.rounded.GpsOff
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.beacon.mesh.GpsFix
import com.beacon.mesh.R
import com.beacon.mesh.image.ImageProcessor
import com.beacon.mesh.image.ProcessedImage
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.ui.accuracyText
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.HoldToConfirmButton
import com.beacon.mesh.ui.components.categoryStyle
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.logic.SosDraft
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Confirmation step for an alert: optional note, people count, photos (camera/gallery),
 * GPS status and a hold-to-send button for critical alerts.
 */
@Composable
fun SosSheet(
    draft: SosDraft,
    gps: GpsFix?,
    locationAllowed: Boolean,
    onNote: (String) -> Unit,
    onPeople: (Int) -> Unit,
    onAddImage: (ProcessedImage) -> Unit = {},
    onRemoveImage: (String) -> Unit = {},
    onImageCaption: (String, String) -> Unit = { _, _ -> },
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val haptics = LocalHaptics.current
    val style = categoryStyle(draft.category.wire)

    var cameraTempFile by remember { mutableStateOf<File?>(null) }
    var captionDialogImage by remember { mutableStateOf<ProcessedImage?>(null) }
    var tempCaption by remember { mutableStateOf("") }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val temp = cameraTempFile
        if (success && temp != null && temp.exists()) {
            scope.launch(Dispatchers.IO) {
                val dest = File(context.filesDir, "case_images/${UUID.randomUUID()}.jpg")
                val processed = runCatching {
                    val p = ImageProcessor.processStream(temp.inputStream(), dest)
                    temp.delete()
                    p
                }.getOrNull()
                if (processed != null) {
                    withContext(Dispatchers.Main) { onAddImage(processed) }
                }
            }
        }
    }

    val galleryLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val remaining = SosDraft.MAX_IMAGES - draft.images.size
        uris.take(remaining).forEach { uri ->
            scope.launch(Dispatchers.IO) {
                val dest = File(context.filesDir, "case_images/${UUID.randomUUID()}.jpg")
                val processed = runCatching { ImageProcessor.processUri(context, uri, dest) }.getOrNull()
                if (processed != null) {
                    withContext(Dispatchers.Main) { onAddImage(processed) }
                }
            }
        }
    }

    fun startCamera() {
        val tempDir = File(context.cacheDir, "camera")
        tempDir.mkdirs()
        val tempFile = File(tempDir, "temp_${System.currentTimeMillis()}.jpg")
        cameraTempFile = tempFile
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            tempFile,
        )
        cameraLauncher.launch(uri)
    }

    ModalBottomSheet(onDismissRequest = { haptics.perform(HapticEvent.SheetDismiss); onDismiss() }, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                BadgeIcon(style.icon, style.container, style.content)
                Column {
                    Text(stringResource(R.string.sos_sheet_title), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(style.label), style = MaterialTheme.typography.headlineMediumEmphasized)
                }
            }

            GpsLine(gps, locationAllowed)

            if (draft.category != Category.SAFE || draft.people > 1) PeopleStepper(draft.people, onPeople)

            OutlinedTextField(
                value = draft.note,
                onValueChange = onNote,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.sos_note_label)) },
                placeholder = { Text(stringResource(R.string.sos_note_hint)) },
                supportingText = { Text("${draft.note.length}/${SosDraft.MAX_NOTE}") },
                minLines = 2,
                maxLines = 5,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Default),
            )

            // ---- Case images section ----
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        stringResource(R.string.sos_photos_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        stringResource(R.string.sos_photos_count, draft.images.size),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (draft.images.isNotEmpty()) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        draft.images.forEach { img ->
                            val bitmap = remember(img.file.absolutePath) {
                                BitmapFactory.decodeFile(img.file.absolutePath)
                            }
                            Card(
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier.size(96.dp),
                            ) {
                                Box {
                                    if (bitmap != null) {
                                        Image(
                                            bitmap = bitmap.asImageBitmap(),
                                            contentDescription = img.caption ?: stringResource(R.string.sos_photos_title),
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.size(96.dp).clip(RoundedCornerShape(12.dp)),
                                        )
                                    }
                                    IconButton(
                                        onClick = haptics.onClick(HapticEvent.Tick) { onRemoveImage(img.id) },
                                        modifier = Modifier.align(Alignment.TopEnd).size(28.dp).padding(2.dp),
                                        colors = IconButtonDefaults.iconButtonColors(
                                            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.8f),
                                            contentColor = MaterialTheme.colorScheme.onSurface,
                                        ),
                                    ) {
                                        Icon(Icons.Rounded.Close, stringResource(R.string.sos_photo_remove), modifier = Modifier.size(16.dp))
                                    }
                                }
                            }
                        }
                    }
                }

                if (draft.images.size < SosDraft.MAX_IMAGES) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = haptics.onClick(HapticEvent.LightTap, ::startCamera),
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Rounded.PhotoCamera, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.sos_photo_camera), style = MaterialTheme.typography.labelMedium)
                        }
                        OutlinedButton(
                            onClick = haptics.onClick(HapticEvent.LightTap) { galleryLauncher.launch("image/*") },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Rounded.PhotoLibrary, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.sos_photo_gallery), style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }

                Text(
                    stringResource(R.string.sos_photos_offline_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                stringResource(R.string.sos_offline_explainer),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            val dismiss: () -> Unit = {
                haptics.perform(HapticEvent.SheetDismiss)
                scope.launch { sheetState.hide() }.invokeOnCompletion { if (!sheetState.isVisible) onDismiss() }
            }
            val confirm: () -> Unit = {
                scope.launch { sheetState.hide() }.invokeOnCompletion { onConfirm() }
            }
            if (draft.requiresHold) {
                HoldToConfirmButton(onConfirm = confirm, container = style.strong, content = style.onStrong)
            } else {
                Button(
                    onClick = haptics.onClick(HapticEvent.Success, confirm),
                    shapes = ButtonDefaults.shapes(),
                    colors = ButtonDefaults.buttonColors(containerColor = style.strong, contentColor = style.onStrong),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
                ) { Text(stringResource(R.string.sos_send), style = MaterialTheme.typography.titleMediumEmphasized) }
            }
            TextButton(onClick = dismiss, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(R.string.action_cancel))
            }
        }
    }

    captionDialogImage?.let { img ->
        AlertDialog(
            onDismissRequest = { captionDialogImage = null },
            title = { Text(stringResource(R.string.sos_photo_caption)) },
            text = {
                OutlinedTextField(
                    value = tempCaption,
                    onValueChange = { tempCaption = it.take(ImageProcessor.MAX_CAPTION_LENGTH) },
                    label = { Text(stringResource(R.string.sos_photo_caption)) },
                    placeholder = { Text(stringResource(R.string.sos_photo_caption_hint)) },
                    supportingText = { Text("${tempCaption.length}/${ImageProcessor.MAX_CAPTION_LENGTH}") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    onImageCaption(img.id, tempCaption)
                    captionDialogImage = null
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = {
                TextButton(onClick = { captionDialogImage = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }
}

/** "GPS, about 8 m": source plus the rounded 68 % radius (Android's Location.accuracy), never a made-up precision. */
@Composable
fun gpsFixText(gps: GpsFix): String {
    val src = stringResource(when (gps.source) { "gps" -> R.string.gps_src_gps; "fused" -> R.string.gps_src_fused; "network" -> R.string.gps_src_network; else -> R.string.gps_src_other })
    val acc = gps.accuracyM ?: return src
    return stringResource(R.string.gps_fix, src, accuracyText(acc.toDouble()).first)
}

/** Spoken form for TalkBack: "GPS, about 16 feet". */
@Composable
fun gpsFixSpoken(gps: GpsFix): String {
    val src = stringResource(when (gps.source) { "gps" -> R.string.gps_src_gps; "fused" -> R.string.gps_src_fused; "network" -> R.string.gps_src_network; else -> R.string.gps_src_other })
    val acc = gps.accuracyM ?: return src
    return stringResource(R.string.gps_fix, src, accuracyText(acc.toDouble()).second)
}

@Composable
fun GpsLine(gps: GpsFix?, locationAllowed: Boolean, modifier: Modifier = Modifier) {
    val spoken = if (locationAllowed && gps?.accuracyM != null) gpsFixSpoken(gps) else null
    val (icon, text) = when {
        !locationAllowed -> Icons.Rounded.GpsOff to stringResource(R.string.gps_denied)
        gps == null -> Icons.Rounded.GpsNotFixed to stringResource(R.string.gps_searching)
        gps.accuracyM != null -> Icons.Rounded.GpsFixed to gpsFixText(gps)
        else -> Icons.Rounded.GpsFixed to stringResource(R.string.gps_fix_unknown)
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = if (spoken != null) Modifier.semantics { contentDescription = spoken } else Modifier)
    }
}

@Composable
private fun PeopleStepper(people: Int, onPeople: (Int) -> Unit) {
    val haptics = LocalHaptics.current
    val peopleLabel = stringResource(R.string.sos_people_label)
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$peopleLabel: $people" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(peopleLabel, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onPeople(people - 1) }, enabled = people > 1, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Rounded.Remove, stringResource(R.string.sos_people_less))
        }
        Text("$people", style = MaterialTheme.typography.headlineSmallEmphasized, modifier = Modifier.widthIn(min = 32.dp))
        FilledTonalIconButton(onClick = haptics.onClick(HapticEvent.Tick) { onPeople(people + 1) }, enabled = people < SosDraft.MAX_PEOPLE, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Rounded.Add, stringResource(R.string.sos_people_more))
        }
    }
}
