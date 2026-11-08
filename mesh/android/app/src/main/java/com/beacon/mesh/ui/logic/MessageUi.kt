package com.beacon.mesh.ui.logic

import com.beacon.mesh.protocol.Category
import com.beacon.mesh.store.StoredMessage

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
)

object MessageUi {
    fun map(
        m: StoredMessage,
        sentToPeers: Map<String, Int> = emptyMap(),
        uploadingIds: Set<String> = emptySet(),
    ): MessageItem {
        val body = m.header.body
        val relayed = sentToPeers[m.id] ?: 0
        val status = when {
            m.uploaded -> MessageStatus.DELIVERED
            m.id in uploadingIds -> MessageStatus.UPLOADING
            m.isOwn && relayed > 0 -> MessageStatus.RELAYED
            m.isOwn -> MessageStatus.QUEUED
            m.canForward -> MessageStatus.RELAYING
            else -> MessageStatus.HELD
        }
        return MessageItem(
            id = m.id,
            shortId = m.id.take(8),
            category = Category.entries.firstOrNull { it.wire == body?.category },
            categoryWire = body?.category ?: m.header.kind,
            kind = m.header.kind,
            critical = m.header.pri == "critical",
            text = body?.text,
            people = body?.people,
            lat = body?.lat,
            lng = body?.lng,
            accuracyM = body?.acc,
            createdAt = m.header.createdAt,
            receivedAt = m.receivedAt,
            expiresAt = m.header.expiresAt,
            isOwn = m.isOwn,
            uploaded = m.uploaded,
            hop = m.envelope.hop,
            maxHops = m.header.maxHops,
            path = m.envelope.path,
            status = status,
            relayedTo = relayed,
            canForward = m.canForward,
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
    fun heldOffline(items: List<MessageItem>): Int = items.count { !it.uploaded }

    enum class Filter { ALL, MINE, RECEIVED, HELD }

    fun filter(items: List<MessageItem>, f: Filter): List<MessageItem> = when (f) {
        Filter.ALL -> items
        Filter.MINE -> items.filter { it.isOwn }
        Filter.RECEIVED -> items.filter { !it.isOwn }
        Filter.HELD -> items.filter { !it.uploaded }
    }
}
