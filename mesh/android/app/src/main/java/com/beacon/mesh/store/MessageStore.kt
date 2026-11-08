package com.beacon.mesh.store

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.beacon.mesh.protocol.Envelope
import com.beacon.mesh.protocol.SignedHeader

data class StoredMessage(
    val id: String,
    /** Envelope exactly as received (hop 0 / empty path for our own messages). */
    val envelope: Envelope,
    val header: SignedHeader,
    val receivedAt: Long,
    val uploaded: Boolean,
    val isOwn: Boolean,
    val fromPeer: String?,
) {
    val canForward: Boolean get() = envelope.hop < header.maxHops
}

interface MessageStore {
    fun contains(id: String): Boolean
    fun save(message: StoredMessage)
    fun all(): List<StoredMessage>
    fun markUploaded(id: String)
    fun deleteExpired(nowMs: Long)
}

class InMemoryMessageStore : MessageStore {
    private val messages = LinkedHashMap<String, StoredMessage>()
    override fun contains(id: String) = messages.containsKey(id)
    override fun save(message: StoredMessage) { messages[message.id] = message }
    override fun all() = messages.values.sortedBy { it.receivedAt }
    override fun markUploaded(id: String) { messages[id]?.let { messages[id] = it.copy(uploaded = true) } }
    override fun deleteExpired(nowMs: Long) { messages.values.removeAll { it.header.expiresAt < nowMs } }
}

/** SQLite-backed store so held messages survive the app being killed. */
class SqliteMessageStore(context: Context) :
    SQLiteOpenHelper(context, "beacon_mesh.db", null, 1), MessageStore {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                envelope TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                uploaded INTEGER NOT NULL DEFAULT 0,
                is_own INTEGER NOT NULL DEFAULT 0,
                from_peer TEXT
            )"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS messages")
        onCreate(db)
    }

    override fun contains(id: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM messages WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

    override fun save(message: StoredMessage) {
        val values = ContentValues().apply {
            put("id", message.id)
            put("envelope", message.envelope.toJson().toString())
            put("received_at", message.receivedAt)
            put("expires_at", message.header.expiresAt)
            put("uploaded", if (message.uploaded) 1 else 0)
            put("is_own", if (message.isOwn) 1 else 0)
            put("from_peer", message.fromPeer)
        }
        writableDatabase.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun all(): List<StoredMessage> {
        val out = ArrayList<StoredMessage>()
        readableDatabase.rawQuery(
            "SELECT id, envelope, received_at, uploaded, is_own, from_peer FROM messages ORDER BY received_at",
            null
        ).use { c ->
            while (c.moveToNext()) {
                val env = Envelope.decode(c.getString(1).toByteArray(Charsets.UTF_8)) ?: continue
                val header = env.header ?: continue
                out += StoredMessage(
                    id = c.getString(0),
                    envelope = env,
                    header = header,
                    receivedAt = c.getLong(2),
                    uploaded = c.getInt(3) == 1,
                    isOwn = c.getInt(4) == 1,
                    fromPeer = if (c.isNull(5)) null else c.getString(5),
                )
            }
        }
        return out
    }

    override fun markUploaded(id: String) {
        writableDatabase.execSQL("UPDATE messages SET uploaded = 1 WHERE id = ?", arrayOf(id))
    }

    override fun deleteExpired(nowMs: Long) {
        writableDatabase.delete("messages", "expires_at < ?", arrayOf(nowMs.toString()))
    }
}
