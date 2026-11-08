package com.beacon.mesh.profile

import org.json.JSONArray
import org.json.JSONObject

/** Contract enums (openapi.yaml `ProfileMobility.needs`, `ProfileMedical.blood_type`). */
enum class MobilityNeed(val wire: String) {
    WHEELCHAIR("wheelchair"), CANNOT_WALK("cannot_walk"), WALKS_WITH_AID("walks_with_aid"),
    VISION_IMPAIRED("vision_impaired"), HEARING_IMPAIRED("hearing_impaired"), COGNITIVE("cognitive"),
    OXYGEN_DEPENDENT("oxygen_dependent"), OTHER("other");

    companion object { fun fromWire(s: String) = entries.firstOrNull { it.wire == s } }
}

enum class BloodType(val wire: String) {
    A_POS("A+"), A_NEG("A-"), B_POS("B+"), B_NEG("B-"), AB_POS("AB+"), AB_NEG("AB-"), O_POS("O+"), O_NEG("O-"), UNKNOWN("unknown");

    companion object { fun fromWire(s: String) = entries.firstOrNull { it.wire == s } }
}

data class Pet(val kind: String, val count: Int? = null)
data class EmergencyContact(val name: String, val phone: String, val relationship: String)

/**
 * The user's identity profile as kept on the phone and sent to the server (`ProfileInput` minus `consent`).
 * Empty strings / empty lists / nulls mean "not provided" and are omitted from the wire JSON.
 * Personal data: never log it, never put it in a mesh message (only [com.beacon.mesh.profile.ProfileRules.summary] may travel).
 */
