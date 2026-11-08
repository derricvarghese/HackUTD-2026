package com.beacon.mesh.profile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfileModelTest {
    private val consent = Consent("2026-11-v1", "2026-11-07T15:58:00Z")

    @Test fun inputJsonWithOnlyANameOmitsEveryEmptyField() {
        val j = UserProfile(fullName = "  Maria Gonzalez ", preferredName = " ", phone = "", languages = emptyList(), pets = emptyList()).toInputJson(consent)
        assertEquals(setOf("full_name", "consent"), j.keys().asSequence().toSet())
        assertEquals("Maria Gonzalez", j.getString("full_name"))
        val c = j.getJSONObject("consent")
        assertTrue(c.getBoolean("accepted")); assertEquals("2026-11-v1", c.getString("version")); assertEquals("2026-11-07T15:58:00Z", c.getString("accepted_at"))
    }

    @Test fun inputJsonNestsSectionsAndDropsEmptySections() {
        val j = UserProfile(
            fullName = "Maria", birthYear = 1951, languages = listOf("es", "en"), heightCm = 160, hair = "grey",
            conditions = listOf("diabetes"), bloodType = BloodType.O_POS, mobilityNeeds = setOf(MobilityNeed.OXYGEN_DEPENDENT, MobilityNeed.WHEELCHAIR),
            peopleCount = 3, children = 1, pets = listOf(Pet("dog", 1), Pet("cat")),
            emergencyContact = EmergencyContact("Dan", "+19725550177", "son"), notes = "key under pot",
        ).toInputJson(consent)
        assertEquals(setOf("full_name", "birth_year", "languages", "appearance", "medical", "mobility", "household", "emergency_contact", "notes", "consent"), j.keys().asSequence().toSet())
        assertEquals(setOf("height_cm", "hair"), j.getJSONObject("appearance").keys().asSequence().toSet())
        assertEquals(setOf("conditions", "blood_type"), j.getJSONObject("medical").keys().asSequence().toSet())
        assertEquals("O+", j.getJSONObject("medical").getString("blood_type"))
        // enum order is stable, wire names as in the contract
        assertEquals("""["wheelchair","oxygen_dependent"]""", j.getJSONObject("mobility").getJSONArray("needs").toString())
        assertEquals(setOf("people_count", "children", "pets"), j.getJSONObject("household").keys().asSequence().toSet())
        assertEquals(setOf("kind", "count"), j.getJSONObject("household").getJSONArray("pets").getJSONObject(0).keys().asSequence().toSet())
        assertEquals(setOf("kind"), j.getJSONObject("household").getJSONArray("pets").getJSONObject(1).keys().asSequence().toSet())
    }

    @Test fun jsonRoundTripAndServerResponseParsing() {
        val p = UserProfile(fullName = "Maria", preferredName = "Elena", birthYear = 1951, languages = listOf("es"), phone = "+19725550142",
            medications = listOf("insulin"), allergies = listOf("penicillin"), mobilityNeeds = setOf(MobilityNeed.COGNITIVE), mobilityNotes = "n",
            peopleCount = 2, elderly = 1, homeAddress = "1 Main", notes = "x")
        assertEquals(p, UserProfile.fromJson(p.toJson()))
        // ProfileFull from the server carries extra fields that must be ignored
        val full = p.toJson().put("view", "full").put("profile_version", 4).put("vulnerability_flags", org.json.JSONArray(listOf("medical"))).put("age_range", "65-79")
        assertEquals(p, UserProfile.fromJson(full))
    }

    @Test fun optionalSectionsEmptyOnlyWhenJustAName() {
        assertTrue(UserProfile(fullName = "A").optionalSectionsEmpty)
        assertFalse(UserProfile(fullName = "A", phone = "+19725550142").optionalSectionsEmpty)
        assertFalse(UserProfile(fullName = "A", mobilityNeeds = setOf(MobilityNeed.OTHER)).optionalSectionsEmpty)
    }

    @Test fun recordRoundTrip() {
        val r = ProfileRecord(UserProfile(fullName = "A"), consent, 3, SyncState.FAILED, "rejected", 5, 2, 99, 77, true, true, true, JSONObject().put("k", "v"))
        val back = ProfileRecord.fromJson(JSONObject(r.toJson().toString()))
        assertEquals(r.copy(draft = null), back.copy(draft = null))
        assertEquals("v", back.draft!!.getString("k"))
        assertNull(ProfileRecord.fromJson(JSONObject("{}")).profile)
    }

    @Test fun repositoryPersistsEncryptedBlobSeamAndErases() {
        val st = MemoryProfileStorage()
        val repo = ProfileRepository(st)
        repo.saveProfile(UserProfile(fullName = "A"), consent, 1)
        assertEquals(SyncState.PENDING, repo.current.syncState); assertEquals(1, repo.current.rev); assertTrue(repo.current.stepDone)
        assertEquals("A", ProfileRepository(st).current.profile!!.fullName) // reloaded from storage
        repo.eraseLocal()
        assertNull(repo.current.profile); assertTrue(repo.current.pendingErase); assertTrue(repo.current.stepDone)
        repo.update { it.copy(pendingErase = false) }
        assertTrue(ProfileRepository(st).current.stepDone)
    }
}
