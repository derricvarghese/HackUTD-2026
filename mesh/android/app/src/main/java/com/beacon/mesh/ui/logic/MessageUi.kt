package com.beacon.mesh.ui.logic

import com.beacon.mesh.protocol.Category
import com.beacon.mesh.store.StoredMessage
import org.json.JSONObject

enum class MessageStatus {
    /** Own message, no peer in range yet: waiting in the local store. */
    QUEUED,
    /** Own message pushed to nearby phones. */
    RELAYED,
    /** Gateway upload in progress. */
    UPLOADING,
    /** Reached the backend, i.e. responders. */
    DELIVERED,
    /** Received from the mesh and still being passed on. */
    RELAYING,
    /** Received, hop limit reached: kept only, not forwarded. */
    HELD,
    /** The server refused the message for good (bad signature, expired, ...). */
    REJECTED,
    /** Contract SosStatus values reported by the backend for our own message. */
    ASSIGNED,
    EN_ROUTE,
    ON_SCENE,
    RESOLVED,
}

enum class AgeUnit { NOW, MINUTES, HOURS, DAYS }
data class Age(val amount: Int, val unit: AgeUnit)

/** UI-friendly projection of a [StoredMessage]. */
data class MessageItem(
    val id: String,
    val shortId: String,
    val category: Category?,
    val categoryWire: String,
    val kind: String,
    val critical: Boolean,
    val text: String?,
    val people: Int?,
    val lat: Double?,
    val lng: Double?,
    val accuracyM: Double?,
    val createdAt: Long,
    val receivedAt: Long,
    val expiresAt: Long,
    val isOwn: Boolean,
    val uploaded: Boolean,
    val hop: Int,
    val maxHops: Int,
    /** Relay ids from origin to the last transmitter. */
    val path: List<String>,
    val status: MessageStatus,
    /** Peers an own message was handed to when created (0 = queued). */
    val relayedTo: Int,
    val canForward: Boolean,
    /** ETA from the latest status update, minutes. */
    val etaMinutes: Int? = null,
    /** Human text from the backend ("Help is on the way, ETA 40 min"). */
    val statusMessage: String? = null,
    val rejectReason: String? = null,
    /** Welfare check-in state of this own SOS (due countdown / what the person answered), null for none. */
    val welfare: com.beacon.mesh.welfare.WelfareState? = null,
)

object MessageUi {
    fun map(
        m: StoredMessage,
        sentToPeers: Map<String, Int> = emptyMap(),
        uploadingIds: Set<String> = emptySet(),
        checkins: List<com.beacon.mesh.store.CheckinPrompt> = emptyList(),
        nowMs: Long = System.currentTimeMillis(),
    ): MessageItem {
        val payload = m.ownPayload?.let { try { JSONObject(it) } catch (e: Exception) { null } }
        val relayed = sentToPeers[m.id] ?: 0
        val remote = m.remote
        val status = when {
            m.rejectReason != null -> MessageStatus.REJECTED
            remote?.status == "assigned" -> MessageStatus.ASSIGNED
            remote?.status == "en_route" -> MessageStatus.EN_ROUTE
            remote?.status == "on_scene" -> MessageStatus.ON_SCENE
            remote?.status == "resolved" || remote?.status == "closed" -> MessageStatus.RESOLVED
            m.uploaded || remote?.reachedResponders == true -> MessageStatus.DELIVERED
            m.id in uploadingIds -> MessageStatus.UPLOADING
            m.isOwn && relayed > 0 -> MessageStatus.RELAYED
            m.isOwn -> MessageStatus.QUEUED
            m.canForward -> MessageStatus.RELAYING
            else -> MessageStatus.HELD
        }
        // Relays cannot read payloads (encrypted to the backend); only our own messages have details.
        val apiCategory = payload?.optString("category") ?: m.envelope.category
        return MessageItem(
            id = m.id,
            shortId = m.id.take(8),
            category = Category.entries.firstOrNull { it.wire == apiCategory } ?: Category.entries.firstOrNull { it.apiCategory == apiCategory },
            categoryWire = apiCategory ?: m.envelope.kind,
            kind = m.envelope.kind,
            critical = m.envelope.tier == "critical",
            text = payload?.optString("text")?.ifBlank { null },
            people = payload?.let { if (it.has("people_count")) it.optInt("people_count") else null },
            lat = payload?.let { if (it.has("lat")) it.optDouble("lat") else null },
            lng = payload?.let { if (it.has("lng")) it.optDouble("lng") else null },
            accuracyM = payload?.let { if (it.has("accuracy_m")) it.optDouble("accuracy_m") else null },
            createdAt = m.envelope.createdAtMs,
            receivedAt = m.receivedAt,
            expiresAt = m.envelope.expiresAtMs,
            isOwn = m.isOwn,
            uploaded = m.uploaded,
            hop = m.envelope.hopCount,
            maxHops = m.envelope.maxHops,
            path = m.envelope.hopPath,
            status = status,
            relayedTo = relayed,
            canForward = m.canForward,
            etaMinutes = remote?.etaMinutes,
            statusMessage = remote?.message,
            rejectReason = m.rejectReason,
            welfare = if (m.isOwn) com.beacon.mesh.welfare.WelfareState.of(m.id, checkins, nowMs) else null,
        )
    }

    fun age(fromMs: Long, nowMs: Long): Age {
        val s = ((nowMs - fromMs) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> Age(0, AgeUnit.NOW)
            s < 3600 -> Age((s / 60).toInt(), AgeUnit.MINUTES)
            s < 86_400 -> Age((s / 3600).toInt(), AgeUnit.HOURS)
            else -> Age((s / 86_400).toInt(), AgeUnit.DAYS)
        }
    }

    /** Machine part of "hop 2/10 via A1 → B7": the relay ids, origin first. Empty path -> empty list. */
    fun route(item: MessageItem): List<String> = item.path.map { it.uppercase() }

    /** Messages that are still waiting for a gateway (the "held offline" count). */
    fun heldOffline(items: List<MessageItem>): Int = items.count { !it.uploaded && it.rejectReason == null }

    enum class Filter { ALL, MINE, RECEIVED, HELD }

    fun filter(items: List<MessageItem>, f: Filter): List<MessageItem> = when (f) {
        Filter.ALL -> items
        Filter.MINE -> items.filter { it.isOwn }
        Filter.RECEIVED -> items.filter { !it.isOwn }
        Filter.HELD -> items.filter { !it.uploaded && it.rejectReason == null }
    }
}
