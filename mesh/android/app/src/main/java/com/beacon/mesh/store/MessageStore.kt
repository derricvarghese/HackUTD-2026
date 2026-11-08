package com.beacon.mesh.store

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.welfare.WelfareManager
import com.beacon.mesh.welfare.WelfareResponse
import org.json.JSONObject

/** What the backend told us about one of our own messages (from a verified BackendMessage or GET /sos/{id}/status). */
data class RemoteStatus(
    /** Contract SosStatus (reported, assigned, en_route, on_scene, resolved, ...) or null if only "delivered" is known. */
    val status: String?,
    val reachedResponders: Boolean,
    val etaMinutes: Int?,
    val message: String?,
    val updatedAtMs: Long,
) {
    fun toJson(): String = JSONObject().put("status", status ?: JSONObject.NULL).put("reached", reachedResponders)
        .put("eta", etaMinutes ?: JSONObject.NULL).put("message", message ?: JSONObject.NULL).put("at", updatedAtMs).toString()

    companion object {
        fun fromJson(s: String?): RemoteStatus? = try {
            s?.let {
                val o = JSONObject(it)
                RemoteStatus(
                    status = if (o.isNull("status")) null else o.getString("status"),
                    reachedResponders = o.optBoolean("reached", false),
                    etaMinutes = if (o.isNull("eta")) null else o.getInt("eta"),
                    message = if (o.isNull("message")) null else o.getString("message"),
                    updatedAtMs = o.optLong("at", 0),
                )
            }
        } catch (e: Exception) {
            null
        }
    }
}

data class StoredMessage(
    val id: String,
    /** Envelope as held (hop_count 0 / empty path for our own messages). */
    val envelope: MeshEnvelope,
    val receivedAt: Long,
    val uploaded: Boolean,
    val isOwn: Boolean,
    val fromPeer: String?,
    /** Terminal server rejection (bad_signature, expired, ...); such messages are not uploaded again. */
    val rejectReason: String? = null,
    /** Plaintext MeshPayload JSON, kept ONLY for our own messages so the UI can show them. Never sent in clear. */
    val ownPayload: String? = null,
    val remote: RemoteStatus? = null,
    /** False when no sender key was available to check the signature here (the server will check it). */
    val verified: Boolean = true,
) {
    val canForward: Boolean get() = envelope.canForward
    val expiresAtMs: Long get() = envelope.expiresAtMs
    val isHeartbeat: Boolean get() = envelope.kind == "heartbeat"
}

/** A backend-signed item held for relaying: a BackendMessage ("bm") or DeliveredReceipt ("rcpt"). */
data class InboxItem(
    val key: String,
    val type: String,
    val json: String,
    val receivedAt: Long,
    val expiresAt: Long,
    /** Already applied to the UI/state (or deliberately ignored). */
    val acted: Boolean,
) {
    val canForward: Boolean
        get() = JSONObject(json).let { it.optInt("hop_count", 0) < it.optInt("max_hops", 0) }
}

/**
 * A welfare check-in the backend asked this phone to answer (openapi `Checkin` / `BackendMessage kind=checkin_request`).
 * Persisted so the notification and the pending reply survive process death and reboot.
 */
