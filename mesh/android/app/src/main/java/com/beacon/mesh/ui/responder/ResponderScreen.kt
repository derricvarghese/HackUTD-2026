package com.beacon.mesh.ui.responder

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.collectAsState
import com.beacon.mesh.BuildConfig
import com.beacon.mesh.store.StoredMessage

/**
 * The Responder tab: sign-in until there is a session, then the live case map and list.
 * Live updates run only while this screen is on screen and the app is started (like the iOS tab); the
 * Bluetooth mesh service is independent and keeps relaying regardless.
 */
@Composable
fun ResponderScreen(vm: ResponderViewModel, meshMessages: List<StoredMessage>, dark: Boolean) {
    val state by vm.state.collectAsStateWithLifecycle()
    val username by vm.username.collectAsStateWithLifecycle()
    val password by vm.password.collectAsStateWithLifecycle()
    val signedIn = state.account != null

    val owner = LocalLifecycleOwner.current
    val lifecycle by owner.lifecycle.currentStateFlow.collectAsState()
    val active = signedIn && lifecycle.isAtLeast(Lifecycle.State.STARTED)
    DisposableEffect(active) {
        vm.setActive(active)
        onDispose { vm.setActive(false) }
    }

    if (!signedIn) {
        ResponderLoginScreen(
            host = runCatching { java.net.URI(BuildConfig.BACKEND_URL).host }.getOrNull() ?: BuildConfig.BACKEND_URL,
            username = username,
            password = password,
            busy = state.busy,
            error = state.error,
            onUsername = vm::setUsername,
            onPassword = vm::setPassword,
            onSignIn = vm::signIn,
        )
    } else {
        ResponderDashboard(vm, state, meshMessages, dark)
    }
}
