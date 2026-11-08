package com.beacon.mesh.welfare

import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.store.CheckinPrompt

enum class DeliveryOutcome {
    /** The server has the answer (200). */
    DELIVERED,
    /** 409 (already answered / expired) or 404: nothing more to send; cleared locally. */
    CLEARED,
    /** Offline: a `checkin_reply` mesh envelope was created for a gateway to carry. */
    MESH_SENT,
    /** Network / 5xx / 429: will retry with backoff until the deadline. */
    RETRY_LATER,
    /** Rejected for good (4xx other than 409/404). */
    REJECTED,
    /** The local test check-in or a no-op. */
    LOCAL_ONLY,
}

/** Turns a mesh reply into an envelope. Returns true when one was created. */
fun interface MeshReplySender {
    fun send(p: CheckinPrompt, response: String): Boolean
}

/**
 * Delivery of a check-in answer. The blocking network call (`PATCH /v1/checkins/{id}`) is made by the caller on an IO thread;
 * [apply] then records the result and falls back to the mesh. Call [apply] on the main thread (it creates mesh envelopes).
 */
class WelfareReplier(
    private val manager: WelfareManager,
    private val mesh: MeshReplySender,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    /** @param online the phone could reach the server; @param remote the PATCH result when it was tried, else null. */
    fun apply(p: CheckinPrompt, online: Boolean, remote: ApiResult<Unit>?): DeliveryOutcome {
        val response = p.response ?: return DeliveryOutcome.LOCAL_ONLY
        if (p.isTest || response !in WelfareResponse.ALL) {
            manager.update(p.copy(delivered = true))
            return DeliveryOutcome.LOCAL_ONLY
        }
        if (!online || remote == null) return viaMesh(p, response)
        return when (remote) {
            is ApiResult.Ok -> done(p, DeliveryOutcome.DELIVERED)
            is ApiResult.Failure -> when {
                remote.code == 409 || remote.code == 404 -> done(p, DeliveryOutcome.CLEARED)
                remote.code != null && remote.code in 400..499 && remote.code != 429 && remote.code != 401 -> {
                    log("Check-in reply rejected (${remote.code})")
                    done(p, DeliveryOutcome.REJECTED)
                }
                else -> {
                    val attempts = p.replyAttempts + 1
                    val next = now() + ReplyBackoff.delayMs(attempts, remote.retryAfterSeconds)
                    manager.update(p.copy(replyAttempts = attempts, nextReplyAtMs = next))
                    // The server may be unreachable although the network looks fine: let a gateway carry it too.
                    if (!p.meshReplied) viaMesh(manager.find(p.checkinId) ?: p, response)
                    DeliveryOutcome.RETRY_LATER
                }
            }
        }
    }

    private fun viaMesh(p: CheckinPrompt, response: String): DeliveryOutcome {
        if (p.meshReplied) return DeliveryOutcome.MESH_SENT
        val sent = mesh.send(p, response)
        if (sent) manager.update((manager.find(p.checkinId) ?: p).copy(meshReplied = true))
        return if (sent) DeliveryOutcome.MESH_SENT else DeliveryOutcome.RETRY_LATER
    }

    private fun done(p: CheckinPrompt, o: DeliveryOutcome): DeliveryOutcome {
        manager.update((manager.find(p.checkinId) ?: p).copy(delivered = true))
        return o
    }
}
