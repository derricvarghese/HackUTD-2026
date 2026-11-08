package com.beacon.mesh.ui.logic

import com.beacon.mesh.profile.BloodType
import com.beacon.mesh.profile.EmergencyContact
import com.beacon.mesh.profile.FieldError
import com.beacon.mesh.profile.ErrorKind
import com.beacon.mesh.profile.MobilityNeed
import com.beacon.mesh.profile.Pet
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.UserProfile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject

/** The form is a sequence of sections; the progress indicator advances across them. */
enum class ProfileSection { IDENTITY, APPEARANCE, MEDICAL, HOUSEHOLD, CONTACT, NOTES;

    companion object {
        /** Which section shows the error for a validation key (`appearance.hair` -> APPEARANCE). */
        fun of(key: String): ProfileSection = when {
            key == "full_name" || key == "preferred_name" || key == "birth_year" || key == "languages" || key == "phone" -> IDENTITY
            key.startsWith("appearance") -> APPEARANCE
            key.startsWith("medical") || key.startsWith("mobility") -> MEDICAL
            key.startsWith("household") -> HOUSEHOLD
            key.startsWith("emergency_contact") || key == "home_address" -> CONTACT
            else -> NOTES
        }
    }
}

data class PetForm(val kind: String = "", val count: String = "")

/** Raw text of every field, so half-typed numbers survive rotation and process death. Parsed by [toProfile]. */
data class ProfileForm(
    val fullName: String = "",
    val preferredName: String = "",
    val birthYear: String = "",
    val languages: String = "",
    val phone: String = "",
    val height: String = "",
    val hair: String = "",
    val clothing: String = "",
    val marks: String = "",
    val conditions: String = "",
    val medications: String = "",
    val allergies: String = "",
    val bloodType: BloodType? = null,
    val mobilityNeeds: Set<MobilityNeed> = emptySet(),
    val mobilityNotes: String = "",
    val peopleCount: String = "",
    val children: String = "",
    val elderly: String = "",
    val pets: List<PetForm> = emptyList(),
    val homeAddress: String = "",
    val contactName: String = "",
    val contactPhone: String = "",
    val contactRelationship: String = "",
    val notes: String = "",
) {
    /** Parsed profile plus errors for numbers that are not numbers (they are also dropped from the profile). */
    data class Parsed(val profile: UserProfile, val errors: Map<String, FieldError>)

    fun parse(nowMs: Long = System.currentTimeMillis()): Parsed {
        val bad = LinkedHashMap<String, FieldError>()
        fun num(key: String, s: String): Int? {
            val t = s.trim()
            if (t.isEmpty()) return null
            return t.toIntOrNull() ?: run { bad[key] = FieldError(ErrorKind.BAD_NUMBER); null }
        }
        val petList = pets.filter { it.kind.isNotBlank() || it.count.isNotBlank() }.mapIndexed { i, p ->
            Pet(p.kind, num("household.pets.$i.count", p.count))
        }
        val anyContact = contactName.isNotBlank() || contactPhone.isNotBlank() || contactRelationship.isNotBlank()
        val profile = UserProfile(
            fullName = fullName, preferredName = preferredName, birthYear = num("birth_year", birthYear),
            languages = ProfileRules.splitList(languages), phone = phone,
            heightCm = num("appearance.height_cm", height), hair = hair, clothing = clothing, distinguishingMarks = marks,
            conditions = ProfileRules.splitList(conditions), medications = ProfileRules.splitList(medications), allergies = ProfileRules.splitList(allergies),
            bloodType = bloodType, mobilityNeeds = mobilityNeeds, mobilityNotes = mobilityNotes,
            peopleCount = num("household.people_count", peopleCount), children = num("household.children", children), elderly = num("household.elderly", elderly),
            pets = petList, homeAddress = homeAddress,
            emergencyContact = if (anyContact) EmergencyContact(contactName, contactPhone, contactRelationship) else null,
            notes = notes,
        )
        return Parsed(profile, bad)
    }

    /** All errors (parse + rules). Empty = ready to save. */
    fun errors(nowMs: Long = System.currentTimeMillis()): Map<String, FieldError> {
        val p = parse(nowMs)
        return ProfileRules.validate(p.profile, nowMs) + p.errors
    }

    fun toDraftJson(): JSONObject = JSONObject().apply {
        put("fullName", fullName); put("preferredName", preferredName); put("birthYear", birthYear); put("languages", languages); put("phone", phone)
        put("height", height); put("hair", hair); put("clothing", clothing); put("marks", marks)
        put("conditions", conditions); put("medications", medications); put("allergies", allergies)
        bloodType?.let { put("bloodType", it.wire) }
        put("needs", JSONArray(mobilityNeeds.map { it.wire })); put("mobilityNotes", mobilityNotes)
        put("peopleCount", peopleCount); put("children", children); put("elderly", elderly)
        put("pets", JSONArray().also { a -> pets.forEach { a.put(JSONObject().put("k", it.kind).put("c", it.count)) } })
        put("homeAddress", homeAddress); put("contactName", contactName); put("contactPhone", contactPhone); put("contactRelationship", contactRelationship)
        put("notes", notes)
    }

    companion object {
        fun fromProfile(p: UserProfile?): ProfileForm {
            p ?: return ProfileForm()
            fun n(i: Int?) = i?.toString() ?: ""
            return ProfileForm(
                fullName = p.fullName, preferredName = p.preferredName, birthYear = n(p.birthYear), languages = p.languages.joinToString(", "), phone = p.phone,
                height = n(p.heightCm), hair = p.hair, clothing = p.clothing, marks = p.distinguishingMarks,
                conditions = p.conditions.joinToString(", "), medications = p.medications.joinToString(", "), allergies = p.allergies.joinToString(", "),
                bloodType = p.bloodType, mobilityNeeds = p.mobilityNeeds, mobilityNotes = p.mobilityNotes,
                peopleCount = n(p.peopleCount), children = n(p.children), elderly = n(p.elderly),
                pets = p.pets.map { PetForm(it.kind, n(it.count)) }, homeAddress = p.homeAddress,
                contactName = p.emergencyContact?.name ?: "", contactPhone = p.emergencyContact?.phone ?: "",
                contactRelationship = p.emergencyContact?.relationship ?: "", notes = p.notes,
            )
        }

        fun fromDraftJson(o: JSONObject): ProfileForm = ProfileForm(
            fullName = o.optString("fullName"), preferredName = o.optString("preferredName"), birthYear = o.optString("birthYear"),
            languages = o.optString("languages"), phone = o.optString("phone"), height = o.optString("height"), hair = o.optString("hair"),
            clothing = o.optString("clothing"), marks = o.optString("marks"), conditions = o.optString("conditions"),
            medications = o.optString("medications"), allergies = o.optString("allergies"),
            bloodType = if (o.has("bloodType")) BloodType.fromWire(o.optString("bloodType")) else null,
            mobilityNeeds = o.optJSONArray("needs")?.let { a -> (0 until a.length()).mapNotNull { MobilityNeed.fromWire(a.optString(it)) }.toSet() } ?: emptySet(),
            mobilityNotes = o.optString("mobilityNotes"), peopleCount = o.optString("peopleCount"), children = o.optString("children"),
            elderly = o.optString("elderly"),
            pets = o.optJSONArray("pets")?.let { a -> (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { PetForm(it.optString("k"), it.optString("c")) } } } ?: emptyList(),
            homeAddress = o.optString("homeAddress"), contactName = o.optString("contactName"), contactPhone = o.optString("contactPhone"),
            contactRelationship = o.optString("contactRelationship"), notes = o.optString("notes"),
        )
    }
}

