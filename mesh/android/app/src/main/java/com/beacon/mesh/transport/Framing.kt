package com.beacon.mesh.transport

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Splits envelopes into GATT-write-sized chunks. Byte-identical to iOS `Framing`. */
object Framing {
    const val FRAME_TYPE_ENVELOPE: Byte = 0x01
    const val HEADER_SIZE = 9
    const val MAX_CHUNKS = 64

    fun chunk(payload: ByteArray, transferId: Int, maxWriteLength: Int): List<ByteArray> {
        val dataPerChunk = maxOf(1, maxWriteLength - HEADER_SIZE)
        val count = maxOf(1, (payload.size + dataPerChunk - 1) / dataPerChunk)
        require(count <= MAX_CHUNKS) { "envelope too large for mesh transport" }
        return (0 until count).map { index ->
            val start = index * dataPerChunk
            val end = minOf(start + dataPerChunk, payload.size)
            val len = maxOf(0, end - start)
            ByteBuffer.allocate(HEADER_SIZE + len).apply {
                put(FRAME_TYPE_ENVELOPE)
                putInt(transferId)            // big-endian by default
                putShort(index.toShort())
                putShort(count.toShort())
                if (len > 0) put(payload, start, len)
            }.array()
        }
    }
}

/** Reassembles chunks per (peer, transferId). Use from one thread. */
class Reassembler(private val timeoutMs: Long = 30_000, private val clock: () -> Long = System::currentTimeMillis) {
    private class Partial(count: Int, val startedAt: Long) {
        val chunks = arrayOfNulls<ByteArray>(count)
        var received = 0
    }

    private val partials = HashMap<String, Partial>()

    /** Returns the full payload when the last chunk of a transfer arrives. */
    fun ingest(frame: ByteArray, peer: String): ByteArray? {
        val now = clock()
        partials.entries.removeAll { now - it.value.startedAt >= timeoutMs }
        if (frame.size < Framing.HEADER_SIZE || frame[0] != Framing.FRAME_TYPE_ENVELOPE) return null
        val buf = ByteBuffer.wrap(frame)
        buf.get()
        val transferId = buf.int
        val index = buf.short.toInt() and 0xFFFF
        val count = buf.short.toInt() and 0xFFFF
        if (count < 1 || count > Framing.MAX_CHUNKS || index >= count) return null
        val data = frame.copyOfRange(Framing.HEADER_SIZE, frame.size)
        if (count == 1) return data

        val key = "$peer#${transferId.toUInt()}"
        val partial = partials.getOrPut(key) { Partial(count, now) }
        if (partial.chunks.size != count) {
            partials.remove(key)
            return null
        }
        if (partial.chunks[index] == null) {
            partial.chunks[index] = data
            partial.received++
        }
        if (partial.received == count) {
            partials.remove(key)
            val out = ByteArrayOutputStream()
            partial.chunks.forEach { out.write(it!!) }
            return out.toByteArray()
        }
        return null
    }

    fun reset(peer: String) {
        partials.keys.removeAll { it.startsWith("$peer#") }
    }
}
