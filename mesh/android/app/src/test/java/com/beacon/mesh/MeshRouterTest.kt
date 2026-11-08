package com.beacon.mesh

import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.HopLimits
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.store.CheckinPrompt
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.store.StoredMessage
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.transport.Framing
import com.beacon.mesh.transport.Reassembler
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

private const val T0 = 1_794_000_000_000L // 2026-11-07

/** In-memory radio: routers in a line, deliveries queued and drained. */
private class FakeNetwork(val keys: FakeBackendKeys = FakeBackendKeys()) {
    inner class Port(val name: String) : MeshTransport {
        override fun send(envelopeJson: ByteArray, peer: String) {
            queue.add(Triple(name, peer, envelopeJson))
        }
    }

    val nodes = HashMap<String, MeshRouter>()
    val queue = ArrayDeque<Triple<String, String, ByteArray>>()
    var online = setOf<String>()
    val uploads = HashMap<String, MutableList<StoredMessage>>()
    var nowMs = T0

    fun add(name: String, withSigningKey: Boolean = true): MeshRouter {
        val r = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), keys.config(withSigning = withSigningKey), now = { nowMs })
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

private const val LAT = 32.9857
private const val LNG = -96.7501

class MeshRouterTest {
    private fun line(vararg names: String) = FakeNetwork().apply {
        names.forEach { add(it) }
        for (i in 0 until names.size - 1) link(names[i], names[i + 1])
        run()
    }

    private fun MeshRouter.sos(c: Category, cap: Int? = null, text: String? = "2 people, water rising") =
        originate(c, text = text, lat = LAT, lng = LNG, accuracy = 8.0, people = 2, nonCriticalHopCap = cap)

    @Test fun criticalSosTravelsWholeLine() {
        val net = line("A", "B", "C", "D")
        val msg = net.nodes["A"]!!.sos(Category.TRAPPED)
        net.run()
        val atD = net.has("D", msg.id)!!
        assertEquals(3, atD.envelope.hopCount)
        assertEquals(listOf("A", "B", "C").map { net.nodes[it]!!.relayId }, atD.envelope.hopPath)
        assertEquals(10, atD.envelope.maxHops)
        assertEquals("critical", atD.envelope.tier)
        assertTrue(atD.verified)
    }

    @Test fun relaysCannotReadThePayload() {
        val net = line("A", "B")
        val msg = net.nodes["A"]!!.sos(Category.TRAPPED, text = "secret words")
        net.run()
        val atB = net.has("B", msg.id)!!
        assertNull(atB.ownPayload)
        assertFalse(atB.envelope.toJson().toString().contains("secret words"))
        assertFalse(String(Base64.getDecoder().decode(atB.envelope.payload), Charsets.ISO_8859_1).contains("secret"))
        assertEquals("secret words", JSONObject(net.has("A", msg.id)!!.ownPayload!!).getString("text"))
    }

    @Test fun demoHopCapStopsNormalMessageAtThirdPhone() {
        val net = line("A", "B", "C", "D")
        val normal = net.nodes["A"]!!.sos(Category.CHECKIN, cap = 2)
        net.run()
        assertNotNull(net.has("B", normal.id))
        val atC = net.has("C", normal.id)!!
        assertEquals(2, atC.envelope.hopCount)
        assertFalse(atC.canForward)
        assertNull("hop limit should stop it at phone 3", net.has("D", normal.id))

        val critical = net.nodes["A"]!!.sos(Category.INJURED, cap = 2)
        net.run()
        assertNotNull(net.has("D", critical.id))
    }

    @Test fun demoHopCapNeverRaisesTheTableValue() {
        val net = line("A")
        assertEquals(3, net.nodes["A"]!!.sos(Category.SAFE, cap = 8).envelope.maxHops)
    }

    @Test fun gatewayUploadsAndStopsRelaying() {
        val net = line("A", "B", "C", "D")
        net.online = setOf("C")
        val msg = net.nodes["A"]!!.sos(Category.MEDICAL)
        net.run()
        assertEquals(listOf(msg.id), net.uploads["C"]?.map { it.id })
        assertEquals(2, net.uploads["C"]!!.first().envelope.hopCount)
        assertNull(net.has("D", msg.id))
    }

