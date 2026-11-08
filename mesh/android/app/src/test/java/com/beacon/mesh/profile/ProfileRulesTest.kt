package com.beacon.mesh.profile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_794_000_000_000L // 2026-11-07
private const val YEAR = 2026

class ProfileRulesTest {
    private fun p(f: UserProfile.() -> UserProfile = { this }) = UserProfile(fullName = "Maria Gonzalez").f()

    @Test fun ageRangeBucketsMatchTheServer() {
        val cases = mapOf(0 to "0-12", 12 to "0-12", 13 to "13-17", 17 to "13-17", 18 to "18-34", 34 to "18-34", 35 to "35-49", 49 to "35-49",
            50 to "50-64", 64 to "50-64", 65 to "65-79", 79 to "65-79", 80 to "80+", 105 to "80+")
        cases.forEach { (age, range) -> assertEquals("age $age", range, ProfileRules.ageRange(age)) }
        assertNull(ProfileRules.ageRange(null))
        // age = current year - birth year, never negative
        assertEquals(75, ProfileRules.ageOf(1951, NOW))
        assertEquals(0, ProfileRules.ageOf(2030, NOW))
        assertNull(ProfileRules.ageOf(null, NOW))
    }

    @Test fun flagsFollowTheServerRules() {
        assertEquals(emptyList<String>(), ProfileRules.flags(p(), NOW))
        assertEquals(listOf("oxygen"), ProfileRules.flags(p { copy(mobilityNeeds = setOf(MobilityNeed.OXYGEN_DEPENDENT)) }, NOW))
        for (n in listOf(MobilityNeed.WHEELCHAIR, MobilityNeed.CANNOT_WALK, MobilityNeed.WALKS_WITH_AID)) {
            assertEquals(listOf("mobility"), ProfileRules.flags(p { copy(mobilityNeeds = setOf(n)) }, NOW))
        }
        for (n in listOf(MobilityNeed.VISION_IMPAIRED, MobilityNeed.HEARING_IMPAIRED)) {
            assertEquals(listOf("sensory"), ProfileRules.flags(p { copy(mobilityNeeds = setOf(n)) }, NOW))
        }
        assertEquals(listOf("cognitive"), ProfileRules.flags(p { copy(mobilityNeeds = setOf(MobilityNeed.COGNITIVE)) }, NOW))
        assertEquals(emptyList<String>(), ProfileRules.flags(p { copy(mobilityNeeds = setOf(MobilityNeed.OTHER)) }, NOW))
        // medical = any condition, medication or allergy (server: staticFlags)
        assertEquals(listOf("medical"), ProfileRules.flags(p { copy(conditions = listOf("asthma")) }, NOW))
        assertEquals(listOf("medical"), ProfileRules.flags(p { copy(medications = listOf("insulin")) }, NOW))
        assertEquals(listOf("medical"), ProfileRules.flags(p { copy(allergies = listOf("penicillin")) }, NOW))
        assertEquals(emptyList<String>(), ProfileRules.flags(p { copy(bloodType = BloodType.O_POS) }, NOW))
    }

    @Test fun elderlyAndChildFromBirthYear() {
        assertEquals(listOf("elderly"), ProfileRules.flags(p { copy(birthYear = YEAR - 65) }, NOW))
        assertEquals(emptyList<String>(), ProfileRules.flags(p { copy(birthYear = YEAR - 64) }, NOW))
        assertEquals(listOf("child"), ProfileRules.flags(p { copy(birthYear = YEAR - 12) }, NOW))
        assertEquals(emptyList<String>(), ProfileRules.flags(p { copy(birthYear = YEAR - 13) }, NOW))
    }

    @Test fun flagsAreEmittedInServerOrderWithoutDuplicates() {
        val all = p {
            copy(birthYear = 1951, conditions = listOf("diabetes"),
                mobilityNeeds = setOf(MobilityNeed.WHEELCHAIR, MobilityNeed.WALKS_WITH_AID, MobilityNeed.OXYGEN_DEPENDENT, MobilityNeed.HEARING_IMPAIRED, MobilityNeed.COGNITIVE))
        }
        assertEquals(listOf("oxygen", "mobility", "medical", "sensory", "cognitive", "elderly"), ProfileRules.flags(all, NOW))
        assertEquals(listOf("oxygen", "mobility", "medical", "sensory", "cognitive", "elderly", "child"), ProfileRules.FLAG_ORDER)
    }

    @Test fun summaryHoldsOnlyNameAgeRangeFlagsAndVersion() {
        val s = ProfileRules.summary(p { copy(birthYear = 1951, phone = "+19725550142", homeAddress = "1 Main St", conditions = listOf("x"),
            emergencyContact = EmergencyContact("A", "+19725550177", "son"), notes = "secret") }, version = 3, nowMs = NOW)!!
        assertEquals(setOf("full_name", "age_range", "vulnerability_flags", "profile_version"), s.keys().asSequence().toSet())
        assertEquals("Maria Gonzalez", s.getString("full_name")); assertEquals("65-79", s.getString("age_range")); assertEquals(3, s.getInt("profile_version"))
        assertEquals(listOf("medical", "elderly"), (0 until s.getJSONArray("vulnerability_flags").length()).map { s.getJSONArray("vulnerability_flags").getString(it) })
        assertFalse(s.toString().contains("secret")); assertFalse(s.toString().contains("Main St")); assertFalse(s.toString().contains("555"))
    }

