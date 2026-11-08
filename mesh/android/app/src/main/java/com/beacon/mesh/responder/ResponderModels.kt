package com.beacon.mesh.responder

import com.beacon.mesh.protocol.Iso
import org.json.JSONArray
import org.json.JSONObject

/** A signed-in dashboard account (`Responder` in the contract). Volunteers are read-only. */
data class ResponderAccount(val id: String, val username: String, val name: String, val role: String) {
    /** The contract lets only responders and admins claim and advance cases. */
    val canAct: Boolean get() = role != ROLE_VOLUNTEER

    companion object {
        const val ROLE_VOLUNTEER = "volunteer"
        fun from(o: JSONObject?): ResponderAccount? {
            if (o == null) return null
            val id = o.str("id") ?: return null
            val username = o.str("username") ?: return null
            return ResponderAccount(id, username, o.str("name") ?: username, o.str("role") ?: "responder")
        }
    }
}

/** What survives a restart: the refresh token (Keystore-encrypted) and who it belongs to. Access tokens stay in memory. */
data class StoredSession(val refreshToken: String, val account: ResponderAccount)

data class HopInfo(val hopCount: Int?, val maxHops: Int?, val path: List<String>) {
    companion object {
        fun from(o: JSONObject?): HopInfo? = o?.let {
            HopInfo(it.intOrNull("hop_count"), it.intOrNull("max_hops"), it.strings("hop_path"))
        }
    }
}

data class PublicProfile(val fullName: String, val preferredName: String?, val ageRange: String?, val flags: List<String>) {
    val displayName: String get() = preferredName?.takeIf { it.isNotBlank() } ?: fullName

    companion object {
        fun from(o: JSONObject?): PublicProfile? {
            if (o == null) return null
            val full = o.str("full_name") ?: return null
            return PublicProfile(full, o.str("preferred_name"), o.str("age_range"), o.strings("vulnerability_flags"))
        }
    }
}

/** One open case from `GET /v1/sos`. Exact coordinates are only present for the assignee or an admin. */
data class ResponderCase(
    val id: String,
    /** Contract category: trapped, injured, need_water_meds, safe, other. */
    val category: String,
    val status: String,
    val score: Int,
    val channel: String,
    val approxLat: Double,
    val approxLng: Double,
    val radiusM: Double,
    val exactLat: Double?,
    val exactLng: Double?,
    val text: String?,
    val peopleCount: Int?,
    val profile: PublicProfile?,
    val silent: Boolean,
    /** connected | lost_contact | unresponsive */
    val contactState: String?,
    val lastHeardAtMs: Long?,
    val updatedAtMs: Long?,
    val hop: HopInfo?,
    val assignmentId: String?,
    val assignmentStatus: String?,
    val assigneeId: String?,
    val assigneeName: String?,
    val mergedInto: String?,
) {
    val hasExactLocation: Boolean get() = exactLat != null && exactLng != null
    val lat: Double get() = exactLat ?: approxLat
    val lng: Double get() = exactLng ?: approxLng
    val displayName: String? get() = profile?.displayName?.takeIf { it.isNotBlank() }
    val unresponsive: Boolean get() = contactState == "unresponsive"
    /** Draws the attention ring on the map: gone silent, or alive but not answering welfare check-ins. */
    val needsAttention: Boolean get() = silent || unresponsive
    val isOpen: Boolean get() = status in OPEN_STATUSES && mergedInto == null

    fun isMine(account: ResponderAccount?): Boolean =
        account != null && assigneeId == account.id && assignmentStatus !in INACTIVE_ASSIGNMENT

    /** Somebody else holds an active claim. */
    fun claimedByOther(account: ResponderAccount?): Boolean =
        assigneeId != null && !isMine(account) && assignmentStatus !in INACTIVE_ASSIGNMENT_OTHER

    companion object {
        val OPEN_STATUSES = setOf("reported", "assigned", "en_route", "on_scene")
        private val INACTIVE_ASSIGNMENT = setOf("released", "cancelled", "resolved")
        private val INACTIVE_ASSIGNMENT_OTHER = setOf("released", "cancelled")

        /** Returns null when a required field is missing; unknown fields are ignored. */
        fun from(j: JSONObject): ResponderCase? {
            val id = j.str("id") ?: return null
            val approx = j.optJSONObject("approx_location") ?: return null
            if (!approx.has("lat") || !approx.has("lng")) return null
            val loc = j.optJSONObject("location")
            val a = j.optJSONObject("assignment")
            return ResponderCase(
                id = id,
                category = j.str("category") ?: "other",
                status = j.str("status") ?: "reported",
                score = j.intOrNull("score") ?: 0,
                channel = j.str("channel") ?: "app",
                approxLat = approx.getDouble("lat"),
                approxLng = approx.getDouble("lng"),
                radiusM = approx.optDouble("radius_m", 1000.0),
                exactLat = loc?.takeIf { it.has("lat") && it.has("lng") }?.getDouble("lat"),
                exactLng = loc?.takeIf { it.has("lat") && it.has("lng") }?.getDouble("lng"),
                text = j.str("text"),
                peopleCount = j.intOrNull("people_count"),
                profile = PublicProfile.from(j.optJSONObject("profile")),
                silent = j.optBoolean("silent", false),
                contactState = j.str("contact_state"),
                lastHeardAtMs = j.str("last_heard_at")?.let(Iso::parse),
                updatedAtMs = j.str("updated_at")?.let(Iso::parse),
                hop = HopInfo.from(j.optJSONObject("hop")),
                assignmentId = a?.str("id"),
                assignmentStatus = a?.str("status"),
                assigneeId = a?.str("responder_id"),
                assigneeName = a?.str("responder_name"),
                mergedInto = j.str("merged_into"),
            )
        }

        fun parseList(body: String): List<ResponderCase> {
            val arr = JSONObject(body).optJSONArray("data") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(::from) }
        }
    }
}

