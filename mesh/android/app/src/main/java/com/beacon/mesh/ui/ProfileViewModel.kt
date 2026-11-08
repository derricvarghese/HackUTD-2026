package com.beacon.mesh.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.beacon.mesh.MeshNode
import com.beacon.mesh.profile.Consent
import com.beacon.mesh.profile.ProfileConsentText
import com.beacon.mesh.profile.ProfileRecord
import com.beacon.mesh.profile.ProfileStatus
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.ui.logic.ProfileEditor
import com.beacon.mesh.ui.logic.ProfileForm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Profile onboarding and "My profile" editing. The form text is autosaved (encrypted, in the profile store, never in the
 * saved-state bundle) so it survives process death; the non-sensitive position (section, consent given) lives in [SavedStateHandle].
 */
@OptIn(FlowPreview::class)
class ProfileViewModel(app: Application, private val handle: SavedStateHandle) : AndroidViewModel(app) {
    private val node = MeshNode.get(app)
    private val repo = node.profiles

    val status: StateFlow<ProfileStatus> = node.state.map { it.profile }
        .stateIn(viewModelScope, SharingStarted.Eagerly, ProfileStatus.of(repo.current, true, null))
    val record: StateFlow<ProfileRecord> = repo.state

    private val _editor = MutableStateFlow(newEditor(fromSaved = false))
    val editor: StateFlow<ProfileEditor> = _editor

    /** Consent card accepted in this session (or an existing profile already has consent). */
    val consentGiven: StateFlow<Boolean> = handle.getStateFlow(KEY_CONSENT, false)

    init {
        // Autosave the form (debounced) so a killed process does not lose what was typed.
        viewModelScope.launch(Dispatchers.IO) {
            _editor.collectLatest { e ->
                e.form.debounce(600).collect { f ->
                    val rec = repo.current
                    val saved = ProfileForm.fromProfile(rec.profile)
                    if (f == ProfileForm() || f == saved) {
                        if (rec.draft != null) repo.saveDraft(null)
                    } else repo.saveDraft(f.toDraftJson())
                }
            }
        }
    }

    private fun newEditor(fromSaved: Boolean): ProfileEditor {
        val rec = repo.current
        val form = when {
            !fromSaved && rec.draft != null -> ProfileForm.fromDraftJson(rec.draft)
            else -> ProfileForm.fromProfile(rec.profile)
        }
        return ProfileEditor(form, handle[KEY_STEP] ?: 0, handle[KEY_ATTEMPTED] ?: false).also { e ->
            viewModelScope.launch { e.step.collect { handle[KEY_STEP] = it } }
            viewModelScope.launch { e.attempted.collect { handle[KEY_ATTEMPTED] = it } }
        }
    }

    /** Opening "Edit profile": start from what is saved (an unsaved draft from a killed process is restored by [newEditor]). */
    fun beginEdit() {
        handle[KEY_STEP] = 0; handle[KEY_ATTEMPTED] = false
        repo.saveDraft(null)
        _editor.value = newEditor(fromSaved = true)
    }

    fun discardEdit() {
        repo.saveDraft(null)
        handle[KEY_STEP] = 0; handle[KEY_ATTEMPTED] = false
        _editor.value = newEditor(fromSaved = true)
    }

    fun acceptConsent() {
        if (handle.get<Long>(KEY_CONSENT_AT) == null) handle[KEY_CONSENT_AT] = System.currentTimeMillis()
        handle[KEY_CONSENT] = true
    }

    /** Back from the first form section returns to the consent card. */
    fun declineConsent() { handle[KEY_CONSENT] = false }

    /** Version id to send: what the server asked for, else the wording this build ships. */
    private fun consentVersion() = status.value.serverConsentVersion ?: ProfileConsentText.VERSION

    /** Validates and stores the profile (then the node syncs it). @return false when the form still has errors. */
    fun save(): Boolean {
        val profile = _editor.value.trySave() ?: return false
        val existing = repo.current.consent
        val consent = if (existing != null && existing.version == consentVersion()) existing
        else Consent(consentVersion(), Iso.format(handle.get<Long>(KEY_CONSENT_AT) ?: System.currentTimeMillis()))
        node.saveProfile(profile, consent)
        handle[KEY_STEP] = 0; handle[KEY_ATTEMPTED] = false
        _editor.value = newEditor(fromSaved = true)
        return true
    }

    /** Onboarding: always allowed. No consent is recorded, nothing is uploaded and SOS payloads carry no profile_summary. */
    fun skip() { handle[KEY_CONSENT] = false; handle.remove<Long>(KEY_CONSENT_AT); repo.markStepDone() }

    /** Re-agree after the server announced a new consent version. */
    fun reconsent() {
        node.acceptProfileConsent(Consent(consentVersion(), Iso.format(System.currentTimeMillis())))
    }

    fun deleteProfile() {
        node.deleteProfile()
        handle[KEY_CONSENT] = false
        handle.remove<Long>(KEY_CONSENT_AT)
        _editor.value = newEditor(fromSaved = true)
    }

    fun retrySync() = node.retryProfileSync()
    fun dismissBanner() = repo.dismissBanner()
    /** Called when the profile step appears: learn `profile_required` and the consent version if online. */
    fun refreshServerInfo() = node.refreshServerInfo()

    private companion object {
        const val KEY_STEP = "profile_step"
        const val KEY_ATTEMPTED = "profile_attempted"
        const val KEY_CONSENT = "profile_consent"
        const val KEY_CONSENT_AT = "profile_consent_at"
    }
}
