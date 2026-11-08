package com.beacon.mesh.welfare

import com.beacon.mesh.store.CheckinPrompt

/** What the check-in notification shows, independent of Android classes (unit-tested). */
data class WelfareNotificationModel(
    val checkinId: String,
    val notificationId: Int,
    /** Server title or message; null -> the app's default title. */
    val title: String?,
    /** Server message when it differs from the title; null -> the app's default text. */
    val body: String?,
    /** Action buttons, in order: response values ([WelfareResponse]). Max 3. */
    val actions: List<String>,
    /** Deadline for the countdown; null once overdue (no countdown). */
    val deadlineAtMs: Long?,
    /** Past the deadline: "please confirm you're okay, your check-in is overdue"; sticky until answered. Never auto-cancelled. */
    val overdue: Boolean,
    /** Attempt > 1 or tier critical: shown as more urgent. */
    val urgent: Boolean,
) {
    companion object {
        /** Stable notification id per check-in. */
        fun idFor(checkinId: String): Int = 0x4000 or (checkinId.hashCode() and 0x3FFF)

        fun build(p: CheckinPrompt, nowMs: Long): WelfareNotificationModel? {
            if (!p.isPending(nowMs)) return null
            val msg = p.message?.takeIf { it.isNotBlank() }
            val title = p.title?.takeIf { it.isNotBlank() } ?: msg
            val overdue = p.isOverdue(nowMs)
            return WelfareNotificationModel(
                checkinId = p.checkinId, notificationId = idFor(p.checkinId), title = title,
                body = if (p.title.isNullOrBlank()) null else msg,
                actions = WelfareResponse.offered(p.choices).take(3),
                deadlineAtMs = if (overdue) null else p.deadlineAtMs, overdue = overdue,
                urgent = p.attempt > 1 || p.tier == "critical",
            )
        }
    }
}
