package com.beacon.mesh

import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.Envelope
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.transport.Framing
import com.beacon.mesh.transport.Reassembler
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/** In-memory radio: routers in a line, deliveries queued and drained. Mirrors the Swift tests. */
private class FakeNetwork {
    inner class Port(val name: String) : MeshTransport {
        override fun send(envelopeJson: ByteArray, peer: String) {
            queue.add(Triple(name, peer, envelopeJson))
        }
    }

    val nodes = HashMap<String, MeshRouter>()
    val queue = ArrayDeque<Triple<String, String, ByteArray>>()
    var online = setOf<String>()
    val uploads = HashMap<String, MutableList<StoredMessage>>()
    var nowMs = 1_762_500_000_000L

    fun add(name: String): MeshRouter {
        val r = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), now = { nowMs })
        r.isOnline = { name in online }
        r.upload = { uploads.getOrPut(name) { mutableListOf() }.add(it) }
        r.transport = Port(name)
        nodes[name] = r
        return r
    }

    fun link(a: String, b: String) {
        nodes[a]!!.peerConnected(b)
        nodes[b]!!.peerConnected(a)
    }

    fun run() {
        while (queue.isNotEmpty()) {
            val (from, to, data) = queue.removeFirst()
            nodes[to]?.receive(data, from)
        }
    }

    fun has(node: String, id: String) = nodes[node]!!.messages.firstOrNull { it.id == id }
}

class MeshRouterTest {
    private fun line(vararg names: String) = FakeNetwork().apply {
        names.forEach { add(it) }
        for (i in 0 until names.size - 1) link(names[i], names[i + 1])
        run()
    }

    @Test fun criticalSosTravelsWholeLine() {
        val net = line("A", "B", "C", "D")
        val msg = net.nodes["A"]!!.originate(Category.TRAPPED, text = "2 people, water rising", people = 2)
        net.run()
        val atD = net.has("D", msg.id)!!
        assertEquals(3, atD.envelope.hop)
        assertEquals(listOf("A", "B", "C").map { net.nodes[it]!!.relayId }, atD.envelope.path)
        assertEquals(10, atD.header.maxHops)
    }

    @Test fun demoHopCapStopsNormalMessageAtThirdPhone() {
        val net = line("A", "B", "C", "D")
        val normal = net.nodes["A"]!!.originate(Category.CHECKIN, nonCriticalHopCap = 2)
        net.run()
        assertNotNull(net.has("B", normal.id))
        val atC = net.has("C", normal.id)!!
        assertEquals(2, atC.envelope.hop)
        assertFalse(atC.canForward)
        assertNull("hop limit should stop it at phone 3", net.has("D", normal.id))

        val critical = net.nodes["A"]!!.originate(Category.INJURED, nonCriticalHopCap = 2)
        net.run()
        assertNotNull(net.has("D", critical.id))
    }

    @Test fun gatewayUploadsAndStopsRelaying() {
        val net = line("A", "B", "C", "D")
        net.online = setOf("C")
        val msg = net.nodes["A"]!!.originate(Category.MEDICAL)
        net.run()
        assertEquals(listOf(msg.id), net.uploads["C"]?.map { it.id })
        assertEquals(2, net.uploads["C"]!!.first().envelope.hop)
        assertNull(net.has("D", msg.id))
    }

    @Test fun storeAndForwardToLatePeer() {
        val net = FakeNetwork()
        net.add("A"); net.add("B"); net.add("C")
        net.link("A", "B")
        val msg = net.nodes["A"]!!.originate(Category.TRAPPED)
        net.run()
        assertNull(net.has("C", msg.id))
        net.link("B", "C")
        net.run()
        assertEquals(2, net.has("C", msg.id)?.envelope?.hop)
    }

    @Test fun gatewayFlushesHeldMessagesWhenInternetReturns() {
        val net = line("A", "B")
        val msg = net.nodes["A"]!!.originate(Category.WATER_MEDS)
        net.run()
        assertNull(net.uploads["B"])
        net.online = setOf("B")
        net.nodes["B"]!!.internetBecameAvailable()
        assertEquals(listOf(msg.id), net.uploads["B"]?.map { it.id })
    }

    private fun receivedCopy(category: Category = Category.TRAPPED): Pair<FakeNetwork, Envelope> {
        val net = line("A", "B")
        val msg = net.nodes["A"]!!.originate(category)
        net.run()
        return net to net.has("B", msg.id)!!.envelope
    }

