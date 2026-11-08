package com.beacon.mesh.welfare

import com.beacon.mesh.store.CheckinPrompt

/** What the Home / Messages cards say about the welfare check-ins of one own SOS. */
sealed interface WelfareState {
    data class Due(val deadlineAtMs: Long) : WelfareState
    /** Past the deadline, still unanswered: "please confirm you're okay". */
    data object Overdue : WelfareState
    /** "You said you still need help". */
    data object StillHere : WelfareState
    data object UrgentHelp : WelfareState
    /** "Marked as resolved by you". */
    data object ResolvedByYou : WelfareState

    companion object {
        fun of(sosId: String, prompts: List<CheckinPrompt>, nowMs: Long): WelfareState? {
            val mine = prompts.filter { it.sosId == sosId }
            mine.filter { it.isPending(nowMs) }.minByOrNull { it.deadlineAtMs ?: Long.MAX_VALUE }?.let {
                return if (it.isOverdue(nowMs)) Overdue else Due(it.deadlineAtMs ?: nowMs)
            }
            return when (mine.filter { it.response in WelfareResponse.ALL }.maxByOrNull { it.answeredAtMs ?: 0 }?.response) {
                WelfareResponse.STILL_HERE -> StillHere
                WelfareResponse.NEED_URGENT_HELP -> UrgentHelp
                WelfareResponse.NO_LONGER_NEED_HELP -> ResolvedByYou
                else -> null
            }
        }
    }
}
