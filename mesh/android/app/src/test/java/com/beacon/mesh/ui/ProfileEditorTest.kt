package com.beacon.mesh.ui

import com.beacon.mesh.profile.BloodType
import com.beacon.mesh.profile.ErrorKind
import com.beacon.mesh.profile.MobilityNeed
import com.beacon.mesh.profile.ProfileStatus
import com.beacon.mesh.profile.SyncState
import com.beacon.mesh.ui.logic.PetForm
import com.beacon.mesh.ui.logic.ProfileChipKind
import com.beacon.mesh.ui.logic.ProfileEditor
import com.beacon.mesh.ui.logic.ProfileForm
import com.beacon.mesh.ui.logic.ProfileOnboardingLogic
import com.beacon.mesh.ui.logic.ProfileSection
import com.beacon.mesh.ui.logic.ProfileStatusLogic
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_794_000_000_000L

class ProfileEditorTest {
    private fun editor(form: ProfileForm = ProfileForm(), step: Int = 0, attempted: Boolean = false) = ProfileEditor(form, step, attempted) { NOW }

    @Test fun nameIsRequiredAndErrorsStayHiddenUntilTheFirstAttempt() {
        val e = editor()
        assertFalse(e.canSave())
        assertTrue(e.visibleErrors().isEmpty())
        assertFalse(e.next()) // cannot leave "About you" without a name
        assertEquals(0, e.step.value)
        assertEquals(ErrorKind.REQUIRED, e.visibleErrors()["full_name"]!!.kind)
        e.edit { it.copy(fullName = "Maria") }
        assertTrue(e.canSave())
        assertTrue(e.next()); assertEquals(1, e.step.value)
    }

    @Test fun movesThroughAllSectionsAndProgressGrows() {
        val e = editor(ProfileForm(fullName = "Maria"))
        var last = e.progress
        repeat(ProfileSection.entries.size - 1) { assertTrue(e.next()); assertTrue(e.progress > last); last = e.progress }
        assertTrue(e.isLast); assertEquals(1f, e.progress, 0f)
        assertFalse(e.next())
        assertTrue(e.back()); assertFalse(e.isLast)
        e.goTo(0); assertFalse(e.back())
    }

    @Test fun invalidOptionalFieldBlocksNextAndSaveAndJumpsToItsSection() {
        val e = editor(ProfileForm(fullName = "Maria", phone = "abc", height = "10"))
        assertTrue(e.next().not())
        assertEquals("phone", e.sectionErrors(ProfileSection.IDENTITY).keys.single())
        e.edit { it.copy(phone = "") }
        assertTrue(e.next()) // identity ok, now on appearance
        assertNull(e.trySave()) // height 10 is out of range
        assertEquals(ProfileSection.APPEARANCE.ordinal, e.step.value)
        assertTrue(e.attempted.value)
        assertEquals(ErrorKind.OUT_OF_RANGE, e.visibleErrors()["appearance.height_cm"]!!.kind)
        e.edit { it.copy(height = "170") }
        assertEquals(170, e.trySave()!!.heightCm)
    }

    @Test fun nonNumericNumbersAreErrorsNotSilentlyDropped() {
        val f = ProfileForm(fullName = "M", birthYear = "19x1", peopleCount = "two")
        val errs = f.errors(NOW)
        assertEquals(ErrorKind.BAD_NUMBER, errs["birth_year"]!!.kind)
        assertEquals(ErrorKind.BAD_NUMBER, errs["household.people_count"]!!.kind)
    }

    @Test fun formParsesIntoAProfile() {
        val f = ProfileForm(
            fullName = " Maria ", birthYear = "1951", languages = "es, en", phone = "+19725550142", height = "160",
            conditions = "diabetes, hypertension", bloodType = BloodType.O_POS, mobilityNeeds = setOf(MobilityNeed.WALKS_WITH_AID),
            peopleCount = "3", children = "1", pets = listOf(PetForm("dog", "1"), PetForm("", "")),
            contactName = "Dan", contactPhone = "+19725550177", contactRelationship = "son", notes = "n",
        )
        val p = f.parse(NOW).profile
        assertEquals(1951, p.birthYear); assertEquals(listOf("es", "en"), p.languages); assertEquals(listOf("diabetes", "hypertension"), p.conditions)
        assertEquals(1, p.pets.size) // blank pet row dropped
        assertEquals("Dan", p.emergencyContact!!.name)
        assertTrue(f.errors(NOW).isEmpty())
    }

    @Test fun emergencyContactIsAllOrNothing() {
        val partial = ProfileForm(fullName = "M", contactName = "Dan")
        val errs = partial.errors(NOW)
        assertEquals(setOf("emergency_contact.phone", "emergency_contact.relationship"), errs.keys)
        assertEquals(ProfileSection.CONTACT, ProfileSection.of(errs.keys.first()))
        assertNull(ProfileForm(fullName = "M").parse(NOW).profile.emergencyContact)
    }