data class UserProfile(
    val fullName: String = "",
    val preferredName: String = "",
    val birthYear: Int? = null,
    val languages: List<String> = emptyList(),
    val phone: String = "",
    val heightCm: Int? = null,
    val hair: String = "",
    val clothing: String = "",
    val distinguishingMarks: String = "",
    val conditions: List<String> = emptyList(),
    val medications: List<String> = emptyList(),
    val allergies: List<String> = emptyList(),
    val bloodType: BloodType? = null,
    val mobilityNeeds: Set<MobilityNeed> = emptySet(),
    val mobilityNotes: String = "",
    val peopleCount: Int? = null,
    val children: Int? = null,
    val elderly: Int? = null,
    val pets: List<Pet> = emptyList(),
    val homeAddress: String = "",
    val emergencyContact: EmergencyContact? = null,
    val notes: String = "",
) {
    /** True when nothing beyond the (mandatory) name is filled in: drives the "Complete your profile" banner. */
    val optionalSectionsEmpty: Boolean
        get() = copy(fullName = "") == UserProfile()

    /** `ProfileInput` JSON. Empty values are omitted (PUT is a full replace, so omitted = removed on the server). */
    fun toInputJson(consent: Consent): JSONObject = toJson().put(
        "consent",
        JSONObject().put("accepted", true).put("version", consent.version).put("accepted_at", consent.acceptedAt),
    )

    /** Same as the input JSON without consent; also the local storage format. */
    fun toJson(): JSONObject = JSONObject().apply {
        put("full_name", fullName.trim())
        preferredName.trim().takeIf { it.isNotEmpty() }?.let { put("preferred_name", it) }
        birthYear?.let { put("birth_year", it) }
        if (languages.isNotEmpty()) put("languages", JSONArray(languages))
        phone.trim().takeIf { it.isNotEmpty() }?.let { put("phone", it) }
        val appearance = JSONObject().apply {
            heightCm?.let { put("height_cm", it) }
            hair.trim().takeIf { it.isNotEmpty() }?.let { put("hair", it) }
            clothing.trim().takeIf { it.isNotEmpty() }?.let { put("clothing", it) }
            distinguishingMarks.trim().takeIf { it.isNotEmpty() }?.let { put("distinguishing_marks", it) }
        }
        if (appearance.length() > 0) put("appearance", appearance)
        val medical = JSONObject().apply {
            if (conditions.isNotEmpty()) put("conditions", JSONArray(conditions))
            if (medications.isNotEmpty()) put("medications", JSONArray(medications))
            if (allergies.isNotEmpty()) put("allergies", JSONArray(allergies))
            bloodType?.let { put("blood_type", it.wire) }
        }
        if (medical.length() > 0) put("medical", medical)
        val mobility = JSONObject().apply {
            if (mobilityNeeds.isNotEmpty()) put("needs", JSONArray(MobilityNeed.entries.filter { it in mobilityNeeds }.map { it.wire }))
            mobilityNotes.trim().takeIf { it.isNotEmpty() }?.let { put("notes", it) }
        }
        if (mobility.length() > 0) put("mobility", mobility)
        val household = JSONObject().apply {
            peopleCount?.let { put("people_count", it) }
            children?.let { put("children", it) }
            elderly?.let { put("elderly", it) }
            if (pets.isNotEmpty()) put("pets", JSONArray().also { a ->
                pets.forEach { p -> a.put(JSONObject().put("kind", p.kind.trim()).also { o -> p.count?.let { c -> o.put("count", c) } }) }
            })
        }
        if (household.length() > 0) put("household", household)
        homeAddress.trim().takeIf { it.isNotEmpty() }?.let { put("home_address", it) }
        emergencyContact?.let {
            put("emergency_contact", JSONObject().put("name", it.name.trim()).put("phone", it.phone.trim()).put("relationship", it.relationship.trim()))
        }
        notes.trim().takeIf { it.isNotEmpty() }?.let { put("notes", it) }
    }

    companion object {
        private fun JSONObject.str(k: String) = if (has(k) && !isNull(k)) optString(k) else ""
        private fun JSONObject.int(k: String) = if (has(k) && !isNull(k)) optInt(k) else null
        private fun JSONObject.list(k: String): List<String> =
            optJSONArray(k)?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotEmpty() } } ?: emptyList()

        /** Parses the local format and the server's `ProfileFull` (extra fields are ignored). */
        fun fromJson(o: JSONObject): UserProfile {
            val ap = o.optJSONObject("appearance")
            val med = o.optJSONObject("medical")
            val mob = o.optJSONObject("mobility")
            val hh = o.optJSONObject("household")
            val ec = o.optJSONObject("emergency_contact")
            return UserProfile(
                fullName = o.str("full_name"),
                preferredName = o.str("preferred_name"),
                birthYear = o.int("birth_year"),
                languages = o.list("languages"),
                phone = o.str("phone"),
                heightCm = ap?.int("height_cm"),
                hair = ap?.str("hair") ?: "",
                clothing = ap?.str("clothing") ?: "",
                distinguishingMarks = ap?.str("distinguishing_marks") ?: "",
                conditions = med?.list("conditions") ?: emptyList(),
                medications = med?.list("medications") ?: emptyList(),
                allergies = med?.list("allergies") ?: emptyList(),
                bloodType = med?.str("blood_type")?.let { BloodType.fromWire(it) },
                mobilityNeeds = mob?.list("needs")?.mapNotNull { MobilityNeed.fromWire(it) }?.toSet() ?: emptySet(),
                mobilityNotes = mob?.str("notes") ?: "",
                peopleCount = hh?.int("people_count"),
                children = hh?.int("children"),
                elderly = hh?.int("elderly"),
                pets = hh?.optJSONArray("pets")?.let { a ->
                    (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { Pet(it.str("kind"), it.int("count")) } }
                } ?: emptyList(),
                homeAddress = o.str("home_address"),
                emergencyContact = ec?.let { EmergencyContact(it.str("name"), it.str("phone"), it.str("relationship")) },
                notes = o.str("notes"),
            )
        }
    }
}

/** What the user agreed to: the consent text version id and when. */
data class Consent(val version: String, val acceptedAt: String)

enum class SyncState { PENDING, SYNCED, FAILED, NEEDS_CONSENT }

/**
 * Everything persisted about the profile (one encrypted blob). [profileVersion] is the last version the server acknowledged
 * (0 = never). [rev] counts local edits so a sync that raced an edit does not mark the newer data as synced.
 */
