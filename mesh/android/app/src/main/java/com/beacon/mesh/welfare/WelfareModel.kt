package com.beacon.mesh.welfare

import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.store.CheckinPrompt
import org.json.JSONArray
import org.json.JSONObject

/** The contract's `CheckinResponse` values the app offers (legacy `ok`/`need_help`/`other` are never sent). */
object WelfareResponse {
    const val STILL_HERE = "still_here"
    const val NO_LONGER_NEED_HELP = "no_longer_need_help"
    const val NEED_URGENT_HELP = "need_urgent_help"
    val ALL = listOf(STILL_HERE, NO_LONGER_NEED_HELP, NEED_URGENT_HELP)

    /** Marker stored for a check-in the server no longer lists (answered elsewhere, cancelled, missed). Never sent. */
    const val SERVER_CLEARED = "server_cleared"
    /** Marker stored when the case was resolved or the profile / consent was deleted. Never sent. */
    const val CANCELLED = "cancelled"

    fun isKnown(s: String) = s in ALL

    /** Offered replies: the server's `choices` restricted to the three we know, in canonical order; empty -> all three. */
    fun offered(choices: List<String>): List<String> = ALL.filter { it in choices }.ifEmpty { ALL }
}

/** Parses the three delivery channels of a welfare check-in into [CheckinPrompt]s. Never throws. */
object CheckinParser {
    /** Default `checkin_window_seconds` when a message carries no deadline. */
    const val DEFAULT_WINDOW_MS = 5 * 60_000L

    /** A `Checkin` object (REST: `pending_checkins`, `GET /checkins/pending`). Answered ones return null; overdue (missed) ones are kept. */
    fun fromRest(o: JSONObject, nowMs: Long): CheckinPrompt? = try {
        if (o.has("kind") && !o.isNull("kind") && o.getString("kind") != "welfare") null
        // A missed check-in is OVERDUE, not over: it stays the active one until answered. Only answered ones are skipped.
        else if (!o.isNull("responded_at") && o.has("responded_at")) null
        else {
            val sent = Iso.parse(o.optString("sent_at", "")) ?: nowMs
            val deadline = Iso.parse(o.optString("deadline_at", "")) ?: (sent + DEFAULT_WINDOW_MS)
            build(
                id = o.getString("id"), sosId = o.getString("sos_id"), title = o.str("title"), message = o.str("message"),
                choices = o.choices(), attempt = o.optInt("attempt", 1).coerceAtLeast(1), tier = o.str("tier"),
                sent = sent, deadline = deadline, nowMs = nowMs, reminders = o.optInt("reminder_count", 0).coerceAtLeast(0),
            )
        }
    } catch (e: Exception) {
        null
    }

    fun fromRestArray(a: JSONArray?, nowMs: Long): List<CheckinPrompt> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let { o -> fromRest(o, nowMs) } }

    /** A verified `BackendMessage kind=checkin_request`. */
    fun fromBackend(bm: BackendMessage, nowMs: Long): CheckinPrompt? {
        val id = bm.checkinId ?: return null
        val b = bm.body
        val sent = Iso.parse(bm.createdAt) ?: nowMs
        val deadline = Iso.parse(b.str("deadline_at") ?: "") ?: (sent + DEFAULT_WINDOW_MS)
        return build(
            id = id, sosId = bm.sosId, title = b.str("title"), message = b.str("message"), choices = b.choices(),
            attempt = b.optInt("attempt", 1).coerceAtLeast(1), tier = b.str("tier"), sent = sent,
            deadline = deadline, nowMs = nowMs, reminders = b.optInt("reminder", 0).coerceAtLeast(0),
        )
    }

    private fun build(
        id: String, sosId: String, title: String?, message: String?, choices: List<String>, attempt: Int, tier: String?,
        sent: Long, deadline: Long, nowMs: Long, reminders: Int,
    ) = CheckinPrompt(
        checkinId = id, sosId = sosId, message = message, deadlineAtMs = deadline, receivedAt = nowMs, response = null,
        title = title, choices = WelfareResponse.offered(choices), attempt = attempt, tier = tier, sentAtMs = sent,
        reminderCount = reminders,
    )

    private fun JSONObject.str(k: String): String? = if (has(k) && !isNull(k)) optString(k).ifBlank { null } else null
    private fun JSONObject.choices(): List<String> {
        val a = optJSONArray("choices") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optString(it).ifBlank { null } }
    }
}

/** "mm:ss" for the countdown (hours roll into minutes: 75 min -> "75:00"). Negative -> "00:00". */
object Countdown {
    fun format(ms: Long): String {
        val s = (ms.coerceAtLeast(0) + 999) / 1000
        return "%02d:%02d".format(s / 60, s % 60)
    }
}

/** Retry schedule for an unsent reply. */
object ReplyBackoff {
    fun delayMs(attempt: Int, retryAfterSeconds: Int? = null): Long {
        val base = minOf(5_000L shl attempt.coerceIn(0, 5), 120_000L)
        return maxOf(base, (retryAfterSeconds ?: 0) * 1000L)
    }
}
