package com.beacon.mesh

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.backend.ServerInfo
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.heartbeat.Heartbeat
import com.beacon.mesh.heartbeat.HeartbeatExtras
import com.beacon.mesh.net.ApiResult
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.HopLimits
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.support.FakeHttp
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

private const val NOW = 1_794_000_000_000L
private const val DEV = "0192a000-0000-7000-8000-0000000000d1"

class HeartbeatFieldsTest {
    private fun hb(extras: HeartbeatExtras) = Heartbeat.create(NOW, 32.98571, -96.75012, 41, false, true, 17, extras)

    @Test fun carriesTheNewOptionalFields() {
        val j = hb(HeartbeatExtras("direct", "wifi", 3, true, listOf("a", "b")))
        assertEquals("direct", j.getString("transport")); assertEquals("wifi", j.getString("network"))
        assertEquals(3, j.getInt("peers_nearby")); assertTrue(j.getBoolean("gateway"))
        assertEquals(listOf("a", "b"), (0 until 2).map { j.getJSONArray("open_sos_ids").getString(it) })
        assertEquals(17, j.getInt("seq")); assertEquals(1000, j.getJSONObject("approx").getInt("radius_m"))
    }

    @Test fun omitsWhatIsUnknownAndRejectsBadEnums() {
        val j = hb(HeartbeatExtras(transport = "carrier-pigeon", network = "5g"))
        for (k in listOf("transport", "network", "peers_nearby", "gateway", "open_sos_ids")) assertFalse(k, j.has(k))
    }

    @Test fun openSosIdsAreCappedAtTwentyAndDeduplicated() {
        val ids = (1..30).map { "id$it" } + "id1"
        assertEquals(20, hb(HeartbeatExtras(openSosIds = ids)).getJSONArray("open_sos_ids").length())
    }

    @Test fun meshHeartbeatKeepsTheFieldsAndSaysMesh() {
        val direct = hb(HeartbeatExtras("direct", "cellular", 1, false))
        val mesh = Heartbeat.withTransport(direct, "mesh")
        assertEquals("mesh", mesh.getString("transport")); assertEquals("direct", direct.getString("transport"))
        assertEquals("cellular", mesh.getString("network"))
        assertEquals(mesh.toString(), Heartbeat.meshPayload(mesh).getJSONObject("heartbeat").toString())
    }

    @Test fun networkKindMapping() {
        assertEquals("wifi", Heartbeat.networkKind(true, true, false))
        assertEquals("cellular", Heartbeat.networkKind(true, false, true))
        assertEquals("none", Heartbeat.networkKind(false, false, false))
        assertEquals("unknown", Heartbeat.networkKind(true, false, false))
        assertEquals("unknown", Heartbeat.networkKind(false, false, false, known = false))
    }

    @Test fun heartbeatIsSentWithoutAnEventAndWhileAnSosIsOpen() {
        // no event parameter exists any more: only the interval, a forced send and a location matter
        assertTrue(Heartbeat.shouldSend(NOW, 0, 300, force = false, hasLocation = true))
        assertFalse(Heartbeat.shouldSend(NOW, NOW - 100_000, 300, force = false, hasLocation = true))
        assertTrue(Heartbeat.shouldSend(NOW, NOW - 100_000, 300, force = true, hasLocation = true)) // connectivity back / SOS created
        assertFalse(Heartbeat.shouldSend(NOW, 0, 300, force = true, hasLocation = false))
        assertTrue(Heartbeat.shouldSend(NOW, NOW - 300_000, 300, force = false, hasLocation = true))
    }

