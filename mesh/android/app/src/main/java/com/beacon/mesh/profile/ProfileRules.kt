package com.beacon.mesh.profile

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneOffset

enum class ErrorKind { REQUIRED, TOO_LONG, OUT_OF_RANGE, BAD_PHONE, TOO_MANY, BAD_NUMBER, EXCEEDS_PEOPLE, BAD_LANGUAGE, INVALID_CHARS }

/** One validation failure; [min]/[max] feed the message ("at most 120 characters", "1900 to 2026"). */
data class FieldError(val kind: ErrorKind, val min: Int = 0, val max: Int = 0)

/**
 * Pure rules shared by the form, the sync engine and the mesh summary. They mirror the server's
 * (server/src/domain/profile.ts and openapi.yaml): same flags, same age buckets, same limits.
 */
object ProfileRules {
    const val NAME_MAX = 120
    const val PREFERRED_MAX = 60
    const val FREE_MAX = 300
    const val NOTES_MAX = 1000
    const val ITEM_MAX = 100
    const val LIST_MAX = 20
    const val LANGUAGES_MAX = 8
    const val LANGUAGE_MIN_LEN = 2
    const val LANGUAGE_MAX_LEN = 35
    const val PETS_MAX = 10
    const val PET_KIND_MAX = 40
    const val HEIGHT_MIN = 30
    const val HEIGHT_MAX = 260
    const val PEOPLE_MAX = 50
    const val BIRTH_MIN = 1900
    val PHONE_RE = Regex("""^\+?[0-9][0-9 ()\-.]{4,24}[0-9]$""")
    private val LANG_RE = Regex("""^[\p{L}\p{M}0-9 _-]{2,35}$""")
    private val CONTROL = Regex("""[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]""")

    /** Order the server emits flags in. */
    val FLAG_ORDER = listOf("oxygen", "mobility", "medical", "sensory", "cognitive", "elderly", "child")

    fun currentYear(nowMs: Long = System.currentTimeMillis()): Int = Instant.ofEpochMilli(nowMs).atZone(ZoneOffset.UTC).year

    /** `max(0, current year - birth year)`, like the server (so it can be off by one). */
    fun ageOf(birthYear: Int?, nowMs: Long = System.currentTimeMillis()): Int? =
        birthYear?.let { maxOf(0, currentYear(nowMs) - it) }

    fun ageRange(age: Int?): String? = when {
        age == null -> null
        age <= 12 -> "0-12"
        age <= 17 -> "13-17"
        age <= 34 -> "18-34"
        age <= 49 -> "35-49"
        age <= 64 -> "50-64"
        age <= 79 -> "65-79"
        else -> "80+"
    }

    /**
     * Coarse vulnerability flags, identical to the server's `staticFlags` + `allFlags`:
     * mobility = wheelchair / cannot_walk / walks_with_aid; oxygen = oxygen_dependent; sensory = vision / hearing impaired;
     * cognitive = cognitive; medical = any listed condition, medication or allergy; elderly = age 65+; child = age 12 or under.
     */
    fun flags(p: UserProfile, nowMs: Long = System.currentTimeMillis()): List<String> {
        val out = HashSet<String>()
        val n = p.mobilityNeeds
        if (MobilityNeed.WHEELCHAIR in n || MobilityNeed.CANNOT_WALK in n || MobilityNeed.WALKS_WITH_AID in n) out.add("mobility")
        if (MobilityNeed.OXYGEN_DEPENDENT in n) out.add("oxygen")
        if (MobilityNeed.VISION_IMPAIRED in n || MobilityNeed.HEARING_IMPAIRED in n) out.add("sensory")
        if (MobilityNeed.COGNITIVE in n) out.add("cognitive")
        if (p.conditions.isNotEmpty() || p.medications.isNotEmpty() || p.allergies.isNotEmpty()) out.add("medical")
        val age = ageOf(p.birthYear, nowMs)
        if (age != null && age >= 65) out.add("elderly")
        if (age != null && age <= 12) out.add("child")
        return FLAG_ORDER.filter { it in out }
    }

    /** `MeshPayload.profile_summary`: the only profile data that may travel the mesh. [version] = last server-acknowledged version. */
    fun summary(p: UserProfile, version: Int, nowMs: Long = System.currentTimeMillis()): JSONObject? {
        val name = p.fullName.trim()
        if (name.isEmpty()) return null
        return JSONObject().apply {
            // the contract allows 120 chars; keep the sealed envelope well inside the 64-chunk BLE budget
            put("full_name", name.take(SUMMARY_NAME_MAX).trim())
            ageRange(ageOf(p.birthYear, nowMs))?.let { put("age_range", it) }
            flags(p, nowMs).takeIf { it.isNotEmpty() }?.let { put("vulnerability_flags", JSONArray(it)) }
            put("profile_version", maxOf(0, version))
        }
    }

    const val SUMMARY_NAME_MAX = 80

    // ---- validation ----

