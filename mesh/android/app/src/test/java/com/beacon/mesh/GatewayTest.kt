package com.beacon.mesh

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.gateway.GatewaySync
import com.beacon.mesh.heartbeat.Heartbeat
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DeliveredReceipt
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.support.FakeHttp
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

private const val NOW = 1_794_000_000_000L
private const val DEVICE_ID = "0192a000-0000-7000-8000-0000000000d1"

class RequestSignerTest {
    @Test fun headersCarryAVerifiableSignatureOverMethodPathBodyHashAndTimestamp() {
        val signer = SoftwareSigner()
        val rs = RequestSigner(signer) { NOW }
        val body = """{"envelopes":[]}""".toByteArray()
        val h = rs.headers(DEVICE_ID, "post", "/v1/sos/batch", body)
        assertEquals(DEVICE_ID, h["X-Device-Id"])
        assertEquals("2026-11-07T08:00:00.000Z".length, h["X-Timestamp"]!!.length)
        val signed = "POST\n/v1/sos/batch\n${MeshCrypto.sha256Hex(body)}\n${h["X-Timestamp"]}"
        assertEquals(signed, rs.message("POST", "/v1/sos/batch", body, h["X-Timestamp"]!!))
        assertTrue(MeshCrypto.verify(signer.publicKeyDer, signed.toByteArray(), Base64.getDecoder().decode(h["X-Device-Signature"])))
        // body is part of the signature
        assertFalse(MeshCrypto.verify(signer.publicKeyDer, signed.replace(MeshCrypto.sha256Hex(body), MeshCrypto.sha256Hex(ByteArray(0))).toByteArray(), Base64.getDecoder().decode(h["X-Device-Signature"])))
    }

    @Test fun emptyBodyHashIsTheWellKnownConstant() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", MeshCrypto.sha256Hex(ByteArray(0)))
    }
}

class HeartbeatTest {
    @Test fun payloadIsCoarseAndContractShaped() {
        val hb = Heartbeat.create(NOW, 32.98571, -96.75012, 41, false, true, 17)
        val a = hb.getJSONObject("approx")
        assertEquals(32.985, a.getDouble("lat"), 1e-9)
        assertEquals(-96.755, a.getDouble("lng"), 1e-9)
        assertEquals(1000, a.getInt("radius_m"))
        assertEquals(41, hb.getInt("battery_pct")); assertEquals(17, hb.getInt("seq"))
        assertEquals(setOf("sent_at", "approx", "battery_pct", "charging", "moving", "seq"), hb.keys().asSequence().toSet())
        assertTrue(Heartbeat.due(0, NOW, 300))
        assertFalse(Heartbeat.due(NOW - 299_000, NOW, 300))
        assertTrue(Heartbeat.due(NOW - 300_000, NOW, 300))
    }
}

class GatewayFlowTest {
    private val keys = FakeBackendKeys()
    private val signer = SoftwareSigner()
    private var now = NOW
    private val http = FakeHttp()
    private val cfg: BackendConfig = keys.config()
    private val store = InMemoryMessageStore()
    private val router = MeshRouter(signer, store, cfg) { now }
    private val api = BeaconApi("https://example.test", http, RequestSigner(signer) { now }, cfg, Base64.getEncoder().encodeToString(signer.publicKeyDer), "0.3")
    private val sync = GatewaySync(api, router, cfg, { now })

    init {
        http.on("POST", "/v1/devices") { http.json(201, """{"id":"$DEVICE_ID","sender_hash":"abc","created_at":"2026-11-07T00:00:00Z"}""") }
    }

    private fun sos(c: Category = Category.TRAPPED) = router.originate(c, text = "help", lat = 32.9857, lng = -96.7501)

    private fun batchReply(vararg items: String, receipts: String = "[]", messages: String = "[]") =
        http.json(200, """{"results":[${items.joinToString(",")}],"receipts":$receipts,"messages":$messages}""")

    private fun item(id: String, status: String, reason: String? = null) =
        """{"id":"$id","status":"$status"${reason?.let { ""","reason":"$it"""" } ?: ""}}"""