    @Test fun storeAndForwardToLatePeer() {
        val net = FakeNetwork()
        net.add("A"); net.add("B"); net.add("C")
        net.link("A", "B")
        val msg = net.nodes["A"]!!.sos(Category.TRAPPED)
        net.run()
        assertNull(net.has("C", msg.id))
        net.link("B", "C")
        net.run()
        assertEquals(2, net.has("C", msg.id)?.envelope?.hopCount)
    }

    @Test fun gatewayFlushesHeldMessagesWhenInternetReturns() {
        val net = line("A", "B")
        val msg = net.nodes["A"]!!.sos(Category.WATER_MEDS)
        net.run()
        assertNull(net.uploads["B"])
        net.online = setOf("B")
        net.nodes["B"]!!.internetBecameAvailable()
        assertEquals(listOf(msg.id), net.uploads["B"]?.map { it.id })
    }

    @Test fun rejectedAndUploadedMessagesAreNotUploadedAgain() {
        val net = line("A", "B")
        val a = net.nodes["A"]!!.sos(Category.TRAPPED)
        val b = net.nodes["A"]!!.sos(Category.INJURED)
        net.run()
        val rb = net.nodes["B"]!!
        rb.markRejected(a.id, "bad_signature")
        rb.markUploaded(b.id)
        assertTrue(rb.pendingUploads().isEmpty())
    }

