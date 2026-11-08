package com.beacon.mesh

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.profile.BloodType
import com.beacon.mesh.profile.EmergencyContact
import com.beacon.mesh.profile.MobilityNeed
import com.beacon.mesh.profile.ProfileRules
import com.beacon.mesh.profile.UserProfile
import com.beacon.mesh.protocol.Category
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.store.InMemoryMessageStore
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.transport.Framing
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_794_000_000_000L

/** `MeshPayload.profile_summary`: present for own sos/safe when a profile exists, the only profile data on the mesh, and small. */
class ProfileSummaryPayloadTest {
    private val keys = FakeBackendKeys()
    private val router = MeshRouter(SoftwareSigner(), InMemoryMessageStore(), BackendConfig(MemoryKeyValueStore(), keys.encPublicB64, keys.signPublicB64)) { NOW }

    private val full = UserProfile(
        fullName = "Maria Elena Gonzalez", preferredName = "Mimi", birthYear = 1951, languages = listOf("es"), phone = "+19725550142",
        hair = "grey", conditions = listOf("type 2 diabetes"), medications = listOf("insulin"), allergies = listOf("penicillin"), bloodType = BloodType.O_POS,
        mobilityNeeds = setOf(MobilityNeed.OXYGEN_DEPENDENT), peopleCount = 3, homeAddress = "412 Cedar Ln, Richardson, TX",
        emergencyContact = EmergencyContact("Daniel Gonzalez", "+19725550177", "son"), notes = "Key under the green pot",
    )

    private fun payload(c: Category) = JSONObject(router.originate(c, text = "help", lat = 32.9857, lng = -96.7501).ownPayload!!)

    @Test fun sosAndSafeCarryTheSummaryWithTheLastAcknowledgedVersion() {
        router.profileSummary = { ProfileRules.summary(full, 0, NOW) }
        for (c in listOf(Category.TRAPPED, Category.INJURED, Category.WATER_MEDS, Category.OTHER, Category.CHECKIN, Category.SAFE)) {
            val s = payload(c).getJSONObject("profile_summary")
            assertEquals("Maria Elena Gonzalez", s.getString("full_name")); assertEquals("65-79", s.getString("age_range"))
            assertEquals(0, s.getInt("profile_version"))
        }
        router.profileSummary = { ProfileRules.summary(full, 7, NOW) }
        assertEquals(7, payload(Category.SAFE).getJSONObject("profile_summary").getInt("profile_version"))
    }

    @Test fun noProfileMeansNoSummary() {
        assertFalse(payload(Category.TRAPPED).has("profile_summary"))
        router.profileSummary = { null }
        assertFalse(payload(Category.SAFE).has("profile_summary"))
    }

    @Test fun nothingButTheSummaryKeysLeaksIntoTheMessage() {
        router.profileSummary = { ProfileRules.summary(full, 2, NOW) }
        val msg = router.originate(Category.TRAPPED, text = "help", lat = 32.9857, lng = -96.7501)
        val s = JSONObject(msg.ownPayload!!).getJSONObject("profile_summary")
        assertTrue(s.keys().asSequence().all { it in setOf("full_name", "age_range", "vulnerability_flags", "profile_version") })
        val wire = msg.envelope.toJson().toString() + msg.ownPayload
        for (secret in listOf("Mimi", "5550142", "Cedar", "insulin", "penicillin", "Daniel", "green pot", "O+", "grey")) assertFalse(secret, wire.contains(secret))
    }

    @Test fun skippedProfileSosIsFullyUsableWithoutSummary() {
        val repo = com.beacon.mesh.profile.ProfileRepository(com.beacon.mesh.profile.MemoryProfileStorage())
        repo.markStepDone()
        router.profileSummary = { repo.current.profile?.let { ProfileRules.summary(it, repo.current.profileVersion, NOW) } }
        assertFalse(payload(Category.TRAPPED).has("profile_summary"))
        assertTrue(payload(Category.SAFE).has("lat"))
    }

    @Test fun heartbeatAndCheckinReplyNeverCarryIt() {
        router.profileSummary = { ProfileRules.summary(full, 2, NOW) }
        val hb = router.originateHeartbeat(
            JSONObject().put("heartbeat", JSONObject().put("sent_at", Iso.format(NOW)).put("approx", JSONObject().put("lat", 32.985).put("lng", -96.755).put("radius_m", 1000)).put("seq", 1)), 32.985, -96.755,
        )
        assertFalse(hb.ownPayload!!.contains("profile_summary"))
    }

    @Test fun largestEnvelopeWithTheWorstCaseSummaryStillFitsSixtyFourChunksAtA100ByteWrite() {
        val worst = full.copy(
            fullName = "é".repeat(120), birthYear = 1940,
            conditions = listOf("x"), mobilityNeeds = setOf(MobilityNeed.OXYGEN_DEPENDENT, MobilityNeed.WHEELCHAIR, MobilityNeed.HEARING_IMPAIRED, MobilityNeed.COGNITIVE),
        )
        router.profileSummary = { ProfileRules.summary(worst, 123456, NOW) }
        val big = "é".repeat(280) // MAX_NOTE chars, 2 bytes each in UTF-8
        val m = router.originate(Category.TRAPPED, text = big, lat = 32.9857, lng = -96.7501, accuracy = 8.5, people = 2)
        assertTrue(JSONObject(m.ownPayload!!).has("profile_summary"))
        val bytes = m.envelope.forwarded("ABCD").toBytes()
        assertTrue("envelope ${bytes.size} B", Framing.chunk(bytes, 1, 100).size <= Framing.MAX_CHUNKS)
        assertTrue(Framing.chunk(bytes, 1, 512).size <= 8)
        assertNull(JSONObject(m.ownPayload!!).optJSONObject("profile_summary")?.optString("home_address", null))
    }
}