    @Test fun registersOnceAndStoresTheDeviceId() {
        assertEquals(DEVICE_ID, (api.ensureRegistered() as ApiResult.Ok).value)
        assertEquals(DEVICE_ID, cfg.deviceId)
        api.ensureRegistered()
        assertEquals(1, http.callsTo("POST", "/v1/devices").size)
        val body = JSONObject(http.callsTo("POST", "/v1/devices").single().body)
        assertEquals("android", body.getString("platform"))
        assertEquals(Base64.getEncoder().encodeToString(signer.publicKeyDer), body.getString("public_key"))
        assertEquals("0.3", body.getString("app_version"))
    }

    @Test fun registrationFailureIsRetriedLaterNotStored() {
        http.networkDown = true
        assertTrue(api.ensureRegistered() is ApiResult.Failure)
        assertNull(cfg.deviceId)
        http.networkDown = false
        assertTrue(api.ensureRegistered() is ApiResult.Ok)
    }

    @Test fun batchUploadIsSignedAndPerItemResultsApplied() {
        val a = sos(); val b = sos(Category.INJURED); val c = sos(Category.SAFE); val d = sos(Category.OTHER)
        http.on("POST", "/v1/sos/batch") { batchReply(item(a.id, "created"), item(b.id, "duplicate"), item(c.id, "rejected", "bad_signature"), item(d.id, "rejected", "rate_limited")) }
        val all = router.pendingUploads()
        val summary = sync.apply(sync.fetchUploads(all) { false })
        assertEquals(1, summary.created); assertEquals(1, summary.duplicate); assertEquals(1, summary.rejected); assertEquals(1, summary.deferred)
        assertEquals(mapOf("bad_signature" to 1), summary.rejectReasons)
        val byId = router.messages.associateBy { it.id }
        assertTrue(byId[a.id]!!.uploaded); assertTrue(byId[b.id]!!.uploaded)
        assertEquals("bad_signature", byId[c.id]!!.rejectReason)
        assertNull(byId[d.id]!!.rejectReason); assertFalse(byId[d.id]!!.uploaded)
        // retry later: only the rate-limited one is pending
        assertEquals(listOf(d.id), router.pendingUploads().map { it.id })

        // the request carried verifiable device-signature headers over the exact body
        val call = http.callsTo("POST", "/v1/sos/batch").single()
        val signed = "POST\n/v1/sos/batch\n${MeshCrypto.sha256Hex(call.body.toByteArray())}\n${call.headers["X-Timestamp"]}"
        assertEquals(DEVICE_ID, call.headers["X-Device-Id"])
        assertTrue(MeshCrypto.verify(signer.publicKeyDer, signed.toByteArray(), Base64.getDecoder().decode(call.headers["X-Device-Signature"])))
        assertEquals(4, JSONObject(call.body).getJSONArray("envelopes").length())
    }

    @Test fun expiredAndHopLimitRejectionsAreTerminal() {
        val a = sos(); val b = sos()
        http.on("POST", "/v1/sos/batch") { batchReply(item(a.id, "rejected", "expired"), item(b.id, "rejected", "hop_limit_exceeded")) }
        sync.apply(sync.fetchUploads(router.pendingUploads()) { false })
        assertTrue(router.pendingUploads().isEmpty())
    }

    @Test fun rateLimitedResponseBacksOffAndKeepsEverythingPending() {
        val a = sos()
        http.on("POST", "/v1/sos/batch") { http.json(429, """{"code":"rate_limited","message":"slow down"}""", mapOf("retry-after" to "42")) }
        val summary = sync.apply(sync.fetchUploads(router.pendingUploads()) { false })
        assertEquals(42, summary.retryAfterSeconds)
        assertEquals(1, summary.deferred)
        assertEquals(listOf(a.id), router.pendingUploads().map { it.id })
    }

    @Test fun networkFailureKeepsMessagesAndStopsFurtherCalls() {
        sos(); sos()
        http.on("POST", "/v1/sos/batch") { throw java.io.IOException("boom") }
        http.networkDown = false
        val s = sync.apply(sync.fetchUploads(router.pendingUploads()) { false })
        assertEquals(2, s.deferred)
        assertEquals(2, router.pendingUploads().size)
    }