data class ProfileRecord(
    val profile: UserProfile? = null,
    val consent: Consent? = null,
    val profileVersion: Int = 0,
    val syncState: SyncState = SyncState.PENDING,
    /** Short machine-ish reason (never profile content). */
    val lastError: String? = null,
    val rev: Int = 0,
    val attempts: Int = 0,
    val nextAttemptAtMs: Long = 0,
    val lastSyncedAtMs: Long = 0,
    /** The server still has to be told to erase a profile the user already deleted locally. */
    val pendingErase: Boolean = false,
    /** Onboarding profile step finished (saved, or skipped when the server allows). */
    val stepDone: Boolean = false,
    /** User dismissed the "Complete your profile" banner. */
    val bannerDismissed: Boolean = false,
    /** In-progress form text, restored after process death. */
    val draft: JSONObject? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        profile?.let { put("profile", it.toJson()) }
        consent?.let { put("consent", JSONObject().put("version", it.version).put("accepted_at", it.acceptedAt)) }
        put("profile_version", profileVersion); put("sync_state", syncState.name)
        lastError?.let { put("last_error", it) }
        put("rev", rev); put("attempts", attempts); put("next_attempt_at", nextAttemptAtMs); put("last_synced_at", lastSyncedAtMs)
        put("pending_erase", pendingErase); put("step_done", stepDone); put("banner_dismissed", bannerDismissed)
        draft?.let { put("draft", it) }
    }

    companion object {
        fun fromJson(o: JSONObject) = ProfileRecord(
            profile = o.optJSONObject("profile")?.let { UserProfile.fromJson(it) },
            consent = o.optJSONObject("consent")?.let { Consent(it.optString("version"), it.optString("accepted_at")) },
            profileVersion = o.optInt("profile_version", 0),
            syncState = runCatching { SyncState.valueOf(o.optString("sync_state")) }.getOrDefault(SyncState.PENDING),
            lastError = if (o.has("last_error")) o.optString("last_error") else null,
            rev = o.optInt("rev", 0), attempts = o.optInt("attempts", 0),
            nextAttemptAtMs = o.optLong("next_attempt_at", 0), lastSyncedAtMs = o.optLong("last_synced_at", 0),
            pendingErase = o.optBoolean("pending_erase", false), stepDone = o.optBoolean("step_done", false),
            bannerDismissed = o.optBoolean("banner_dismissed", false),
            draft = o.optJSONObject("draft"),
        )
    }
}

/** Non-sensitive view of the profile for the mesh snapshot / status screens: no content, only sync bookkeeping. */
data class ProfileStatus(
    val hasProfile: Boolean = false,
    val syncState: SyncState = SyncState.PENDING,
    val profileVersion: Int = 0,
    val lastError: String? = null,
    val pendingErase: Boolean = false,
    val lastSyncedAtMs: Long = 0,
    val nextAttemptAtMs: Long = 0,
    val optionalSectionsEmpty: Boolean = true,
    val stepDone: Boolean = false,
    val bannerDismissed: Boolean = false,
    val consentVersion: String? = null,
    val consentAcceptedAt: String? = null,
    /** From /server-info (cached). Unknown counts as required. */
    val serverRequired: Boolean = true,
    val serverConsentVersion: String? = null,
) {
    companion object {
        fun of(r: ProfileRecord, serverRequired: Boolean, serverConsentVersion: String?) = ProfileStatus(
            hasProfile = r.profile != null, syncState = r.syncState, profileVersion = r.profileVersion, lastError = r.lastError,
            pendingErase = r.pendingErase, lastSyncedAtMs = r.lastSyncedAtMs, nextAttemptAtMs = r.nextAttemptAtMs,
            optionalSectionsEmpty = r.profile?.optionalSectionsEmpty ?: true, stepDone = r.stepDone, bannerDismissed = r.bannerDismissed,
            consentVersion = r.consent?.version, consentAcceptedAt = r.consent?.acceptedAt,
            serverRequired = serverRequired, serverConsentVersion = serverConsentVersion,
        )
    }
}