    private fun dropped(r: DropReason) = ReceiveOutcome.Dropped(r)

    @Test fun duplicateIsDropped() {
        val (net, env) = receivedCopy()
        assertEquals(dropped(DropReason.DUPLICATE), net.nodes["B"]!!.receive(env.toBytes(), "X"))
    }

    @Test fun tamperedMaxHopsFailsSignature() {
        val (net, env) = receivedCopy(Category.CHECKIN)
        val fresh = net.add("Z")
        val forged = env.header!!.copy(maxHops = 10)
        val bad = env.copy(signed = Base64.getEncoder().encodeToString(forged.encoded()))
        assertEquals(dropped(DropReason.BAD_SIGNATURE), fresh.receive(bad.toBytes(), "X"))
    }

    @Test fun hopOverMaxIsRejected() {
        val (net, env) = receivedCopy(Category.SAFE) // maxHops 3
        val fresh = net.add("Z")
        val bad = env.copy(hop = 4, path = listOf("1111", "2222", "3333", "4444"))
        assertEquals(dropped(DropReason.HOP_LIMIT), fresh.receive(bad.toBytes(), "X"))
    }

    @Test fun hopResetWithoutPathIsRejected() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        assertEquals(dropped(DropReason.HOP_LIMIT), fresh.receive(env.copy(hop = 0).toBytes(), "X"))
        assertEquals(dropped(DropReason.PATH_MISMATCH), fresh.receive(env.copy(hop = 1, path = emptyList()).toBytes(), "X"))
    }

    @Test fun expiredIsDropped() {
        val (net, env) = receivedCopy(Category.SAFE) // 3 h TTL
        val fresh = net.add("Z")
        net.nowMs += 3 * 3_600_000L + 1
        assertEquals(dropped(DropReason.EXPIRED), fresh.receive(env.toBytes(), "X"))
    }

    @Test fun garbageIsMalformed() {
        val a = FakeNetwork().add("A")
        assertEquals(dropped(DropReason.MALFORMED), a.receive("not json".toByteArray(), "X"))
    }
}

class FramingTest {
    @Test fun chunkAndReassembleOutOfOrder() {
        val payload = ByteArray(1500) { (it % 251).toByte() }
        val frames = Framing.chunk(payload, 0xDEADBEEF.toInt(), 182)
        assertEquals(Math.ceil(1500 / 173.0).toInt(), frames.size)
        assertTrue(frames.all { it.size <= 182 })
        val r = Reassembler()
        var out: ByteArray? = null
        frames.reversed().forEach { f -> r.ingest(f, "p")?.let { out = it } }
        assertArrayEquals(payload, out)
    }

    @Test fun singleChunkHeaderMatchesIos() {
        val frames = Framing.chunk("hi".toByteArray(), 1, 100)
        assertEquals(1, frames.size)
        assertArrayEquals(byteArrayOf(0x01, 0, 0, 0, 1, 0, 0, 0, 1), frames[0].copyOf(9))
        assertArrayEquals("hi".toByteArray(), Reassembler().ingest(frames[0], "p"))
    }

    @Test fun stalePartialIsPurged() {
        var now = 0L
        val frames = Framing.chunk(ByteArray(300) { 7 }, 9, 100)
        val r = Reassembler(30_000) { now }
        assertNull(r.ingest(frames[0], "p"))
        now = 31_000
        frames.drop(1).forEach { assertNull(r.ingest(it, "p")) }
    }
}

/** The vector in mesh/test-vectors was signed by iOS CryptoKit; Android must verify it. */
class TestVectorTest {
    @Test fun sharedEnvelopeVectorVerifies() {
        // Gradle runs unit tests with the module dir (mesh/android/app) as working directory.
        val root = JSONObject(File("../../test-vectors/envelope_v1.json").readText())
        val env = Envelope.fromJson(root.getJSONObject("envelope"))!!
        val bytes = env.signedBytes!!
        val header = env.header!!
        assertEquals(root.getString("expectedId"), header.id)
        assertEquals(
            root.getString("expectedOriginRelayId"),
            MeshCrypto.relayId(Base64.getDecoder().decode(header.pub)),
        )
        assertNull(MeshValidation.validate(env, header, bytes, header.createdAt + 1000))
    }
}