data class TriageReason(val source: String, val text: String, val weight: Int?)
data class CheckinInfo(val id: String, val sentAtMs: Long?, val respondedAtMs: Long?, val response: String?, val missed: Boolean, val attempt: Int?)
data class CaseEvent(val type: String, val actorKind: String?, val atMs: Long?)
data class CaseNote(val text: String, val atMs: Long?)

/** `ProfileFull`: present only when the API says the viewer is the active assignee or an admin. */
data class FullProfile(
    val fullName: String?,
    val phone: String?,
    val conditions: List<String>,
    val medications: List<String>,
    val allergies: List<String>,
    val bloodType: String?,
    val mobilityNeeds: List<String>,
    val mobilityNotes: String?,
    val contactName: String?,
    val contactPhone: String?,
    val contactRelationship: String?,
) {
    companion object {
        fun from(o: JSONObject?): FullProfile? {
            if (o == null) return null
            val med = o.optJSONObject("medical")
            val mob = o.optJSONObject("mobility")
            val ec = o.optJSONObject("emergency_contact")
            return FullProfile(
                o.str("full_name"), o.str("phone"),
                med.strings("conditions"), med.strings("medications"), med.strings("allergies"), med?.str("blood_type"),
                mob.strings("needs"), mob?.str("notes"),
                ec?.str("name"), ec?.str("phone"), ec?.str("relationship"),
            )
        }
    }
}