    @Test fun summaryOmitsUnknownFieldsAndNeedsAName() {
        val s = ProfileRules.summary(p(), 0, NOW)!!
        assertEquals(setOf("full_name", "profile_version"), s.keys().asSequence().toSet())
        assertEquals(0, s.getInt("profile_version"))
        assertNull(ProfileRules.summary(UserProfile(fullName = "  "), 0, NOW))
        assertEquals(ProfileRules.SUMMARY_NAME_MAX, ProfileRules.summary(UserProfile(fullName = "x".repeat(120)), 1, NOW)!!.getString("full_name").length)
    }

    // ---- validation limits (openapi.yaml) ----

    private fun err(profile: UserProfile) = ProfileRules.validate(profile, NOW)

    @Test fun nameIsTheOnlyRequiredField() {
        assertTrue(err(p()).isEmpty())
        assertEquals(ErrorKind.REQUIRED, err(UserProfile(fullName = "   "))["full_name"]!!.kind)
        assertTrue(err(UserProfile(fullName = "x".repeat(120))).isEmpty())
        assertEquals(ErrorKind.TOO_LONG, err(UserProfile(fullName = "x".repeat(121)))["full_name"]!!.kind)
        assertEquals(60, err(p { copy(preferredName = "x".repeat(61)) })["preferred_name"]!!.max)
    }

    @Test fun birthYearHeightAndHouseholdRanges() {
        assertTrue(err(p { copy(birthYear = 1900) }).isEmpty()); assertTrue(err(p { copy(birthYear = YEAR) }).isEmpty())
        assertEquals(ErrorKind.OUT_OF_RANGE, err(p { copy(birthYear = 1899) })["birth_year"]!!.kind)
        assertEquals(ErrorKind.OUT_OF_RANGE, err(p { copy(birthYear = YEAR + 1) })["birth_year"]!!.kind)
        assertTrue(err(p { copy(heightCm = 30) }).isEmpty()); assertTrue(err(p { copy(heightCm = 260) }).isEmpty())
        assertTrue("appearance.height_cm" in err(p { copy(heightCm = 29) })); assertTrue("appearance.height_cm" in err(p { copy(heightCm = 261) }))
        assertTrue("household.people_count" in err(p { copy(peopleCount = 0) })); assertTrue("household.people_count" in err(p { copy(peopleCount = 51) }))
        assertTrue(err(p { copy(peopleCount = 4, children = 4, elderly = 0) }).isEmpty())
        assertEquals(ErrorKind.EXCEEDS_PEOPLE, err(p { copy(peopleCount = 2, children = 3) })["household.children"]!!.kind)
        assertTrue("household.pets.0.count" in err(p { copy(pets = listOf(Pet("dog", 100))) }))
        assertTrue("household.pets.0.kind" in err(p { copy(pets = listOf(Pet("  ", 1))) }))
        assertTrue("household.pets" in err(p { copy(pets = List(11) { Pet("cat", 1) }) }))
    }

    @Test fun textAndListLimits() {
        assertTrue(err(p { copy(hair = "x".repeat(300), homeAddress = "y".repeat(300), mobilityNotes = "z".repeat(300), notes = "n".repeat(1000)) }).isEmpty())
        assertTrue("appearance.hair" in err(p { copy(hair = "x".repeat(301)) }))
        assertTrue("home_address" in err(p { copy(homeAddress = "y".repeat(301)) }))
        assertTrue("notes" in err(p { copy(notes = "n".repeat(1001)) }))
        assertTrue("mobility.notes" in err(p { copy(mobilityNotes = "z".repeat(301)) }))
        assertTrue(err(p { copy(conditions = List(20) { "c$it" }) }).isEmpty())
        assertEquals(ErrorKind.TOO_MANY, err(p { copy(conditions = List(21) { "c$it" }) })["medical.conditions"]!!.kind)
        assertTrue("medical.allergies" in err(p { copy(allergies = listOf("a".repeat(101))) }))
        assertTrue(err(p { copy(languages = List(8) { "es" }) }).isEmpty())
        assertTrue("languages" in err(p { copy(languages = List(9) { "es" }) }))
        assertTrue("languages" in err(p { copy(languages = listOf("e")) }))
    }

    @Test fun phoneAndEmergencyContact() {
        assertTrue(err(p { copy(phone = "+19725550142") }).isEmpty()); assertTrue(err(p { copy(phone = "972-555-0142") }).isEmpty())
        assertEquals(ErrorKind.BAD_PHONE, err(p { copy(phone = "call me") })["phone"]!!.kind)
        assertTrue("phone" in err(p { copy(phone = "12") }))
        assertTrue(err(p { copy(emergencyContact = EmergencyContact("Dan", "+19725550177", "son")) }).isEmpty())
        val bad = err(p { copy(emergencyContact = EmergencyContact("", "x", " ")) })
        assertEquals(setOf("emergency_contact.name", "emergency_contact.phone", "emergency_contact.relationship"), bad.keys)
    }

    @Test fun splitListTrimsAndDedupes() {
        assertEquals(listOf("a", "b", "c"), ProfileRules.splitList(" a, b ;c\n a ,,"))
        assertEquals(emptyList<String>(), ProfileRules.splitList("  "))
    }
}
