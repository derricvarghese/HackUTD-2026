package com.beacon.mesh.ui.responder

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.HealthAndSafety
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.beacon.mesh.R
import com.beacon.mesh.responder.ResponderException
import com.beacon.mesh.ui.components.BadgeIcon
import com.beacon.mesh.ui.components.ElevatedSection
import com.beacon.mesh.ui.components.ScreenScaffold
import com.beacon.mesh.ui.components.ScrollColumn
import com.beacon.mesh.ui.haptics.LocalHaptics

@Composable
fun ResponderLoginScreen(
    host: String,
    username: String,
    password: String,
    busy: Boolean,
    error: ResponderException?,
    onUsername: (String) -> Unit,
    onPassword: (String) -> Unit,
    onSignIn: () -> Unit,
) {
    val haptics = LocalHaptics.current
    val focus = LocalFocusManager.current
    var showPassword by rememberSaveable { mutableStateOf(false) }
    val canSubmit = username.isNotBlank() && password.isNotEmpty() && !busy

    ScreenScaffold(title = stringResource(R.string.responder_title)) { pad ->
        ScrollColumn(pad) {
            ElevatedSection {
                BadgeIcon(
                    Icons.Rounded.HealthAndSafety,
                    MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer,
                )
                Text(stringResource(R.string.responder_login_title), style = MaterialTheme.typography.titleLarge)
                Text(
                    stringResource(R.string.responder_login_body),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ElevatedSection {
                Text(stringResource(R.string.responder_account), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = username,
                    onValueChange = onUsername,
                    label = { Text(stringResource(R.string.responder_username)) },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = onPassword,
                    label = { Text(stringResource(R.string.responder_password)) },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { if (canSubmit) { focus.clearFocus(); haptics.perform(com.beacon.mesh.ui.haptics.HapticEvent.Tap); onSignIn() } }),
                    trailingIcon = {
                        IconButton(onClick = { haptics.toggle(!showPassword); showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                stringResource(if (showPassword) R.string.responder_hide_password else R.string.responder_show_password),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                )
                Text(
                    stringResource(R.string.responder_login_hint, host),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (error != null) {
                    Row(
                        Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                        Text(errorText(error), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Button(
                    onClick = haptics.onClick { focus.clearFocus(); onSignIn() },
                    enabled = canSubmit,
                    shapes = ButtonDefaults.shapes(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text(stringResource(R.string.responder_signing_in), Modifier.padding(start = 8.dp))
                    } else {
                        Text(stringResource(R.string.responder_sign_in))
                    }
                }
            }
        }
    }
}