    @Test fun intervalComesFromServerInfoAndDefaultsTo300() {
        val cfg = BackendConfig(MemoryKeyValueStore())
        assertEquals(300, cfg.heartbeatIntervalSeconds)
        cfg.update(ServerInfo.fromJson(JSONObject("""{"server_time":"2026-11-07T16:00:00Z","hop_limits":[],"heartbeat_interval_seconds":120,"checkin_window_seconds":300,"event":null}""")), NOW)
        assertEquals(120, cfg.heartbeatIntervalSeconds)
        val info = ServerInfo.fromJson(JSONObject("""{"checkin_window_seconds":300}"""))
        assertEquals(300, info.checkinWindowSeconds)
    }

    @Test fun openSosIdsListOnlyOwnUnresolvedSosOfTheCurrentIdentity() {
        val keys = FakeBackendKeys()
        val signer = SoftwareSigner()
        val cfg = keys.config()
        val router = MeshRouter(signer, InMemoryMessageStore(), cfg, { NOW })
        val a = router.originate(Category.TRAPPED, lat = 1.0, lng = 1.0)
        val b = router.originate(Category.INJURED, lat = 1.0, lng = 1.0)
        val safe = router.originate(Category.SAFE, lat = 1.0, lng = 1.0)
        router.markResolvedLocally(b.id, "done")
        val ids = Heartbeat.openSosIds(router.messages, NOW, router.ownPublicKey)
        assertEquals(listOf(a.id), ids) // resolved one and the "safe" report excluded
        assertTrue(safe.id !in ids)
        signer.regenerate() // identity reset: older SOS belong to the previous identity
        assertTrue(Heartbeat.openSosIds(router.messages, NOW, router.ownPublicKey).isEmpty())
    }
}

class HeartbeatApiTest {
    private val keys = FakeBackendKeys()
    private val http = FakeHttp()
    private val cfg = keys.config().also { it.deviceId = DEV }
    private val signer = SoftwareSigner()
    private val api = BeaconApi("https://x.test", http, RequestSigner(signer) { NOW }, cfg, Base64.getEncoder().encodeToString(signer.publicKeyDer), "t")

    @Test fun parsesPendingCheckinsFromTheHeartbeatResponse() {
        http.on("POST", "/v1/heartbeats") {
            http.json(202, """{"event_active":false,"next_heartbeat_in_seconds":300,"pending_checkins":[
              {"id":"c1","sos_id":"s1","kind":"welfare","channel":"app","sent_at":"2026-11-07T16:30:00Z","choices":["still_here","no_longer_need_help","need_urgent_help"],"attempt":1,"missed":false,"alarm_at":"2026-11-07T16:34:00Z","deadline_at":"2026-11-07T16:35:00Z"}]}""")
        }
        val ack = (api.heartbeat(Heartbeat.create(NOW, 1.0, 2.0, 50, true, false, 1)) as ApiResult.Ok).value
        assertFalse(ack.eventActive)
        assertEquals(listOf("c1"), ack.pendingCheckins.map { it.checkinId })
    }

    @Test fun olderServerWithoutPendingCheckinsStillParses() {
        http.on("POST", "/v1/heartbeats") { http.json(202, """{"event_active":true}""") }
        val ack = (api.heartbeat(JSONObject()) as ApiResult.Ok).value
        assertTrue(ack.pendingCheckins.isEmpty()); assertNull(ack.nextInSeconds)
    }

    @Test fun pendingEndpointAndPatchBodyMatchTheContract() {
        http.on("GET", "/v1/checkins/pending") { http.json(200, """{"data":[{"id":"c1","sos_id":"s1","sent_at":"2026-11-07T16:30:00Z","channel":"app","missed":false,"deadline_at":"2026-11-07T16:35:00Z"},{"id":"c2","sos_id":"s1","sent_at":"2026-11-07T16:30:00Z","channel":"app","missed":true}]}""") }
        val list = (api.pendingCheckins(NOW) as ApiResult.Ok).value
        assertEquals(listOf("c1", "c2"), list.map { it.checkinId }) // a missed (overdue) one stays the active check-in
        http.on("PATCH", "/v1/checkins/c1") { http.json(200, "{}") }
        assertTrue(api.respondCheckin("c1", "no_longer_need_help", null, NOW) is ApiResult.Ok)
        val body = JSONObject(http.callsTo("PATCH", "/v1/checkins/c1").single().body)
        assertEquals("no_longer_need_help", body.getString("response")); assertTrue(body.has("responded_at"))
        http.on("PATCH", "/v1/checkins/c1") { http.json(409, """{"code":"conflict","message":"answered"}""") }
        assertEquals(409, (api.respondCheckin("c1", "still_here", null, NOW) as ApiResult.Failure).code)
    }

