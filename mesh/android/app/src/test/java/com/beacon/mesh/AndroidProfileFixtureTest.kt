package com.beacon.mesh

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.profile.MobilityNeed
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.UserProfile
import com.beacon.mesh.protocol.Canonical
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.support.Fixtures
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/**
 * Android -> server direction for `MeshPayload.profile_summary`. test-vectors/contract_v1/android_profile_envelope.json holds an sos and a safe
 * envelope created by MeshRouter with a profile present; server/test/e2e/android-profile-interop.test.ts ingests them and checks that
 * `Sos.profile` shows the summary (source mesh_summary).
 *
 * Regenerate: BEACON_WRITE_FIXTURES=1 ./gradlew :app:testDebugUnitTest --tests '*AndroidProfileFixtureTest*'
 */
class AndroidProfileFixtureTest {
    private val file = File(Fixtures.dir, "android_profile_envelope.json")
    private val server = Fixtures.server()
    private val encPub = server.getJSONObject("backend").getString("encryption_public_key")
    private val createdMs = Iso.parse("2026-11-07T16:00:00.000Z")!!

    private fun generate(): JSONObject {
        val signer = SoftwareSigner()
        val router = MeshRouter(signer, InMemoryMessageStore(), BackendConfig(MemoryKeyValueStore(), encPub, ""), now = { createdMs })
        // fixed "now" so the age bucket is stable: 1951 -> 75 in 2026
        val profile = UserProfile(fullName = "Maria Elena Gonzalez", birthYear = 1951, conditions = listOf("type 2 diabetes"), mobilityNeeds = setOf(MobilityNeed.OXYGEN_DEPENDENT))
        router.profileSummary = { ProfileRules.summary(profile, 0, createdMs) }
        val sos = router.originate(Category.TRAPPED, text = "Trapped, need oxygen", lat = 32.9857, lng = -96.7501, accuracy = 8.5, people = 2)
        val safe = router.originate(Category.SAFE, lat = 32.9857, lng = -96.7501)
        val expected = JSONArray()
        listOf(sos, safe).forEach { expected.put(JSONObject().put("id", it.id).put("payload", JSONObject(it.ownPayload!!))) }
        return JSONObject()
            .put("description", "Envelopes with MeshPayload.profile_summary created by the Android MeshRouter (software key). Encrypted to the fixture backend key in server_envelope.json.")
            .put("backend_encryption_public_key", encPub)
            .put("device_public_key", Base64.getEncoder().encodeToString(signer.publicKeyDer))
            .put("now_for_validation", "2026-11-07T16:01:00.000Z")
            .put("envelopes", JSONArray().also { a -> listOf(sos, safe).forEach { a.put(it.envelope.toJson()) } })
            .put("expected", expected)
    }

    @Test fun profileSummaryEnvelopesAreContractValidAndDecryptable() {
        if (System.getenv("BEACON_WRITE_FIXTURES") == "1") file.writeText(generate().toString(2) + "\n")
        val doc = JSONObject(file.readText())
        val privPkcs8 = Base64.getDecoder().decode(server.getJSONObject("backend").getString("encryption_private_key_pkcs8"))
        val now = Iso.parse(doc.getString("now_for_validation"))!!
        val envs = doc.getJSONArray("envelopes")
        val expected = doc.getJSONArray("expected")
        assertEquals(2, envs.length())
        for (i in 0 until envs.length()) {
            val env = MeshEnvelope.fromJson(envs.getJSONObject(i))!!
            val r = MeshValidation.validate(env, now, requireHop = false)
            assertNull("envelope $i", r.drop)
            assertTrue(r.verified)
            val plain = JSONObject(String(Ecies.decrypt(Base64.getDecoder().decode(env.payload), privPkcs8), Charsets.UTF_8))
            assertEquals(Canonical.json(expected.getJSONObject(i).getJSONObject("payload")), Canonical.json(plain))
            val s = plain.getJSONObject("profile_summary")
            assertEquals("Maria Elena Gonzalez", s.getString("full_name")); assertEquals("65-79", s.getString("age_range")); assertEquals(0, s.getInt("profile_version"))
        }
    }
}