/** `SosDetail`: the case plus triage reasoning, check-ins, event trail and (assignee only) the full profile. */
data class CaseDetail(
    val case: ResponderCase,
    val summary: String?,
    val confidence: String?,
    val reasons: List<TriageReason>,
    val checkins: List<CheckinInfo>,
    val events: List<CaseEvent>,
    val notes: List<CaseNote>,
    val profileFull: FullProfile?,
    val welfareMissed: Int,
) {
    companion object {
        fun parse(body: String): CaseDetail? {
            val j = JSONObject(body)
            val c = ResponderCase.from(j) ?: return null
            val triage = j.optJSONObject("triage")
            val reasonsArr = triage?.optJSONArray("reasons") ?: j.optJSONArray("reasons")
            return CaseDetail(
                case = c,
                summary = triage?.str("summary"),
                confidence = triage?.str("confidence") ?: j.str("confidence"),
                reasons = reasonsArr.objects().mapNotNull { r ->
                    TriageReason(r.str("source") ?: "rule", r.str("text") ?: return@mapNotNull null, r.intOrNull("weight"))
                },
                checkins = j.optJSONArray("checkins").objects().mapNotNull { k ->
                    CheckinInfo(
                        k.str("id") ?: return@mapNotNull null, k.str("sent_at")?.let(Iso::parse),
                        k.str("responded_at")?.let(Iso::parse), k.str("response"), k.optBoolean("missed", false), k.intOrNull("attempt"),
                    )
                },
                events = j.optJSONArray("events").objects().mapNotNull { e ->
                    CaseEvent(e.str("type") ?: return@mapNotNull null, e.optJSONObject("actor")?.str("kind"), e.str("at")?.let(Iso::parse))
                },
                notes = j.optJSONArray("notes").objects().mapNotNull { n ->
                    CaseNote(n.str("text") ?: return@mapNotNull null, n.str("created_at")?.let(Iso::parse))
                },
                profileFull = FullProfile.from(j.optJSONObject("profile_full")),
                welfareMissed = j.intOrNull("welfare_missed") ?: 0,
            )
        }
    }
}

/** How a pin or list badge is coloured. Derived from the score (the triage tier thresholds), `safe` from the category. */
enum class PinTone { CRITICAL, HIGH, NORMAL, SAFE }

object CaseRules {
    const val CRITICAL_SCORE = 70
    const val HIGH_SCORE = 40

    fun tone(category: String, score: Int): PinTone = when {
        category == "safe" -> PinTone.SAFE
        score >= CRITICAL_SCORE -> PinTone.CRITICAL
        score >= HIGH_SCORE -> PinTone.HIGH
        else -> PinTone.NORMAL
    }

    fun tone(c: ResponderCase): PinTone = tone(c.category, c.score)

    /** Radius drawn on the map: a small dot when the exact spot is known, else the ~1 km uncertainty circle. */
    fun mapRadiusM(c: ResponderCase): Double = if (c.hasExactLocation) 40.0 else maxOf(c.radiusM, 100.0)

    /** Mine first, then highest score; the server's order (silent first, oldest first) breaks ties. */
    fun ranked(cases: Collection<ResponderCase>, account: ResponderAccount?): List<ResponderCase> =
        cases.sortedWith(compareByDescending<ResponderCase> { it.isMine(account) }.thenByDescending { it.score })

    fun applyFilter(cases: List<ResponderCase>, f: CaseFilter, account: ResponderAccount?): List<ResponderCase> = when (f) {
        CaseFilter.ALL -> cases
        CaseFilter.CRITICAL -> cases.filter { it.score >= CRITICAL_SCORE }
        CaseFilter.SILENT -> cases.filter { it.needsAttention }
        CaseFilter.MINE -> cases.filter { it.isMine(account) }
        CaseFilter.UNCLAIMED -> cases.filter { it.status == "reported" }
    }

    /** Folds a catch-up page into the held cases: finished or merged cases drop out, the rest replace by id. */
    fun merge(current: Map<String, ResponderCase>, incoming: List<ResponderCase>): Map<String, ResponderCase> {
        val out = LinkedHashMap(current)
        for (c in incoming) if (c.isOpen) out[c.id] = c else out.remove(c.id)
        return out
    }
}

enum class CaseFilter { ALL, CRITICAL, SILENT, MINE, UNCLAIMED }

/** The resolve outcomes the contract accepts from a responder (`self_resolved` is server-set). */
val ResolveOutcomes = listOf("rescued", "safe_on_arrival", "referred", "unreachable", "false_alarm")

// ---- tiny org.json helpers (null-safe, "null" aware) ----

internal fun JSONObject.str(k: String): String? = if (has(k) && !isNull(k)) optString(k).takeIf { it.isNotEmpty() } else null
internal fun JSONObject.intOrNull(k: String): Int? = if (has(k) && !isNull(k)) optInt(k) else null
internal fun JSONObject?.strings(k: String): List<String> = this?.optJSONArray(k).strings()
internal fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { if (isNull(it)) null else optString(it) }
internal fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