    @Test fun draftSurvivesProcessDeathAsJson() {
        val f = ProfileForm(fullName = "Maria", birthYear = "19", bloodType = BloodType.AB_NEG, mobilityNeeds = setOf(MobilityNeed.COGNITIVE), pets = listOf(PetForm("cat", "2")), notes = "x")
        val back = ProfileForm.fromDraftJson(JSONObject(f.toDraftJson().toString()))
        assertEquals(f, back)
        // restored editor continues where it was
        val e = editor(back, step = 3, attempted = true)
        assertEquals(3, e.step.value); assertTrue(e.attempted.value); assertEquals("19", e.form.value.birthYear)
        assertEquals(ProfileSection.entries.size - 1, editor(step = 99).step.value) // out-of-range step is clamped
    }

    @Test fun skipIsAvailableInEveryState() {
        assertTrue(ProfileOnboardingLogic.canSkip(true)); assertTrue(ProfileOnboardingLogic.canSkip(false)); assertTrue(ProfileOnboardingLogic.canSkip())
        // the name is only needed to FINISH
        assertFalse(ProfileOnboardingLogic.canFinish(ProfileForm(), NOW))
        assertTrue(ProfileOnboardingLogic.canFinish(ProfileForm(fullName = "A"), NOW)) // a name alone is enough, also offline
    }

    @Test fun skipRecordsNothingAndLeavesSosUnaffected() {
        val repo = com.beacon.mesh.profile.ProfileRepository(com.beacon.mesh.profile.MemoryProfileStorage())
        repo.markStepDone()
        val r = repo.current
        assertTrue(r.stepDone); assertNull(r.profile); assertNull(r.consent); assertFalse(r.pendingErase)
        assertEquals(com.beacon.mesh.profile.SyncState.PENDING, r.syncState)
        // no profile -> no summary, so SOS payloads are exactly as before
        assertNull(r.profile?.let { com.beacon.mesh.profile.ProfileRules.summary(it, 0, NOW) })
    }

    @Test fun nudgeStatesAfterSkipAndWithAProfile() {
        val N = ProfileOnboardingLogic.Nudge.entries.associateBy { it.name }
        // skipped: nudge stays, prominent when the server requires a profile, never blocking
        assertEquals(N["PROMINENT"], ProfileOnboardingLogic.nudge(false, true, false, serverRequired = true))
        assertEquals(N["BANNER"], ProfileOnboardingLogic.nudge(false, true, false, serverRequired = false))
        // dismissed this session -> hidden; it is not persisted, so it returns on the next launch
        assertEquals(N["NONE"], ProfileOnboardingLogic.nudge(false, true, true, serverRequired = true))
        // name only -> small banner; complete -> none; mid-erasure -> none
        assertEquals(N["BANNER"], ProfileOnboardingLogic.nudge(true, true, false, serverRequired = true))
        assertEquals(N["NONE"], ProfileOnboardingLogic.nudge(true, false, false, serverRequired = true))
        assertEquals(N["NONE"], ProfileOnboardingLogic.nudge(false, true, false, serverRequired = true, erasing = true))
        val repo = com.beacon.mesh.profile.ProfileRepository(com.beacon.mesh.profile.MemoryProfileStorage())
        repo.dismissBanner()
        assertTrue(repo.bannerDismissedThisSession)
        assertFalse(com.beacon.mesh.profile.ProfileRepository(com.beacon.mesh.profile.MemoryProfileStorage()).bannerDismissedThisSession) // "next launch"
    }

    @Test fun statusChipFollowsSyncState() {
        fun s(state: SyncState, has: Boolean = true, erase: Boolean = false) = ProfileStatus(hasProfile = has, syncState = state, pendingErase = erase)
        assertEquals(ProfileChipKind.NONE, ProfileStatusLogic.chip(s(SyncState.PENDING, has = false)))
        assertEquals(ProfileChipKind.SYNCED, ProfileStatusLogic.chip(s(SyncState.SYNCED)))
        assertEquals(ProfileChipKind.PENDING, ProfileStatusLogic.chip(s(SyncState.PENDING)))
        assertEquals(ProfileChipKind.FAILED, ProfileStatusLogic.chip(s(SyncState.FAILED)))
        assertEquals(ProfileChipKind.CONSENT, ProfileStatusLogic.chip(s(SyncState.NEEDS_CONSENT)))
        assertEquals(ProfileChipKind.ERASING, ProfileStatusLogic.chip(s(SyncState.PENDING, has = false, erase = true)))
        assertNotNull(ProfileStatus.of(com.beacon.mesh.profile.ProfileRecord(), true, null))
    }
}
