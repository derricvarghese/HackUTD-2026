package com.beacon.mesh.welfare

import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.MessageStore

/** Check-in notifications. Faked in tests. */
interface WelfareNotifier {
    /**
     * Post or refresh THE notification of this check-in (one per check-in id, updated in place, never stacked): action buttons,
     * a countdown before the deadline, an "overdue" text after it. [alert] = make sound / vibration (again) for this update.
     */
    fun show(p: CheckinPrompt, nowMs: Long, alert: Boolean = false)
    /** Remove the notification of this check-in. */
    fun cancel(checkinId: String)
}

/**
 * Owns the lifecycle of welfare check-ins on this phone: de-duplicates what the three channels deliver, persists it,
 * posts the notification and clears everything on an answer. Thread-safe (every public call is synchronized); the notifier is
 * called inside the lock and must be quick.
 */
class WelfareManager(
    private val store: MessageStore,
    private val notifier: WelfareNotifier,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
    private val onChange: () -> Unit = {},
    /** `checkin_reminder_seconds` in ms: how often an overdue check-in alerts again. */
    private val reminderIntervalMs: () -> Long = { 300_000L },
) {
    /** All stored check-ins, oldest first (answered ones are kept for 24 h for the status lines). */
    @Synchronized fun all(): List<CheckinPrompt> = store.prompts()

    @Synchronized fun pending(): List<CheckinPrompt> = store.prompts().filter { it.isPending(now()) }.sortedBy { it.deadlineAtMs }

    @Synchronized fun find(id: String): CheckinPrompt? = store.prompts().firstOrNull { it.checkinId == id }

    /**
     * Takes check-ins from any channel (mesh `checkin_request`, heartbeat `pending_checkins`, `GET /checkins/pending`).
     * Identity is the `checkin_id`: a repeated delivery of a known, unanswered check-in (a server reminder) UPDATES its single
     * notification in place instead of creating another one, and alerts again when the delivery carries a higher reminder count or
     * the reminder cadence has elapsed. Answered / cleared check-ins and ones long past their deadline are ignored.
     * @return how many check-ins were new.
     */
    @Synchronized fun ingest(items: List<CheckinPrompt>): Int {
        val t = now()
        val stored = store.prompts().associateBy { it.checkinId }.toMutableMap()
        var added = 0
        var changed = false
        for (p in items) {
            if (p.response != null || !p.isPending(t)) continue
            val old = stored[p.checkinId]
            if (old == null) {
                val fresh = p.copy(receivedAt = t, lastNotifiedAtMs = t)
                store.savePrompt(fresh); stored[p.checkinId] = fresh
                log("Check-in ${p.checkinId.take(8)} received (attempt ${p.attempt})")
                notifier.show(fresh, t, alert = true)
                added++; changed = true
            } else if (old.response == null) {
                val reminded = p.reminderCount > old.reminderCount
                val cadence = old.isOverdue(t) && t - old.lastNotifiedAtMs >= reminderIntervalMs()
                val alert = reminded || cadence
                val merged = old.copy(
                    title = p.title ?: old.title, message = p.message ?: old.message, choices = p.choices, attempt = maxOf(old.attempt, p.attempt),
                    tier = p.tier ?: old.tier, reminderCount = maxOf(old.reminderCount, p.reminderCount),
                    lastNotifiedAtMs = if (alert) t else old.lastNotifiedAtMs,
                )
                if (merged != old) { store.savePrompt(merged); stored[p.checkinId] = merged; changed = true }
                if (alert) { log("Check-in ${p.checkinId.take(8)} reminder"); notifier.show(merged, t, alert = true) }
            }
        }
        if (changed) onChange()
        return added
    }

    /**
     * Driven by the service tick: an unanswered check-in that has just passed its deadline switches to its overdue text and alerts, and
     * an overdue one alerts again every reminder interval even when no server message arrives. Never creates a second notification.
     */
    @Synchronized fun tickReminders() {
        val t = now()
        var changed = false
        for (p in store.prompts()) {
            if (!p.isOverdue(t)) continue
            val firstOverdue = p.lastNotifiedAtMs < (p.deadlineAtMs ?: 0)
            if (firstOverdue || t - p.lastNotifiedAtMs >= reminderIntervalMs()) {
                val next = p.copy(lastNotifiedAtMs = t)
                store.savePrompt(next)
                notifier.show(next, t, alert = true)
                changed = true
            }
        }
        if (changed) onChange()
    }

    /** After a successful `GET /checkins/pending`: unanswered local check-ins the server no longer lists are over. */
    @Synchronized fun reconcile(serverPendingIds: Set<String>) {
        val t = now()
        var changed = false
        for (p in store.prompts()) {
            if (p.response == null && !p.isTest && p.checkinId !in serverPendingIds && t - p.receivedAt > RECONCILE_GRACE_MS) {
                finish(p, WelfareResponse.SERVER_CLEARED)
                changed = true
            }
        }
        if (changed) onChange()
    }

    /** The person answered (or "stop"): mark locally right away and remove the notification. Null when unknown / already answered. */
    @Synchronized fun answer(id: String, response: String): CheckinPrompt? {
        val p = find(id) ?: return null
        if (p.response != null) return null
        val t = now()
        val done = p.copy(response = response, answeredAtMs = t, nextReplyAtMs = 0)
        store.savePrompt(done)
        notifier.cancel(id)
        log("Check-in ${id.take(8)} answered locally")
        onChange()
        return done
    }

    /** The case was resolved (status update, own answer, profile deleted): no more urgency for [sosId]. */
    @Synchronized fun cancelForSos(sosId: String) {
        var changed = false
        for (p in store.prompts()) if (p.sosId == sosId && p.response == null) { finish(p, WelfareResponse.CANCELLED); changed = true }
        if (changed) onChange()
    }

    /** Cancels every open check-in (profile / consent deleted, identity reset). */
    @Synchronized fun cancelAll() {
        var changed = false
        for (p in store.prompts()) if (p.response == null) { finish(p, WelfareResponse.CANCELLED); changed = true }
        if (changed) onChange()
    }

    /**
     * App start, BOOT_COMPLETED, package update: re-post the notification of every open check-in from the database (a reboot or
     * "clear all" removes them) and drop the ones past their deadline.
     * @return how many are still open.
     */
    @Synchronized fun restore(): Int {
        val t = now()
        var n = 0
        for (p in store.prompts()) {
            if (!p.isPending(t)) { notifier.cancel(p.checkinId); continue }
            notifier.show(p, t, alert = false)
            n++
        }
        return n
    }

    /** Answered check-ins whose reply still has to reach the server, and whose retry time has come. */
    @Synchronized fun dueReplies(): List<CheckinPrompt> {
        val t = now()
        return store.prompts().filter {
            it.response != null && it.response in WelfareResponse.ALL && !it.delivered && !it.isTest &&
                (it.deadlineAtMs == null || t < it.deadlineAtMs + CheckinPrompt.STALE_AFTER_DEADLINE_MS) && it.nextReplyAtMs <= t
        }
    }

    @Synchronized fun update(p: CheckinPrompt) { store.savePrompt(p); onChange() }

    private fun finish(p: CheckinPrompt, marker: String) {
        store.savePrompt(p.copy(response = marker, answeredAtMs = now(), delivered = true))
        notifier.cancel(p.checkinId)
    }

    companion object {
        /** All-zero SOS id marks the local "Test welfare check-in": it never touches the network. */
        const val TEST_SOS_ID = "00000000-0000-0000-0000-000000000000"
        /** A fresh check-in is not cleared by a poll that raced with its delivery. */
        const val RECONCILE_GRACE_MS = 30_000L

        fun testPrompt(nowMs: Long, id: String = com.beacon.mesh.protocol.Uuid7.generate(nowMs)) = CheckinPrompt(
            checkinId = id, sosId = TEST_SOS_ID, message = null, deadlineAtMs = nowMs + 20_000, receivedAt = nowMs, response = null,
            title = null, choices = WelfareResponse.ALL, attempt = 1, tier = null, sentAtMs = nowMs,
        )
    }
}