    @Test fun publicKeyUsedForRegistrationFollowsAReset() {
        cfg.deviceId = null
        http.on("POST", "/v1/devices") { http.json(201, """{"id":"$DEV"}""") }
        api.publicKeyB64 = "NEWKEY"
        api.ensureRegistered()
        assertEquals("NEWKEY", JSONObject(http.callsTo("POST", "/v1/devices").single().body).getString("public_key"))
    }
}

class UnknownKindTest {
    @Test fun unknownKindIsDroppedLikeAnyOtherUnknownKind() {
        val keys = FakeBackendKeys()
        val signer = SoftwareSigner()
        val sender = MeshRouter(signer, InMemoryMessageStore(), keys.config(), { NOW })
        val msg = sender.originate(Category.TRAPPED, lat = 1.0, lng = 1.0)
        val relay = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), keys.config(), { NOW })
        val ok = msg.envelope.copy(hopCount = 1, hopPath = listOf("A1"))
        assertTrue(relay.receive(ok.toBytes(), "P") is ReceiveOutcome.Accepted)
        // same envelope with a kind the contract does not know (the signature would not match either, but the kind is rejected first)
        val bogus = ok.copy(kind = "bogus", id = "0192a7f0-0000-7000-8000-0000000000e1")
        assertEquals(ReceiveOutcome.Dropped(DropReason.MALFORMED), relay.receive(bogus.toBytes(), "P"))
        assertFalse("bogus" in com.beacon.mesh.protocol.MeshValidation.KINDS)
        assertEquals(setOf("sos", "checkin_reply", "safe", "heartbeat"), com.beacon.mesh.protocol.MeshValidation.KINDS)
    }
}

class MeshCheckinRequestTest {
    @Test fun verifiedRequestReachesTheWelfareSinkOnceAndResolvedStatusCancels() {
        val keys = FakeBackendKeys()
        val router = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), keys.config(), { NOW })
        val sos = router.originate(Category.TRAPPED, lat = 1.0, lng = 1.0)
        val got = ArrayList<com.beacon.mesh.store.CheckinPrompt>()
        val resolved = ArrayList<String>()
        router.checkinSink = { got.add(it) }
        router.onSosResolved = { resolved.add(it) }
        val body = JSONObject().put("title", "Are you OK?").put("deadline_at", com.beacon.mesh.protocol.Iso.format(NOW + 300_000))
            .put("choices", org.json.JSONArray(listOf("still_here", "no_longer_need_help", "need_urgent_help")))
        val bm = keys.signBackendMessage(sos.id, "checkin_request", body, "c1", createdAtMs = NOW)
        assertTrue(router.injectBackend(bm) != null)
        assertNull(router.injectBackend(bm)) // same backend message again: held already
        assertEquals(listOf("c1"), got.map { it.checkinId })
        // forged signature: not acted on
        val forged = bm.copy(id = "forged", checkinId = "c2", signature = bm.signature)
        router.injectBackend(forged)
        assertEquals(1, got.size)
        router.injectBackend(keys.signBackendMessage(sos.id, "status_update", JSONObject().put("status", "resolved").put("message", "Marked as resolved. Stay safe."), createdAtMs = NOW + 1000))
        assertEquals(listOf(sos.id), resolved)
        assertEquals("resolved", router.messages.single { it.id == sos.id }.remote!!.status)
    }
}