    @Test fun batchesAreSplitAtGatewayUploadMaxBatch() {
        cfg.update(com.beacon.mesh.backend.ServerInfo(null, null, null, com.beacon.mesh.protocol.HopLimits.DEFAULT, false, null, null, null, null, 2), NOW)
        repeat(5) { sos() }
        http.on("POST", "/v1/sos/batch") { c ->
            val ids = JSONObject(c.body).getJSONArray("envelopes").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }
            batchReply(*ids.map { item(it, "created") }.toTypedArray())
        }
        sync.apply(sync.fetchUploads(router.pendingUploads()) { false })
        assertEquals(listOf(2, 2, 1), http.callsTo("POST", "/v1/sos/batch").map { JSONObject(it.body).getJSONArray("envelopes").length() })
        assertTrue(router.pendingUploads().isEmpty())
    }

    @Test fun receiptsAndMessagesFromTheBatchResponseAreInjectedIntoTheMesh() {
        val sent = ArrayList<ByteArray>()
        router.transport = object : MeshTransport { override fun send(envelopeJson: ByteArray, peer: String) { sent.add(envelopeJson) } }
        router.peerConnected("P")
        sent.clear()
        val a = sos()
        sent.clear()
        val unsigned = DeliveredReceipt(a.id, com.beacon.mesh.protocol.Iso.format(NOW), 5, 0, emptyList(), "")
        val receipt = unsigned.copy(signature = FakeBackendKeys.ecdsa(keys.sign, unsigned.signedPart()))
        val bm = keys.signBackendMessage(a.id, "status_update", JSONObject().put("status", "en_route").put("eta_minutes", 40).put("message", "Help is on the way, ETA 40 min"), createdAtMs = NOW + 1000)
        http.on("POST", "/v1/sos/batch") { batchReply(item(a.id, "created"), receipts = "[${receipt.toJson()}]", messages = "[${bm.toJson()}]") }
        sync.apply(sync.fetchUploads(router.pendingUploads()) { false })
        // addressed to us: applied to the UI state
        val mine = router.messages.single { it.id == a.id }
        assertEquals("en_route", mine.remote!!.status); assertEquals(40, mine.remote!!.etaMinutes)
        // and broadcast to peers as hop 1
        val kinds = sent.map { JSONObject(String(it)) }
        assertTrue(kinds.any { it.has("delivered_at") && it.getInt("hop_count") == 1 })
        assertTrue(kinds.any { it.optString("kind") == "status_update" && it.getInt("hop_count") == 1 && it.getJSONArray("hop_path").length() == 1 })
    }

    @Test fun ownSosGoesDirectViaPostSosAndFallsBackToBatch() {
        val a = sos(); val b = sos(Category.INJURED)
        http.on("POST", "/v1/sos") { c ->
            val j = JSONObject(c.body)
            if (j.getString("id") == a.id) http.json(201, """{"id":"${a.id}"}""") else http.json(422, """{"code":"validation_failed","message":"nope"}""")
        }
        http.on("POST", "/v1/sos/batch") { batchReply(item(b.id, "created")) }
        val s = sync.apply(sync.fetchUploads(router.pendingUploads()) { it.isOwn })
        assertEquals(1, s.direct)
        assertEquals(1, s.created)
        assertTrue(router.pendingUploads().isEmpty())
        val body = JSONObject(http.callsTo("POST", "/v1/sos").first().body)
        assertEquals("app", body.getString("channel"))
        assertEquals("trapped", body.getString("category"))
        assertEquals(32.9857, body.getDouble("lat"), 1e-9)
        assertEquals("help", body.getString("text"))
        assertEquals(a.envelope.createdAt, body.getString("created_at"))
        // direct requests are signed too
        assertNotNull(http.callsTo("POST", "/v1/sos").first().headers["X-Device-Signature"])
    }

    @Test fun serverInfoRefreshCachesKeysAndHopTable() {
        val fresh = FakeBackendKeys()
        val cfg2 = BackendConfig(MemoryKeyValueStore(), "", "")
        val router2 = MeshRouter(signer, InMemoryMessageStore(), cfg2) { now }
        val sync2 = GatewaySync(BeaconApi("https://example.test", http, RequestSigner(signer) { now }, cfg2, "pk", "0.3"), router2, cfg2, { now })
        http.on("GET", "/v1/server-info") {
            http.json(200, JSONObject().put("server_time", "2026-11-07T16:00:00Z").put("encryption_public_key", fresh.encPublicB64)
                .put("signing_public_key", fresh.signPublicB64).put("event", JSONObject().put("name", "Flood"))
                .put("hop_limits", JSONArray("""[{"tier":"critical","max_hops":9,"ttl_seconds":7200}]"""))
                .put("heartbeat_interval_seconds", 60).put("silence_threshold_seconds", 300).put("gateway_upload_max_batch", 100).toString())
        }
        assertEquals(com.beacon.mesh.backend.KeyStatus.NONE, cfg2.encryptionKeyStatus)
        assertTrue(sync2.applyServerInfo(sync2.fetchServerInfo()))
        assertEquals(com.beacon.mesh.backend.KeyStatus.CACHED, cfg2.encryptionKeyStatus)
        assertEquals(fresh.encPublicB64, cfg2.encryptionKey)
        assertEquals(9, cfg2.hopLimits.maxHops(com.beacon.mesh.protocol.Priority.CRITICAL))
        assertEquals(60, cfg2.heartbeatIntervalSeconds); assertEquals(300, cfg2.silenceThresholdSeconds); assertEquals(100, cfg2.maxBatch)
        assertTrue(cfg2.eventActive)
        // now a message can be created
        router2.originate(Category.TRAPPED, lat = 1.0, lng = 1.0)
    }

    @Test fun garbageKeysFromTheServerAreNotCached() {
        val cfg2 = BackendConfig(MemoryKeyValueStore(), keys.encPublicB64, "")
        cfg2.update(com.beacon.mesh.backend.ServerInfo(null, "AAAA", "BBBB", com.beacon.mesh.protocol.HopLimits.DEFAULT, false, null, null, null, null, null), NOW)
        assertEquals(com.beacon.mesh.backend.KeyStatus.BUILT_IN, cfg2.encryptionKeyStatus)
        assertEquals(com.beacon.mesh.backend.KeyStatus.NONE, cfg2.signingKeyStatus)
    }

    @Test fun outboxMessagesAreInjectedAndCursorAdvances() {
        val a = sos()
        val bm = keys.signBackendMessage(a.id, "checkin_request", JSONObject().put("message", "OK?"), checkinId = "0192a7f0-0000-7000-8000-0000000000c1", createdAtMs = NOW + 1000)
        http.on("GET", "/v1/mesh/outbox") { http.json(200, """{"data":[${bm.toJson()}]}""") }
        assertEquals(1, sync.applyOutbox(sync.fetchOutbox()))
        assertEquals(1, router.checkinPrompts.size)
        assertNotNull(cfg.outboxCursor)
        // the since cursor goes out URL-encoded and is not part of the signed path
        sync.fetchOutbox()
        val c = http.callsTo("GET", "/v1/mesh/outbox").last()
        assertTrue(c.url.contains("since="))
        assertEquals(0, sync.applyOutbox(sync.fetchOutbox())) // same message again: already held
    }

    @Test fun reregistersWhenTheServerForgotTheDevice() {
        cfg.deviceId = "11111111-1111-7111-8111-111111111111"
        var first = true
        http.on("GET", "/v1/checkins/pending") {
            if (first) { first = false; http.json(401, """{"code":"unauthorized","message":"Unknown device"}""") } else http.json(200, """{"data":[]}""")
        }
        assertTrue(api.pendingCheckins(NOW) is ApiResult.Ok)
        assertEquals(DEVICE_ID, cfg.deviceId)
        assertEquals(1, http.callsTo("POST", "/v1/devices").size)
    }

    @Test fun heartbeatAndCheckinCallsMatchTheContract() {
        http.on("POST", "/v1/heartbeats") { http.json(202, """{"event_active":true,"next_heartbeat_in_seconds":300}""") }
        http.on("PATCH", "/v1/checkins/0192a7f0-0000-7000-8000-0000000000c1") { http.json(200, "{}") }
        val ack = (api.heartbeat(Heartbeat.create(NOW, 1.0, 2.0, 50, true, false, 1)) as ApiResult.Ok).value
        assertTrue(ack.eventActive)
        assertTrue(api.respondCheckin("0192a7f0-0000-7000-8000-0000000000c1", "need_help", null, NOW) is ApiResult.Ok)
        assertEquals("need_help", JSONObject(http.callsTo("PATCH", "/v1/checkins/0192a7f0-0000-7000-8000-0000000000c1").single().body).getString("response"))
        http.on("POST", "/v1/heartbeats") { http.json(404, """{"code":"not_found","message":"no active event"}""") }
        assertEquals(404, (api.heartbeat(JSONObject()) as ApiResult.Failure).code)
    }
}
