package com.beacon.mesh.ui

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.beacon.mesh.MeshNode
import com.beacon.mesh.MeshService
import com.beacon.mesh.MeshSnapshot
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.ui.logic.BackendUrl
import com.beacon.mesh.ui.logic.BackendUrlResult
import com.beacon.mesh.ui.logic.SosDraft
import com.beacon.mesh.ui.theme.ThemeMode
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update

/** One-shot results shown as snackbars. */
sealed interface UiEvent {
    data class SosSent(val messageId: String, val category: Category) : UiEvent
    data object SosFailed : UiEvent
}

/**
 * Single source of truth for the UI: mesh snapshot (from [MeshNode.state]), UI settings, and the
 * SOS draft. The draft lives in [SavedStateHandle] so it survives rotation and process death.
 */
class MeshViewModel(app: Application, private val handle: SavedStateHandle) : AndroidViewModel(app) {
    private val node = MeshNode.get(app)
    private val prefs = UiPrefs(app)

    val mesh: StateFlow<MeshSnapshot> = node.state

    private val _settings = MutableStateFlow(prefs.load())
    val settings: StateFlow<UiSettings> = _settings

    val draft: StateFlow<SosDraft?> = combine(
        handle.getStateFlow<String?>(KEY_CATEGORY, null),
        handle.getStateFlow(KEY_NOTE, ""),
        handle.getStateFlow(KEY_PEOPLE, 1),
    ) { cat, note, people ->
        Category.entries.firstOrNull { it.wire == cat }?.let { SosDraft(it, note, people) }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _events = Channel<UiEvent>(Channel.BUFFERED)
    val events: Flow<UiEvent> = _events.receiveAsFlow()

    // ---- SOS flow ----

    fun openSos(category: Category) {
        handle[KEY_CATEGORY] = category.wire
        handle[KEY_NOTE] = ""
        handle[KEY_PEOPLE] = 1
    }

    fun setNote(value: String) { handle[KEY_NOTE] = SosDraft(Category.OTHER).withNote(value).note }
    fun setPeople(value: Int) { handle[KEY_PEOPLE] = SosDraft(Category.OTHER).withPeople(value).people }
    fun cancelSos() { handle[KEY_CATEGORY] = null }

    fun confirmSos() {
        val d = draft.value ?: return
        handle[KEY_CATEGORY] = null
        val people = d.people.takeIf { it > 1 || d.category != Category.SAFE }
        val msg = node.sendSos(d.category, d.noteOrNull, people)
        _events.trySend(if (msg != null) UiEvent.SosSent(msg.id, d.category) else UiEvent.SosFailed)
    }

    // ---- Mesh lifecycle ----

    /** Start the foreground service and the node. Call only after permissions are granted. */
    fun startMesh() {
        val app = getApplication<Application>()
        ContextCompat.startForegroundService(app, Intent(app, MeshService::class.java))
        node.start()
    }

    // ---- Settings ----

    fun setThemeMode(mode: ThemeMode) = updateSettings { it.copy(themeMode = mode) }
    fun setDynamicColor(on: Boolean) = updateSettings { it.copy(dynamicColor = on) }
    fun setOnboardingDone(done: Boolean) = updateSettings { it.copy(onboardingDone = done) }
    fun markPermissionsAsked(perms: Collection<String>) =
        updateSettings { it.copy(askedPermissions = it.askedPermissions + perms) }

    private fun updateSettings(f: (UiSettings) -> UiSettings) {
        _settings.update(f)
        prefs.save(_settings.value)
    }

    /** Saves the backend URL if valid (or blank to disable); returns the validation result. */
    fun saveBackendUrl(raw: String): BackendUrlResult {
        val r = BackendUrl.validate(raw)
        when (r) {
            is BackendUrlResult.Valid -> node.backendUrl = r.normalized
            BackendUrlResult.Empty -> node.backendUrl = ""
            is BackendUrlResult.Invalid -> Unit
        }
        return r
    }

    fun setHopCap(cap: Int?) { node.demoHopCap = cap?.coerceIn(1, 10) }
    fun setForceOffline(on: Boolean) { node.forceOffline = on }

    private companion object {
        const val KEY_CATEGORY = "sos_category"
        const val KEY_NOTE = "sos_note"
        const val KEY_PEOPLE = "sos_people"
    }
}