    @Test fun noBackendKeyFailsClosed() {
        val net = FakeNetwork(FakeBackendKeys())
        val r = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), FakeBackendKeys().config(withEnc = false), now = { T0 })
        try {
            r.originate(Category.TRAPPED, lat = LAT, lng = LNG)
            fail("must not create a message without a backend key")
        } catch (e: SendException) {
            assertEquals(SendError.NO_BACKEND_KEY, e.error)
        }
        assertTrue(r.messages.isEmpty())
        assertTrue(net.nodes.isEmpty())
    }

    @Test fun noLocationIsAClearError() {
        val net = line("A")
        try {
            net.nodes["A"]!!.originate(Category.TRAPPED)
            fail()
        } catch (e: SendException) {
            assertEquals(SendError.NO_LOCATION, e.error)
        }
    }

    @Test fun serverHopTableOverridesDefaults() {
        val keys = FakeBackendKeys()
        val cfg = keys.config()
        cfg.update(
            com.beacon.mesh.backend.ServerInfo(
                null, null, null,
                HopLimits.fromJson(org.json.JSONArray("""[{"tier":"critical","max_hops":8,"ttl_seconds":3600}]""")),
                false, null, null, 120, 600, 50,
            ),
            T0,
        )
        val r = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), cfg, now = { T0 })
        val env = r.originate(Category.TRAPPED, lat = LAT, lng = LNG).envelope
        assertEquals(8, env.maxHops)
        assertEquals(3_600_000L, env.expiresAtMs - env.createdAtMs)
        assertEquals(2, r.originate(Category.SAFE, lat = LAT, lng = LNG, nonCriticalHopCap = 2).envelope.maxHops)
        assertEquals(120, cfg.heartbeatIntervalSeconds)
        assertEquals(50, cfg.maxBatch)
    }

    @Test fun envelopeShapeFollowsTheContract() {
        val net = line("A")
        val m = net.nodes["A"]!!.sos(Category.WATER_MEDS)
        val j = m.envelope.toJson()
        assertEquals(setOf("id", "sender_key_id", "sender_public_key", "kind", "tier", "max_hops", "hop_count", "hop_path", "expires_at", "created_at", "routing", "payload", "signature"), j.keys().asSequence().toSet())
        assertEquals("sos", j.getString("kind"))
        assertEquals("high", j.getString("tier"))
        assertEquals("need_water_meds", j.getJSONObject("routing").getString("category"))
        assertEquals(1000, j.getJSONObject("routing").getJSONObject("approx").getInt("radius_m"))
        assertEquals(32.985, j.getJSONObject("routing").getJSONObject("approx").getDouble("lat"), 1e-9)
        assertEquals(7, j.getInt("max_hops"))
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(j.getString("id")))
        assertTrue(Regex("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$").matches(j.getString("created_at")))
    }

    private fun receivedCopy(category: Category = Category.TRAPPED): Pair<FakeNetwork, MeshEnvelope> {
        val net = line("A", "B")
        val msg = net.nodes["A"]!!.sos(category)
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
        assertEquals(dropped(DropReason.BAD_SIGNATURE), fresh.receive(env.copy(maxHops = 10).toBytes(), "X"))
    }

    @Test fun tamperedPayloadOrExpiryFailsSignature() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        val flipped = Base64.getDecoder().decode(env.payload).also { it[100] = (it[100].toInt() xor 1).toByte() }
        assertEquals(dropped(DropReason.BAD_SIGNATURE), fresh.receive(env.copy(payload = Base64.getEncoder().encodeToString(flipped)).toBytes(), "X"))
        assertEquals(dropped(DropReason.BAD_SIGNATURE), fresh.receive(env.copy(expiresAt = com.beacon.mesh.protocol.Iso.format(env.expiresAtMs - 1000)).toBytes(), "X"))
    }

    @Test fun hopCountAndPathAreNotSigned() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        val moved = env.copy(hopCount = 4, hopPath = listOf("1111", "2222", "3333", "4444"))
        assertTrue(fresh.receive(moved.toBytes(), "X") is ReceiveOutcome.Accepted)
    }

    @Test fun hopOverMaxIsRejected() {
        val (net, env) = receivedCopy(Category.SAFE) // max_hops 3
        val fresh = net.add("Z")
        val bad = env.copy(hopCount = 4, hopPath = listOf("1111", "2222", "3333", "4444"))
        assertEquals(dropped(DropReason.HOP_LIMIT), fresh.receive(bad.toBytes(), "X"))
    }

    @Test fun hopResetWithoutPathIsRejected() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        assertEquals(dropped(DropReason.HOP_LIMIT), fresh.receive(env.copy(hopCount = 0).toBytes(), "X"))
        assertEquals(dropped(DropReason.PATH_MISMATCH), fresh.receive(env.copy(hopCount = 1, hopPath = emptyList()).toBytes(), "X"))
    }

    @Test fun expiredIsDropped() {
        val (net, env) = receivedCopy(Category.SAFE) // 3 h TTL
        val fresh = net.add("Z")
        net.nowMs += 3 * 3_600_000L + 1
        assertEquals(dropped(DropReason.EXPIRED), fresh.receive(env.toBytes(), "X"))
    }

    @Test fun tierKindMismatchAndHugeLimitsAreDropped() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        // These break the signature too, so check the order: limits are checked before the signature.
        assertEquals(dropped(DropReason.LIMITS), fresh.receive(env.copy(kind = "heartbeat").toBytes(), "X"))
        assertEquals(dropped(DropReason.LIMITS), fresh.receive(env.copy(maxHops = 11).toBytes(), "X"))
    }

    @Test fun garbageIsMalformed() {
        val a = FakeNetwork().add("A")
        assertEquals(dropped(DropReason.MALFORMED), a.receive("not json".toByteArray(), "X"))
        assertEquals(dropped(DropReason.MALFORMED), a.receive("{\"hello\":1}".toByteArray(), "X"))
    }

    @Test fun envelopeWithoutAnyKeyIsRelayedButMarkedUnverified() {
        val (net, env) = receivedCopy()
        val fresh = net.add("Z")
        val keyless = env.copy(senderKeyId = "0192a000-0000-7000-8000-0000000000d1", senderPublicKey = null)
        assertTrue(fresh.receive(keyless.toBytes(), "X") is ReceiveOutcome.Accepted)
        assertFalse(fresh.messages.first().verified)
    }

    @Test fun largestEnvelopeFitsTheFramingCap() {
        val net = line("A")
        val big = "\u00e9".repeat(280) // MAX_NOTE chars, 2 bytes each in UTF-8
        val m = net.nodes["A"]!!.sos(Category.TRAPPED, text = big)
        val bytes = m.envelope.forwarded("ABCD").toBytes()
        // 64 chunks must carry it down to a 100 byte write (MTU 103); real links use 173..503 bytes of data per chunk.
        assertTrue("envelope ${bytes.size} B", Framing.chunk(bytes, 1, 100).size <= Framing.MAX_CHUNKS)
        assertTrue(Framing.chunk(bytes, 1, 512).size <= 8)
    }

    // ---- Backend messages ----

    private fun bm(net: FakeNetwork, sosId: String, kind: String, body: JSONObject, checkinId: String? = null, at: Long = net.nowMs + 60_000) =
        net.keys.signBackendMessage(sosId, kind, body, checkinId, createdAtMs = at)

    private fun injectedAsRelayed(m: BackendMessage) = m.forwarded("9999").toJson().toString().toByteArray()

    @Test fun deliveredAndStatusUpdateUpdateOwnMessage() {
        val net = line("A", "B")
        val a = net.nodes["A"]!!
        val msg = a.sos(Category.TRAPPED)
        net.nowMs += 120_000
        val delivered = bm(net, msg.id, "delivered", JSONObject().put("status", "reported").put("message", "Your SOS reached responders"), at = net.nowMs - 90_000)
        assertTrue(a.receive(injectedAsRelayed(delivered), "B") is ReceiveOutcome.Accepted)
        var mine = net.has("A", msg.id)!!
        assertTrue(mine.uploaded)
        assertTrue(mine.remote!!.reachedResponders)

        val upd = bm(net, msg.id, "status_update", JSONObject().put("status", "en_route").put("eta_minutes", 40).put("message", "Help is on the way, ETA 40 min"), at = net.nowMs)
        a.receive(injectedAsRelayed(upd), "B")
        mine = net.has("A", msg.id)!!
        assertEquals("en_route", mine.remote!!.status)
        assertEquals(40, mine.remote!!.etaMinutes)
        assertEquals("Help is on the way, ETA 40 min", mine.remote!!.message)

        // an older update arriving late must not roll the status back
        val old = bm(net, msg.id, "status_update", JSONObject().put("status", "assigned").put("eta_minutes", JSONObject.NULL), at = net.nowMs - 50_000)
        a.receive(injectedAsRelayed(old), "B")
        assertEquals("en_route", net.has("A", msg.id)!!.remote!!.status)
    }

    @Test fun checkinRequestCreatesPromptAndReplyIsAMeshEnvelope() {
        val net = line("A", "B")
        val a = net.nodes["A"]!!
        val msg = a.sos(Category.TRAPPED)
        net.run()
        val req = bm(net, msg.id, "checkin_request", JSONObject().put("message", "Are you OK?").put("deadline_at", "2026-11-07T16:45:00.000Z"), checkinId = "0192a7f0-0000-7000-8000-0000000000c1")
        a.receive(injectedAsRelayed(req), "B")
        val prompt = a.checkinPrompts.single()
        assertEquals(msg.id, prompt.sosId)
        assertNull(prompt.response)

        val reply = a.originateCheckinReply(prompt, "ok")
        assertEquals("checkin_reply", reply.envelope.kind)
        assertEquals("normal", reply.envelope.tier)
        assertEquals("ok", a.checkinPrompts.single().response)
        net.run()
        assertNotNull(net.has("B", reply.id))
        assertEquals("0192a7f0-0000-7000-8000-0000000000c1", JSONObject(reply.ownPayload!!).getString("checkin_id"))
    }

    @Test fun backendMessageWithBadSignatureIsDroppedAndNotActedOn() {
        val net = line("A")
        val a = net.nodes["A"]!!
        val msg = a.sos(Category.TRAPPED)
        val forged = bm(net, msg.id, "delivered", JSONObject()).copy(signature = FakeBackendKeys.ecdsa(FakeBackendKeys.gen(), "x"))
        assertEquals(dropped(DropReason.BAD_SIGNATURE), a.receive(injectedAsRelayed(forged), "B"))
        assertFalse(net.has("A", msg.id)!!.uploaded)
        val tampered = bm(net, msg.id, "status_update", JSONObject().put("status", "assigned")).let { it.copy(body = JSONObject().put("status", "resolved")) }
        assertEquals(dropped(DropReason.BAD_SIGNATURE), a.receive(injectedAsRelayed(tampered), "B"))
    }

    @Test fun relayWithoutSigningKeyForwardsButOnlyActsAfterKeyArrives() {
        val net = FakeNetwork()
        val a = net.add("A", withSigningKey = false)
        net.add("B")
        net.link("A", "B")
        val msg = a.sos(Category.TRAPPED)
        net.run()
        val m = bm(net, msg.id, "delivered", JSONObject().put("status", "reported"))
        // arrives at A from B (a hop already used); A has no signing key yet
        val out = a.receive(injectedAsRelayed(m), "B")
        assertTrue(out is ReceiveOutcome.Accepted)
        assertFalse(net.has("A", msg.id)!!.uploaded)
        // it keeps relaying: a new peer gets it
        net.add("C"); net.link("A", "C")
        assertTrue(net.queue.any { it.second == "C" && String(it.third).contains("\"sos_id\"") })
    }

    @Test fun keyArrivingLaterActsOnHeldBackendMessages() {
        val keys = FakeBackendKeys()
        val cfg = com.beacon.mesh.backend.BackendConfig(com.beacon.mesh.backend.MemoryKeyValueStore(), keys.encPublicB64, "")
        val r = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), cfg, now = { T0 })
        val msg = r.originate(Category.TRAPPED, lat = LAT, lng = LNG)
        val m = keys.signBackendMessage(msg.id, "delivered", JSONObject(), createdAtMs = T0)
        r.receive(m.forwarded("9999").toJson().toString().toByteArray(), "B")
        assertFalse(r.messages.single().uploaded)
        cfg.update(com.beacon.mesh.backend.ServerInfo(null, null, keys.signPublicB64, HopLimits.DEFAULT, false, null, null, null, null, null), T0)
        r.reevaluateInbox()
        assertTrue(r.messages.single().uploaded)
    }

    @Test fun backendMessagesRelayWithHopRulesAndExpiry() {
        val net = line("A", "B", "C")
        val m = bm(net, "0192a7d4-1c2e-7000-8a00-0000000000a1", "status_update", JSONObject().put("status", "assigned"))
        net.nodes["A"]!!.injectBackend(m) // gateway injects hop 0 -> broadcast as hop 1
        net.run()
        assertEquals(1, net.nodes["C"]!!.heldBackendItems)
        assertEquals(dropped(DropReason.DUPLICATE), net.nodes["C"]!!.receive(injectedAsRelayed(m), "B"))
        // not addressed to anyone here: no own message changed, no crash
        assertTrue(net.nodes.values.all { n -> n.messages.isEmpty() })
        // hop limit: max_hops 5, so hop 6 is dropped
        val over = m.copy(hopCount = 6, hopPath = List(6) { "A$it" })
        assertEquals(dropped(DropReason.HOP_LIMIT), net.add("Z").receive(over.toJson().toString().toByteArray(), "X"))
        // expired
        net.nowMs += 7 * 3_600_000L
        assertEquals(dropped(DropReason.EXPIRED), net.add("Y").receive(injectedAsRelayed(m), "X"))
    }

    @Test fun heartbeatEnvelopeUsesHeartbeatTier() {
        val net = line("A", "B", "C")
        val a = net.nodes["A"]!!
        val hb = a.originateHeartbeat(JSONObject().put("heartbeat", JSONObject().put("sent_at", "2026-11-07T16:00:00.000Z").put("seq", 1)), 32.995, -96.745)
        assertEquals("heartbeat", hb.envelope.kind)
        assertEquals("heartbeat", hb.envelope.tier)
        assertEquals(2, hb.envelope.maxHops)
        assertEquals(30 * 60_000L, hb.envelope.expiresAtMs - hb.envelope.createdAtMs)
        net.run()
        assertNotNull(net.has("B", hb.id))
        assertNotNull(net.has("C", hb.id))
        assertFalse(net.has("C", hb.id)!!.canForward)
    }

    @Test fun receiptMarksOwnMessageDelivered() {
        val net = line("A")
        val a = net.nodes["A"]!!
        val msg = a.sos(Category.TRAPPED)
        val unsigned = com.beacon.mesh.protocol.DeliveredReceipt(msg.id, "2026-11-07T16:05:00.000Z", 5, 0, emptyList(), "")
        val signed = unsigned.copy(signature = FakeBackendKeys.ecdsa(net.keys.sign, unsigned.signedPart()))
        a.receive(signed.forwarded("9999").toJson().toString().toByteArray(), "B")
        assertTrue(net.has("A", msg.id)!!.uploaded)
    }

    @Test fun ecdhKeyIsNotLeakedInSpkiDecode() {
        assertTrue(Ecies.isValidP256Spki(Base64.getDecoder().decode(FakeBackendKeys().encPublicB64)))
        assertFalse(Ecies.isValidP256Spki(byteArrayOf(1, 2, 3)))
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

