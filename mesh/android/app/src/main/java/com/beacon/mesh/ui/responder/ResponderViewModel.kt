package com.beacon.mesh.ui.responder

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.beacon.mesh.BuildConfig
import com.beacon.mesh.responder.CaseDetail
import com.beacon.mesh.responder.CaseFilter
import com.beacon.mesh.responder.KeystoreSessionStore
import com.beacon.mesh.responder.LocationSharer
import com.beacon.mesh.responder.LocationSink
import com.beacon.mesh.responder.OkHttpAdapter
import com.beacon.mesh.responder.ResponderLocationSource
import com.beacon.mesh.responder.ShareResult
import com.beacon.mesh.responder.ResponderException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import com.beacon.mesh.responder.OkHttpLiveSocketFactory
import com.beacon.mesh.responder.ResponderCase
import com.beacon.mesh.responder.ResponderClient
import com.beacon.mesh.responder.ResponderController
import com.beacon.mesh.responder.ResponderState
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

enum class ShareNotice { PERMISSION_REVOKED, NO_PROVIDER }

data class ShareUi(
    /** The persisted switch. */
    val wanted: Boolean = false,
    /** Actually sending (or waiting for a fix) right now. */
    val active: Boolean = false,
    /** Only an approximate location permission was granted. */
    val approximate: Boolean = false,
    val failing: Boolean = false,
    val hasSent: Boolean = false,
    val clearing: Boolean = false,
) {
    /** Switch on from a previous launch, waiting for the user to resume. */
    val needsResume: Boolean get() = wanted && !active
}

sealed interface DetailState {
    data object None : DetailState
    data object Loading : DetailState
    data class Ready(val detail: CaseDetail) : DetailState
    data object Failed : DetailState
}

/**
 * Thin Android shell around [ResponderController]. UI choices that must survive rotation and process death
 * (selected case, filter, username, map toggle) live in [SavedStateHandle]; the password only in memory.
 */
class ResponderViewModel(app: Application, private val handle: SavedStateHandle) : AndroidViewModel(app) {
    private val client = ResponderClient(BuildConfig.BACKEND_URL, OkHttpAdapter(), KeystoreSessionStore(app))
    private val controller = ResponderController(viewModelScope, client, OkHttpLiveSocketFactory())

    // ---- location sharing (opt-in, foreground only) ----
    private val sharePrefs = app.getSharedPreferences("beacon_responder_prefs", android.content.Context.MODE_PRIVATE)
    private val source = ResponderLocationSource(app)
    private val sharer = LocationSharer(viewModelScope, object : LocationSink {
        override suspend fun send(lat: Double, lng: Double) = guard { client.shareLocation(lat, lng) }
        override suspend fun clear() = guard { client.clearLocation() }
        private suspend fun guard(op: suspend () -> Unit): ShareResult = try { op(); ShareResult.OK } catch (e: ResponderException) {
            when (e.kind) {
                ResponderException.Kind.SIGNED_OUT, ResponderException.Kind.FORBIDDEN -> ShareResult.FATAL
                else -> ShareResult.RETRY
            }
        }
    }, System::currentTimeMillis, { isOnline(app) })

    private val _sharePref = MutableStateFlow(sharePrefs.getBoolean(KEY_SHARE, false))
    /** True when sharing is running now: the switch is on AND the user signed in or resumed during this process. */
    private val _armed = MutableStateFlow(false)
    private val _approximate = MutableStateFlow(false)
    private val _shareNotice = MutableStateFlow<ShareNotice?>(null)
    val shareNotice: StateFlow<ShareNotice?> = _shareNotice

    val share: StateFlow<ShareUi> = kotlinx.coroutines.flow.combine(_sharePref, _armed, _approximate, sharer.state) { pref, armed, approx, st ->
        ShareUi(pref, armed && st.armed, approx, st.failing, st.lastSentAtMs != null, st.clearing)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ShareUi())

    val state: StateFlow<ResponderState> = controller.state

    val selectedId: StateFlow<String?> = handle.getStateFlow<String?>(KEY_SELECTED, null)
    val filter: StateFlow<CaseFilter> = handle.getStateFlow(KEY_FILTER, CaseFilter.ALL.name)
        .map { runCatching { CaseFilter.valueOf(it) }.getOrDefault(CaseFilter.ALL) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, CaseFilter.ALL)
    val showMesh: StateFlow<Boolean> = handle.getStateFlow(KEY_MESH, true)
    val username: StateFlow<String> = handle.getStateFlow(KEY_USER, "")

    private val _password = MutableStateFlow("")
    val password: StateFlow<String> = _password

    private val _detail = MutableStateFlow<DetailState>(DetailState.None)
    val detail: StateFlow<DetailState> = _detail

    /** Increments to ask the map to re-fit all cases. */
    private val _fit = MutableStateFlow(0)
    val fitToken: StateFlow<Int> = _fit

    private val retry = MutableStateFlow(0)