    private fun text(out: MutableMap<String, FieldError>, key: String, v: String, max: Int) {
        val t = v.trim()
        if (t.isEmpty()) return
        if (t.length > max) out[key] = FieldError(ErrorKind.TOO_LONG, max = max)
        else if (CONTROL.containsMatchIn(t)) out[key] = FieldError(ErrorKind.INVALID_CHARS)
    }

    private fun items(out: MutableMap<String, FieldError>, key: String, v: List<String>, maxItems: Int, maxLen: Int) {
        if (v.size > maxItems) out[key] = FieldError(ErrorKind.TOO_MANY, max = maxItems)
        else if (v.any { it.trim().length > maxLen }) out[key] = FieldError(ErrorKind.TOO_LONG, max = maxLen)
    }

    private fun count(out: MutableMap<String, FieldError>, key: String, v: Int?, min: Int, max: Int) {
        if (v != null && v !in min..max) out[key] = FieldError(ErrorKind.OUT_OF_RANGE, min, max)
    }

    /** Field key -> first error. Empty map = valid. Keys follow the wire paths (`appearance.height_cm`, `household.pets.0.count`). */
    fun validate(p: UserProfile, nowMs: Long = System.currentTimeMillis()): Map<String, FieldError> {
        val e = LinkedHashMap<String, FieldError>()
        val name = p.fullName.trim()
        if (name.isEmpty()) e["full_name"] = FieldError(ErrorKind.REQUIRED)
        else text(e, "full_name", name, NAME_MAX)
        text(e, "preferred_name", p.preferredName, PREFERRED_MAX)
        p.birthYear?.let { if (it < BIRTH_MIN || it > currentYear(nowMs)) e["birth_year"] = FieldError(ErrorKind.OUT_OF_RANGE, BIRTH_MIN, currentYear(nowMs)) }
        if (p.languages.size > LANGUAGES_MAX) e["languages"] = FieldError(ErrorKind.TOO_MANY, max = LANGUAGES_MAX)
        else if (p.languages.any { !LANG_RE.matches(it.trim()) }) e["languages"] = FieldError(ErrorKind.BAD_LANGUAGE, LANGUAGE_MIN_LEN, LANGUAGE_MAX_LEN)
        if (p.phone.isNotBlank() && !PHONE_RE.matches(p.phone.trim())) e["phone"] = FieldError(ErrorKind.BAD_PHONE)
        count(e, "appearance.height_cm", p.heightCm, HEIGHT_MIN, HEIGHT_MAX)
        text(e, "appearance.hair", p.hair, FREE_MAX)
        text(e, "appearance.clothing", p.clothing, FREE_MAX)
        text(e, "appearance.distinguishing_marks", p.distinguishingMarks, FREE_MAX)
        items(e, "medical.conditions", p.conditions, LIST_MAX, ITEM_MAX)
        items(e, "medical.medications", p.medications, LIST_MAX, ITEM_MAX)
        items(e, "medical.allergies", p.allergies, LIST_MAX, ITEM_MAX)
        text(e, "mobility.notes", p.mobilityNotes, FREE_MAX)
        count(e, "household.people_count", p.peopleCount, 1, PEOPLE_MAX)
        count(e, "household.children", p.children, 0, PEOPLE_MAX)
        count(e, "household.elderly", p.elderly, 0, PEOPLE_MAX)
        val total = p.peopleCount
        if (total != null && "household.people_count" !in e) {
            if ((p.children ?: 0) > total) e["household.children"] = FieldError(ErrorKind.EXCEEDS_PEOPLE, max = total)
            if ((p.elderly ?: 0) > total) e["household.elderly"] = FieldError(ErrorKind.EXCEEDS_PEOPLE, max = total)
        }
        if (p.pets.size > PETS_MAX) e["household.pets"] = FieldError(ErrorKind.TOO_MANY, max = PETS_MAX)
        p.pets.forEachIndexed { i, pet ->
            if (pet.kind.isBlank()) e["household.pets.$i.kind"] = FieldError(ErrorKind.REQUIRED)
            else text(e, "household.pets.$i.kind", pet.kind, PET_KIND_MAX)
            count(e, "household.pets.$i.count", pet.count, 1, 99)
        }
        text(e, "home_address", p.homeAddress, FREE_MAX)
        p.emergencyContact?.let { c ->
            if (c.name.isBlank()) e["emergency_contact.name"] = FieldError(ErrorKind.REQUIRED) else text(e, "emergency_contact.name", c.name, NAME_MAX)
            if (c.relationship.isBlank()) e["emergency_contact.relationship"] = FieldError(ErrorKind.REQUIRED) else text(e, "emergency_contact.relationship", c.relationship, 60)
            if (!PHONE_RE.matches(c.phone.trim())) e["emergency_contact.phone"] = FieldError(ErrorKind.BAD_PHONE)
        }
        text(e, "notes", p.notes, NOTES_MAX)
        return e
    }

    fun isValid(p: UserProfile, nowMs: Long = System.currentTimeMillis()) = validate(p, nowMs).isEmpty()

    /** Splits a comma / semicolon / newline separated field into trimmed, de-duplicated items. */
    fun splitList(s: String): List<String> =
        s.split(',', ';', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
}
