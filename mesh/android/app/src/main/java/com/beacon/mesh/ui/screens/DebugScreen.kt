package com.beacon.mesh.ui.screens

import android.content.ClipData
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.R
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.components.SectionTitle
import com.beacon.mesh.ui.logic.BackendUrlResult
import kotlinx.coroutines.launch

/** Demo / debug controls, one level below Settings: hop cap, force offline, backend URL, raw log. */
@Composable
fun DebugScreen(
    mesh: MeshSnapshot,
    onBack: () -> Unit,
    onHopCap: (Int?) -> Unit,
    onForceOffline: (Boolean) -> Unit,
    onSaveUrl: (String) -> BackendUrlResult,
) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val cap = mesh.demoHopCap
    ScreenScaffold(
        title = stringResource(R.string.settings_debug),
        navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.action_back)) }
        },
    ) { pad ->
        ScrollColumn(pad) {
            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_hopcap_title))
                Text(
                    stringResource(R.string.debug_hopcap_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FilledTonalIconButton(onClick = { onHopCap(cap?.minus(1)?.takeIf { it >= 1 }) }, enabled = cap != null) {
                        Icon(Icons.Rounded.Remove, stringResource(R.string.debug_hopcap_less))
                    }
                    Text(
                        cap?.toString() ?: stringResource(R.string.debug_hopcap_off),
                        style = MaterialTheme.typography.headlineSmallEmphasized,
                        modifier = Modifier.weight(1f),
                    )
                    FilledTonalIconButton(onClick = { onHopCap(((cap ?: 0) + 1).coerceAtMost(10)) }, enabled = (cap ?: 0) < 10) {
                        Icon(Icons.Rounded.Add, stringResource(R.string.debug_hopcap_more))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = { onHopCap(2) }, label = { Text(stringResource(R.string.debug_hopcap_demo)) })
                    AssistChip(onClick = { onHopCap(null) }, label = { Text(stringResource(R.string.debug_hopcap_clear)) })
                }
            }

            ElevatedSection {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.debug_force_offline), style = MaterialTheme.typography.titleMedium)
                        Text(
                            stringResource(R.string.debug_force_offline_body),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = mesh.forceOffline, onCheckedChange = onForceOffline)
                }
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.settings_gateway))
                BackendUrlField(saved = mesh.backendUrl, onSave = onSaveUrl)
            }

            ElevatedSection {
                SectionTitle(stringResource(R.string.debug_log_title))
                if (mesh.log.isEmpty()) {
                    Text(stringResource(R.string.debug_log_empty), style = MaterialTheme.typography.bodyMedium)
                } else {
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
                        SelectionContainer {
                            Column(Modifier.horizontalScroll(rememberScrollState()).padding(12.dp)) {
                                mesh.log.take(120).forEach {
                                    Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), softWrap = false)
                                }
                            }
                        }
                    }
                    FilledTonalButton(
                        onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("log", mesh.log.joinToString("\n")))) } },
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.debug_log_copy)) }
                }
            }
        }
    }
}