data class CheckinPrompt(
    val checkinId: String,
    val sosId: String,
    /** Server text (`Checkin.message` / `body.message`), shown as the notification text. */
    val message: String?,
    /** Answer by this time; after it the server marks the check-in missed. */
    val deadlineAtMs: Long?,
    val receivedAt: Long,
    /** null while unanswered, else still_here / no_longer_need_help / need_urgent_help (or "server_cleared" / "cancelled"). */
    val response: String?,
    val title: String? = null,
    /** Replies to the message, in the order the server gave them. */
    val choices: List<String> = WelfareResponse.ALL,
    val attempt: Int = 1,
    val tier: String? = null,
    val sentAtMs: Long = receivedAt,
    val answeredAtMs: Long? = null,
    /** The answer reached the server (PATCH 200, 409 or 404). */
    val delivered: Boolean = false,
    val replyAttempts: Int = 0,
    val nextReplyAtMs: Long = 0,
    /** A `checkin_reply` mesh envelope was created for this answer. */
    val meshReplied: Boolean = false,
    /** How many times the server re-delivered this same check-in after the deadline (0 = original delivery only). */
    val reminderCount: Int = 0,
    /** When the notification last alerted (sound / vibration); drives the local reminder cadence. */
    val lastNotifiedAtMs: Long = 0,
) {
    val isTest: Boolean get() = sosId == WelfareManager.TEST_SOS_ID
    val answered: Boolean get() = response != null
    /**
     * Still waiting for an answer. A check-in that passed its deadline stays the ONE active check-in of its case (overdue) until it is
     * answered, cleared by the server or the case resolves; only a day-old one is given up on.
     */
    fun isPending(nowMs: Long): Boolean = response == null && (deadlineAtMs == null || nowMs < deadlineAtMs + STALE_AFTER_DEADLINE_MS)

    /** Past `deadline_at` and unanswered: the notification says "overdue" and repeats instead of counting down. */
    fun isOverdue(nowMs: Long): Boolean = isPending(nowMs) && deadlineAtMs != null && nowMs >= deadlineAtMs

    companion object { const val STALE_AFTER_DEADLINE_MS = 24L * 3_600_000 }
}

interface MessageStore {
    fun contains(id: String): Boolean
    fun save(message: StoredMessage)
    fun all(): List<StoredMessage>
    fun markUploaded(id: String)
    fun markRejected(id: String, reason: String)
    fun updateRemote(id: String, status: RemoteStatus)
    fun deleteExpired(nowMs: Long)

    fun containsInbox(key: String): Boolean
    fun saveInbox(item: InboxItem)
    fun inbox(): List<InboxItem>
    fun markInboxActed(key: String)

    fun savePrompt(p: CheckinPrompt)
    fun prompts(): List<CheckinPrompt>
    fun answerPrompt(checkinId: String, response: String)
    fun deletePrompt(checkinId: String)
}

class InMemoryMessageStore : MessageStore {
    private val messages = LinkedHashMap<String, StoredMessage>()
    private val items = LinkedHashMap<String, InboxItem>()
    private val checkins = LinkedHashMap<String, CheckinPrompt>()
    override fun contains(id: String) = messages.containsKey(id)
    override fun save(message: StoredMessage) { messages[message.id] = message }
    override fun all() = messages.values.sortedBy { it.receivedAt }
    override fun markUploaded(id: String) { messages[id]?.let { messages[id] = it.copy(uploaded = true, rejectReason = null) } }
    override fun markRejected(id: String, reason: String) { messages[id]?.let { messages[id] = it.copy(rejectReason = reason) } }
    override fun updateRemote(id: String, status: RemoteStatus) { messages[id]?.let { messages[id] = it.copy(remote = status) } }
    override fun deleteExpired(nowMs: Long) {
        messages.values.removeAll { it.expiresAtMs < nowMs }
        items.values.removeAll { it.expiresAt < nowMs }
        checkins.values.removeAll { (it.deadlineAtMs ?: it.receivedAt) < nowMs - PROMPT_KEEP_MS }
    }

    override fun containsInbox(key: String) = items.containsKey(key)
    override fun saveInbox(item: InboxItem) { items[item.key] = item }
    override fun inbox() = items.values.sortedBy { it.receivedAt }
    override fun markInboxActed(key: String) { items[key]?.let { items[key] = it.copy(acted = true) } }

    override fun savePrompt(p: CheckinPrompt) { checkins[p.checkinId] = p }
    override fun prompts() = checkins.values.sortedBy { it.receivedAt }
    override fun answerPrompt(checkinId: String, response: String) {
        checkins[checkinId]?.let { checkins[checkinId] = it.copy(response = response) }
    }
    override fun deletePrompt(checkinId: String) { checkins.remove(checkinId) }
}

/**
 * SQLite-backed store so held messages survive the app being killed.
 * Schema v2 (contract envelopes). Upgrading from v1 (PROTOCOL v1 rows) drops the old demo data: those envelopes are
 * not valid contract messages and could never be uploaded.
 */
