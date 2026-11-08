package com.beacon.mesh

import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.protocol.Canonical
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.support.Fixtures
import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/**
 * Android -> server direction. The envelopes in test-vectors/contract_v1/android_envelope.json were created by MeshRouter
 * (software key instead of Android Keystore), encrypted to the fixture backend key. server/test/e2e/android-interop.test.ts
 * ingests them through POST /v1/sos/batch and expects `created`.
 *
 * Regenerate: BEACON_WRITE_FIXTURES=1 ./gradlew :app:testDebugUnitTest --tests '*AndroidFixtureTest*'
 */
class AndroidFixtureTest {
    private val file = File(Fixtures.dir, "android_envelope.json")
    private val server = Fixtures.server()
    private val encPub = server.getJSONObject("backend").getString("encryption_public_key")
    private val createdMs = Iso.parse("2026-11-07T16:00:00.000Z")!!

    private fun generate(): JSONObject {
        val signer = SoftwareSigner()
        val router = MeshRouter(signer, InMemoryMessageStore(), BackendConfig(MemoryKeyValueStore(), encPub, ""), now = { createdMs })
        val text = "Trapped on roof, 2 people é中 \"quoted\" \\ slash"
        val sos = router.originate(Category.TRAPPED, text = text, lat = 32.9857, lng = -96.7501, accuracy = 8.5, people = 2)
        val safe = router.originate(Category.SAFE, lat = 32.9857, lng = -96.7501)
        val water = router.originate(Category.WATER_MEDS, text = "need insulin", lat = 33.1, lng = -96.9, people = 1)
        val hb = router.originateHeartbeat(
            JSONObject().put("heartbeat", JSONObject().put("sent_at", Iso.format(createdMs)).put("approx", JSONObject().put("lat", 32.985).put("lng", -96.755).put("radius_m", 1000)).put("battery_pct", 41).put("charging", false).put("moving", false).put("seq", 17)),
            32.985, -96.755,
        )
        // a copy that travelled two hops (hop_count / hop_path are not signed)
        val relayed = sos.envelope.forwarded("E45B").forwarded("B7C2")
        val envs = listOf(relayed.copy(), safe.envelope, water.envelope, hb.envelope)
        val expected = JSONArray()
        listOf(sos, safe, water, hb).forEach { expected.put(JSONObject().put("id", it.id).put("payload", JSONObject(it.ownPayload!!))) }
        return JSONObject()
            .put("description", "Envelopes created by the Android MeshRouter (software key) for the server interop test. Encrypted to the fixture backend key in server_envelope.json.")
            .put("backend_encryption_public_key", encPub)
            .put("device_public_key", Base64.getEncoder().encodeToString(signer.publicKeyDer))
            .put("now_for_validation", "2026-11-07T16:01:00.000Z")
            .put("envelopes", JSONArray().also { a -> envs.forEach { a.put(it.toJson()) } })
            .put("expected", expected)
    }

    @Test fun androidEnvelopesAreContractValidAndDecryptable() {
        if (System.getenv("BEACON_WRITE_FIXTURES") == "1") file.writeText(generate().toString(2) + "\n")
        val doc = JSONObject(file.readText())
        val privPkcs8 = Base64.getDecoder().decode(server.getJSONObject("backend").getString("encryption_private_key_pkcs8"))
        val now = Iso.parse(doc.getString("now_for_validation"))!!
        val envs = doc.getJSONArray("envelopes")
        val expected = doc.getJSONArray("expected")
        assertEquals(4, envs.length())
        for (i in 0 until envs.length()) {
            val env = MeshEnvelope.fromJson(envs.getJSONObject(i))!!
            val r = MeshValidation.validate(env, now, requireHop = false)
            assertNull("envelope $i", r.drop)
            assertTrue(r.verified)
            val plain = JSONObject(String(Ecies.decrypt(Base64.getDecoder().decode(env.payload), privPkcs8), Charsets.UTF_8))
            assertEquals(Canonical.json(expected.getJSONObject(i).getJSONObject("payload")), Canonical.json(plain))
            assertEquals(expected.getJSONObject(i).getString("id"), env.id)
        }
        assertEquals(2, MeshEnvelope.fromJson(envs.getJSONObject(0))!!.hopCount)
        assertEquals("heartbeat", MeshEnvelope.fromJson(envs.getJSONObject(3))!!.kind)
    }
}