/**
 * State machine behind the profile form (onboarding and "My profile"): current section, whether errors are shown yet,
 * what may be saved. Pure Kotlin so it is unit tested; [com.beacon.mesh.ui.ProfileViewModel] adds persistence.
 */
class ProfileEditor(
    initial: ProfileForm,
    initialStep: Int = 0,
    initialAttempted: Boolean = false,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val _form = MutableStateFlow(initial)
    val form: StateFlow<ProfileForm> = _form.asStateFlow()
    private val _step = MutableStateFlow(initialStep.coerceIn(0, LAST))
    val step: StateFlow<Int> = _step.asStateFlow()
    private val _attempted = MutableStateFlow(initialAttempted)
    /** Errors are only shown once the user tried to move on or save. */
    val attempted: StateFlow<Boolean> = _attempted.asStateFlow()

    val section: ProfileSection get() = ProfileSection.entries[_step.value]
    val isLast: Boolean get() = _step.value == LAST
    /** 0..1 across sections; the first section counts as in progress, the last as complete. */
    val progress: Float get() = (_step.value + 1).toFloat() / ProfileSection.entries.size

    fun edit(f: (ProfileForm) -> ProfileForm) { _form.update(f) }
    fun errors(): Map<String, FieldError> = _form.value.errors(nowMs())
    /** Errors to display right now (none until the first attempt). */
    fun visibleErrors(): Map<String, FieldError> = if (_attempted.value) errors() else emptyMap()
    fun sectionErrors(s: ProfileSection) = errors().filterKeys { ProfileSection.of(it) == s }

    /** The only hard requirement is a valid name; everything else may stay empty but must be valid when filled. */
    fun canSave(): Boolean = errors().isEmpty()

    /** Moves to the next section if the current one is valid; otherwise reveals its errors. @return true when it moved. */
    fun next(): Boolean {
        if (sectionErrors(section).isNotEmpty()) { _attempted.value = true; return false }
        if (isLast) return false
        _step.value += 1
        return true
    }

    fun back(): Boolean {
        if (_step.value == 0) return false
        _step.value -= 1
        return true
    }

    fun goTo(i: Int) { _step.value = i.coerceIn(0, LAST) }

    /** The profile to store, or null (and errors shown, jumping to the first broken section) when invalid. */
    fun trySave(): UserProfile? {
        val errs = errors()
        if (errs.isNotEmpty()) {
            _attempted.value = true
            _step.value = ProfileSection.of(errs.keys.first()).ordinal
            return null
        }
        return _form.value.parse(nowMs()).profile
    }

    companion object { val LAST = ProfileSection.entries.size - 1 }
}