class SqliteMessageStore(context: Context) :
    SQLiteOpenHelper(context, "beacon_mesh.db", null, 3), MessageStore {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                envelope TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                uploaded INTEGER NOT NULL DEFAULT 0,
                reject_reason TEXT,
                is_own INTEGER NOT NULL DEFAULT 0,
                from_peer TEXT,
                own_payload TEXT,
                remote TEXT,
                verified INTEGER NOT NULL DEFAULT 1
            )"""
        )
        db.execSQL(
            """CREATE TABLE inbox (
                key TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                json TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                acted INTEGER NOT NULL DEFAULT 0
            )"""
        )
        createCheckins(db)
    }

    private fun createCheckins(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE checkins (
                checkin_id TEXT PRIMARY KEY,
                sos_id TEXT NOT NULL,
                message TEXT,
                deadline_at INTEGER,
                received_at INTEGER NOT NULL,
                response TEXT,
                title TEXT,
                choices TEXT,
                attempt INTEGER NOT NULL DEFAULT 1,
                tier TEXT,
                sent_at INTEGER NOT NULL DEFAULT 0,
                answered_at INTEGER,
                delivered INTEGER NOT NULL DEFAULT 0,
                reply_attempts INTEGER NOT NULL DEFAULT 0,
                next_reply_at INTEGER NOT NULL DEFAULT 0,
                mesh_replied INTEGER NOT NULL DEFAULT 0,
                reminder_count INTEGER NOT NULL DEFAULT 0,
                last_notified_at INTEGER NOT NULL DEFAULT 0
            )"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion == 2) {
            // v2 -> v3 only reshapes the check-in table (welfare check-ins); held messages and the inbox are kept.
            db.execSQL("DROP TABLE IF EXISTS checkins")
            createCheckins(db)
            return
        }
        db.execSQL("DROP TABLE IF EXISTS messages")
        db.execSQL("DROP TABLE IF EXISTS inbox")
        db.execSQL("DROP TABLE IF EXISTS checkins")
        onCreate(db)
    }

    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = onUpgrade(db, oldVersion, newVersion)

    override fun contains(id: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM messages WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

    override fun save(message: StoredMessage) {
        val values = ContentValues().apply {
            put("id", message.id)
            put("envelope", message.envelope.toJson().toString())
            put("received_at", message.receivedAt)
            put("expires_at", message.expiresAtMs)
            put("uploaded", if (message.uploaded) 1 else 0)
            put("reject_reason", message.rejectReason)
            put("is_own", if (message.isOwn) 1 else 0)
            put("from_peer", message.fromPeer)
            put("own_payload", message.ownPayload)
            put("remote", message.remote?.toJson())
            put("verified", if (message.verified) 1 else 0)
        }
        writableDatabase.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun all(): List<StoredMessage> {
        val out = ArrayList<StoredMessage>()
        readableDatabase.rawQuery(
            "SELECT id, envelope, received_at, uploaded, reject_reason, is_own, from_peer, own_payload, remote, verified FROM messages ORDER BY received_at",
            null
        ).use { c ->
            while (c.moveToNext()) {
                val env = MeshEnvelope.decode(c.getString(1).toByteArray(Charsets.UTF_8)) ?: continue
                out += StoredMessage(
                    id = c.getString(0),
                    envelope = env,
                    receivedAt = c.getLong(2),
                    uploaded = c.getInt(3) == 1,
                    rejectReason = if (c.isNull(4)) null else c.getString(4),
                    isOwn = c.getInt(5) == 1,
                    fromPeer = if (c.isNull(6)) null else c.getString(6),
                    ownPayload = if (c.isNull(7)) null else c.getString(7),
                    remote = RemoteStatus.fromJson(if (c.isNull(8)) null else c.getString(8)),
                    verified = c.getInt(9) == 1,
                )
            }
        }
        return out
    }

    override fun markUploaded(id: String) {
        writableDatabase.execSQL("UPDATE messages SET uploaded = 1, reject_reason = NULL WHERE id = ?", arrayOf(id))
    }

    override fun markRejected(id: String, reason: String) {
        writableDatabase.execSQL("UPDATE messages SET reject_reason = ? WHERE id = ?", arrayOf(reason, id))
    }

    override fun updateRemote(id: String, status: RemoteStatus) {
        writableDatabase.execSQL("UPDATE messages SET remote = ? WHERE id = ?", arrayOf(status.toJson(), id))
    }

    override fun deleteExpired(nowMs: Long) {
        writableDatabase.delete("messages", "expires_at < ?", arrayOf(nowMs.toString()))
        writableDatabase.delete("inbox", "expires_at < ?", arrayOf(nowMs.toString()))
        writableDatabase.delete("checkins", "COALESCE(deadline_at, received_at) < ?", arrayOf((nowMs - PROMPT_KEEP_MS).toString()))
    }

    override fun containsInbox(key: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM inbox WHERE key = ?", arrayOf(key)).use { it.moveToFirst() }

    override fun saveInbox(item: InboxItem) {
        val v = ContentValues().apply {
            put("key", item.key); put("type", item.type); put("json", item.json)
            put("received_at", item.receivedAt); put("expires_at", item.expiresAt); put("acted", if (item.acted) 1 else 0)
        }
        writableDatabase.insertWithOnConflict("inbox", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun inbox(): List<InboxItem> {
        val out = ArrayList<InboxItem>()
        readableDatabase.rawQuery("SELECT key, type, json, received_at, expires_at, acted FROM inbox ORDER BY received_at", null).use { c ->
            while (c.moveToNext()) out += InboxItem(c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getLong(4), c.getInt(5) == 1)
        }
        return out
    }

    override fun markInboxActed(key: String) {
        writableDatabase.execSQL("UPDATE inbox SET acted = 1 WHERE key = ?", arrayOf(key))
    }

    override fun savePrompt(p: CheckinPrompt) {
        val v = ContentValues().apply {
            put("checkin_id", p.checkinId); put("sos_id", p.sosId); put("message", p.message)
            put("deadline_at", p.deadlineAtMs); put("received_at", p.receivedAt); put("response", p.response)
            put("title", p.title); put("choices", p.choices.joinToString(","))
            put("attempt", p.attempt); put("tier", p.tier); put("sent_at", p.sentAtMs)
            put("answered_at", p.answeredAtMs)
            put("delivered", if (p.delivered) 1 else 0); put("reply_attempts", p.replyAttempts)
            put("next_reply_at", p.nextReplyAtMs); put("mesh_replied", if (p.meshReplied) 1 else 0)
            put("reminder_count", p.reminderCount); put("last_notified_at", p.lastNotifiedAtMs)
        }
        writableDatabase.insertWithOnConflict("checkins", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun prompts(): List<CheckinPrompt> {
        val out = ArrayList<CheckinPrompt>()
        readableDatabase.rawQuery(
            "SELECT checkin_id, sos_id, message, deadline_at, received_at, response, title, choices, attempt, tier, sent_at, " +
                "answered_at, delivered, reply_attempts, next_reply_at, mesh_replied, reminder_count, last_notified_at FROM checkins ORDER BY received_at",
            null,
        ).use { c ->
            fun str(i: Int) = if (c.isNull(i)) null else c.getString(i)
            fun lng(i: Int) = if (c.isNull(i)) null else c.getLong(i)
            while (c.moveToNext()) out += CheckinPrompt(
                checkinId = c.getString(0), sosId = c.getString(1), message = str(2), deadlineAtMs = lng(3),
                receivedAt = c.getLong(4), response = str(5), title = str(6),
                choices = str(7)?.split(',')?.filter { it.isNotBlank() }?.ifEmpty { null } ?: WelfareResponse.ALL,
                attempt = c.getInt(8), tier = str(9), sentAtMs = c.getLong(10), answeredAtMs = lng(11),
                delivered = c.getInt(12) == 1, replyAttempts = c.getInt(13), nextReplyAtMs = c.getLong(14),
                meshReplied = c.getInt(15) == 1, reminderCount = c.getInt(16), lastNotifiedAtMs = c.getLong(17),
            )
        }
        return out
    }

    override fun answerPrompt(checkinId: String, response: String) {
        writableDatabase.execSQL("UPDATE checkins SET response = ? WHERE checkin_id = ?", arrayOf(response, checkinId))
    }

    override fun deletePrompt(checkinId: String) {
        writableDatabase.delete("checkins", "checkin_id = ?", arrayOf(checkinId))
    }
}

/** Answered / expired check-ins stay this long after their deadline so the UI can show "you said ...". */
internal const val PROMPT_KEEP_MS = 24L * 3_600_000