    init {
        // Losing the session for any reason (expired refresh token) ends sharing; clearing is impossible without a token.
        viewModelScope.launch {
            state.map { it.account == null }.distinctUntilChanged().collect { signedOut ->
                if (signedOut) { source.stop(); sharer.abandon(); _armed.value = false }
            }
        }
        // Reload the detail when another case is selected or the selected case changes on the server.
        viewModelScope.launch {
            combineSelected().collectLatest { (id, _, _) ->
                if (id == null) { _detail.value = DetailState.None; return@collectLatest }
                if ((_detail.value as? DetailState.Ready)?.detail?.case?.id != id) _detail.value = DetailState.Loading
                val d = controller.detail(id)
                _detail.value = if (d != null) DetailState.Ready(d) else if (_detail.value is DetailState.Ready) _detail.value else DetailState.Failed
            }
        }
    }

    private fun combineSelected() = kotlinx.coroutines.flow.combine(selectedId, state.map { s -> s.cases }, retry) { id, cases, r ->
        Triple(id, cases.firstOrNull { it.id == id }?.let { it.updatedAtMs to it.status to it.assignmentStatus }, r)
    }.distinctUntilChanged()

    fun setActive(active: Boolean) = controller.setActive(active)

    fun setUsername(v: String) { handle[KEY_USER] = v }
    fun setPassword(v: String) { _password.value = v }

    fun signIn() {
        val u = username.value.trim()
        val p = _password.value
        if (u.isEmpty() || p.isEmpty() || state.value.busy) return
        viewModelScope.launch {
            if (controller.login(u, p)) {
                _password.value = ""
                controller.setActive(true)
                // The switch survives restarts, but sharing starts only after a sign-in the user just made.
                if (_sharePref.value) beginSharing()
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            handle[KEY_SELECTED] = null
            _password.value = ""
            // Take our position off the dashboard map before the token is wiped (best effort, short wait).
            val wasSharing = _armed.value
            source.stop(); _armed.value = false
            if (wasSharing) {
                sharer.stop(clearRemote = true)
                withTimeoutOrNull(3_000) { sharer.state.first { !it.clearing } }
            }
            sharer.abandon()
            controller.logout()
        }
    }

    // ---- sharing controls ----

    /** The UI got a location permission result (or already had one) and the user confirmed the rationale. */
    fun enableSharing(fine: Boolean) {
        _sharePref.value = true; sharePrefs.edit().putBoolean(KEY_SHARE, true).apply()
        _approximate.value = !fine
        beginSharing()
    }

    fun disableSharing() {
        _sharePref.value = false; sharePrefs.edit().putBoolean(KEY_SHARE, false).apply()
        source.stop(); _armed.value = false
        sharer.stop(clearRemote = true)
    }

    /** Switch was already on from last launch; the user taps Resume after seeing the screen. */
    fun resumeSharing(fine: Boolean) { _approximate.value = !fine; beginSharing() }

    /** Called when the screen resumes: permission pulled in system settings ends sharing. */
    fun onPermissionState(fine: Boolean, coarse: Boolean) {
        if (!fine && !coarse && (_armed.value || _sharePref.value)) {
            val was = _armed.value || _sharePref.value
            disableSharing()
            if (was) _shareNotice.value = ShareNotice.PERMISSION_REVOKED
        } else if (_armed.value) {
            _approximate.value = !fine
        }
    }

    fun clearShareNotice() { _shareNotice.value = null }

    private fun beginSharing() {
        if (state.value.account == null) return
        sharer.start()
        _armed.value = true
        if (!source.start { lat, lng -> sharer.onFix(lat, lng) }) _shareNotice.value = ShareNotice.NO_PROVIDER
    }

    fun setAvailable(on: Boolean) { viewModelScope.launch { controller.setAvailable(on) } }

    override fun onCleared() { source.stop() }

    private fun isOnline(app: Application): Boolean {
        val cm = app.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun retryDetail() { retry.value += 1 }
    fun refresh() { viewModelScope.launch { controller.fullRefresh() } }
    fun select(id: String?) { handle[KEY_SELECTED] = id }
    fun setFilter(f: CaseFilter) { handle[KEY_FILTER] = f.name }
    fun setShowMesh(on: Boolean) { handle[KEY_MESH] = on }
    fun fitAll() { _fit.value += 1 }
    fun clearError() = controller.clearError()

    fun claim(c: ResponderCase) { viewModelScope.launch { controller.claim(c) } }
    fun advance(c: ResponderCase, status: String, outcome: String? = null) {
        viewModelScope.launch {
            if (controller.advance(c, status, outcome) && (status == "resolved" || status == "released")) handle[KEY_SELECTED] = null
        }
    }
    /** Returns through [done] so the note field only clears on success. */
    fun addNote(c: ResponderCase, text: String, done: (Boolean) -> Unit) {
        viewModelScope.launch { done(controller.addNote(c, text.trim())) }
    }

    private companion object {
        const val KEY_SELECTED = "responder_selected"
        const val KEY_FILTER = "responder_filter"
        const val KEY_MESH = "responder_mesh"
        const val KEY_SHARE = "share_location"
        const val KEY_USER = "responder_user"
    }
}