/** Decisions the onboarding profile step makes, kept pure. */
object ProfileOnboardingLogic {
    /** "Skip for now" is available in every state (consent card, any form section, server unreachable, `profile_required` true): SOS is never blocked. */
    @Suppress("UNUSED_PARAMETER")
    fun canSkip(serverRequired: Boolean = true) = true

    /** The name is the minimum even when offline; a bad optional field blocks saving until fixed or cleared. */
    fun canFinish(form: ProfileForm, nowMs: Long = System.currentTimeMillis()) = form.errors(nowMs).isEmpty()

    enum class Nudge { NONE, BANNER, PROMINENT }

    /**
     * Home nudge: shown after a skip (no profile) or while only a name is set; hidden once dismissed this session
     * (it returns next launch). When the server says `profile_required` the nudge is the more prominent tonal card. Never blocks anything.
     */
    fun nudge(hasProfile: Boolean, optionalEmpty: Boolean, dismissedThisSession: Boolean, serverRequired: Boolean, erasing: Boolean = false): Nudge = when {
        erasing || dismissedThisSession -> Nudge.NONE
        hasProfile && !optionalEmpty -> Nudge.NONE
        !hasProfile -> if (serverRequired) Nudge.PROMINENT else Nudge.BANNER
        else -> Nudge.BANNER
    }
}

enum class ProfileChipKind { NONE, SYNCED, PENDING, FAILED, CONSENT, ERASING }

/** Maps the sync bookkeeping to the status chip shown on Home / Settings: Synced / Will sync when online / Sync failed - retry. */
object ProfileStatusLogic {
    fun chip(s: com.beacon.mesh.profile.ProfileStatus): ProfileChipKind = when {
        s.pendingErase -> ProfileChipKind.ERASING
        !s.hasProfile -> ProfileChipKind.NONE
        s.syncState == com.beacon.mesh.profile.SyncState.NEEDS_CONSENT -> ProfileChipKind.CONSENT
        s.syncState == com.beacon.mesh.profile.SyncState.SYNCED -> ProfileChipKind.SYNCED
        s.syncState == com.beacon.mesh.profile.SyncState.FAILED -> ProfileChipKind.FAILED
        else -> ProfileChipKind.PENDING
    }
}

/** Glue between the stored centimetre text of the form and the feet/inches boxes. Pure. */
object HeightInput {
    /** Centimetre text -> (feet, inches) box text; blank or unparsable stays blank. */
    fun fromCm(cm: String): Pair<String, String> {
        val v = cm.trim().toIntOrNull() ?: return "" to ""
        if (v <= 0) return "" to ""
        val fi = com.beacon.mesh.units.Units.cmToFeetInches(v)
        return fi.feet.toString() to fi.inches.toString()
    }

    /**
     * Feet/inches box text -> centimetre text for the form. Blank boxes give blank. Anything else that is not a valid
     * height gives "0", which the profile rules reject (30..260), so a bad entry can never be saved by accident.
     */
    fun toCm(feet: String, inches: String): String {
        if (feet.isBlank() && inches.isBlank()) return ""
        return com.beacon.mesh.units.Units.parseHeightFeetInches(feet, inches)?.toString() ?: "0"
    }
}
