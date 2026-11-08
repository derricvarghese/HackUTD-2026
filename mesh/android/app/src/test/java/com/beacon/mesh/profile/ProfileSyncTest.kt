package com.beacon.mesh.profile

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.gateway.ProfileSync
import com.beacon.mesh.gateway.ProfileSyncOutcome
import com.beacon.mesh.net.BeaconApi
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.support.FakeHttp
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

private const val NOW0 = 1_794_000_000_000L
private const val DEVICE = "0192a000-0000-7000-8000-0000000000d1"
private const val PATH = "/v1/devices/$DEVICE/profile"

class ProfileSyncTest {
    private val signer = SoftwareSigner()
    private var now = NOW0
    private val http = FakeHttp()
    private val cfg = BackendConfig(MemoryKeyValueStore(), "", "")
    private val repo = ProfileRepository(MemoryProfileStorage())
    private val api = BeaconApi("https://example.test", http, RequestSigner(signer) { now }, cfg, Base64.getEncoder().encodeToString(signer.publicKeyDer), "0.3")
    private val sync = ProfileSync(api, repo, cfg, { now })
    private val consent = Consent("2026-11-v1", "2026-11-07T15:58:00Z")
    private val profile = UserProfile(fullName = "Maria Gonzalez", phone = "+19725550142")

    init {
        http.on("POST", "/v1/devices") { http.json(201, """{"id":"$DEVICE","sender_hash":"abc","created_at":"2026-11-07T00:00:00Z"}""") }
        cfg.update(com.beacon.mesh.backend.ServerInfo(null, null, null, com.beacon.mesh.protocol.HopLimits.DEFAULT, false, null, null, null, null, null, true, "2026-11-v1"), now)
    }

    private fun save(p: UserProfile = profile, c: Consent = consent) = repo.saveProfile(p, c, now)
    private fun putCalls() = http.callsTo("PUT", PATH)
    private fun full(version: Int) = """{"view":"full","device_id":"$DEVICE","profile_version":$version,"full_name":"Maria Gonzalez","vulnerability_flags":[]}"""
    private fun err(code: String, details: String? = null) = """{"code":"$code","message":"m"${details?.let { ",\"details\":$it" } ?: ""}}"""

    @Test fun firstSyncCreatesWithIfMatchZeroAndStoresVersion() {
        http.on("PUT", PATH) { http.json(201, full(1), mapOf("etag" to "\"1\"")) }
        save()
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
        val c = putCalls().single()
        assertEquals("0", c.headers["If-Match"])
        assertEquals(DEVICE, c.headers["X-Device-Id"]); assertTrue(c.headers.containsKey("X-Device-Signature"))
        val body = JSONObject(c.body)
        assertEquals("Maria Gonzalez", body.getString("full_name"))
        assertEquals("2026-11-v1", body.getJSONObject("consent").getString("version"))
        assertEquals(setOf("full_name", "phone", "consent"), body.keys().asSequence().toSet())
        assertEquals(SyncState.SYNCED, repo.current.syncState); assertEquals(1, repo.current.profileVersion)
        assertNull(repo.current.lastError); assertEquals(NOW0, repo.current.lastSyncedAtMs)
    }

    @Test fun editSendsLastAckedVersionAndReplacementUpdatesIt() {
        http.on("PUT", PATH) { http.json(if (it.headers["If-Match"] == "0") 201 else 200, full(if (it.headers["If-Match"] == "0") 1 else 2)) }
        save(); sync.run()
        save(profile.copy(notes = "key under pot"))
        assertEquals(SyncState.PENDING, repo.current.syncState)
        assertEquals(ProfileSyncOutcome.Synced(2), sync.run())
        assertEquals("1", putCalls().last().headers["If-Match"])
        assertEquals(2, repo.current.profileVersion)
    }

    @Test fun conflictFetchesCurrentVersionThenRetriesWithItLocalContentWins() {
        var n = 0
        http.on("PUT", PATH) { if (n++ == 0) http.json(409, err("conflict", """{"profile_version":5}""")) else http.json(200, full(6)) }
        http.on("GET", PATH) { http.json(200, full(5)) }
        save(profile.copy(notes = "mine"))
        assertEquals(ProfileSyncOutcome.Synced(6), sync.run())
        assertEquals(listOf("0", "5"), putCalls().map { it.headers["If-Match"] })
        assertEquals("mine", JSONObject(putCalls().last().body).getString("notes"))
        assertEquals(1, http.callsTo("GET", PATH).size)
        assertEquals(6, repo.current.profileVersion)
    }

    @Test fun conflictWhoseGetIs404CreatesAgain() {
        var n = 0
        http.on("PUT", PATH) { if (n++ == 0) http.json(409, err("conflict", """{"profile_version":2}""")) else http.json(201, full(1)) }
        http.on("GET", PATH) { http.json(404, err("not_found")) }
        repo.update { it.copy(profileVersion = 2) }
        save()
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
        assertEquals(listOf("2", "0"), putCalls().map { it.headers["If-Match"] })
    }

    @Test fun staleConsentRefreshesServerInfoAndAsksAgainThenSyncsWithTheNewVersion() {
        http.on("PUT", PATH) {
            if (JSONObject(it.body).getJSONObject("consent").getString("version") == "2026-12-v2") http.json(201, full(1))
            else http.json(422, err("validation_error", """{"fields":{"consent.version":"does not match"}}"""))
        }
        http.on("GET", "/v1/server-info") { http.json(200, """{"profile_required":true,"profile_consent_version":"2026-12-v2"}""") }
        // our cached consent version still looks current, so the 422 is how the change is discovered
        save()
        assertEquals(ProfileSyncOutcome.NeedsConsent, sync.run())
        assertEquals(SyncState.NEEDS_CONSENT, repo.current.syncState)
        assertEquals("2026-12-v2", cfg.profileConsentVersion)
        // paused: nothing is sent until the user re-consents
        val before = putCalls().size
        assertEquals(ProfileSyncOutcome.NeedsConsent, sync.run(force = true))
        assertEquals(before, putCalls().size)
        repo.acceptConsent(Consent("2026-12-v2", "2026-11-08T10:00:00Z"))
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run(force = true))
        assertEquals("2026-12-v2", JSONObject(putCalls().last().body).getJSONObject("consent").getString("version"))
    }

    @Test fun serverInfoWithNewerConsentPausesSyncBeforeAnyPut() {
        http.on("PUT", PATH) { http.json(201, full(1)) }
        save(); sync.run()
        cfg.update(com.beacon.mesh.backend.ServerInfo(null, null, null, com.beacon.mesh.protocol.HopLimits.DEFAULT, false, null, null, null, null, null, true, "2026-12-v2"), now)
        val puts = putCalls().size
        assertEquals(ProfileSyncOutcome.NeedsConsent, sync.run())
        assertEquals(SyncState.NEEDS_CONSENT, repo.current.syncState); assertEquals(puts, putCalls().size)
    }

    @Test fun unrelated422IsFailedAndNotRetriedUntilEditedOrForced() {
        http.on("PUT", PATH) { http.json(422, err("validation_error", """{"fields":{"phone":"bad"}}""")) }
        http.on("GET", "/v1/server-info") { http.json(200, """{"profile_consent_version":"2026-11-v1"}""") }
        save()
        assertEquals(ProfileSyncOutcome.Failed("rejected"), sync.run())
        assertEquals(SyncState.FAILED, repo.current.syncState)
        assertEquals(ProfileSyncOutcome.Deferred, sync.run())
        assertEquals(1, putCalls().size)
        save(profile.copy(phone = "+19725550143")) // an edit makes it eligible again
        http.on("PUT", PATH) { http.json(201, full(1)) }
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
    }

    @Test fun serverThatLostTheProfileGetsItAgainFromTheLocalCopy() {
        http.on("PUT", PATH) { http.json(if (it.headers["If-Match"] == "0") 201 else 200, full(1)) }
        save(); sync.run()
        repo.update { it.copy(profileVersion = 3) } // pretend we had reached v3
        http.on("GET", "/v1/devices/$DEVICE") { http.json(200, """{"id":"$DEVICE","profile_version":null}""") }
        now += ProfileSync.VERIFY_EVERY_MS + 1
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
        assertEquals("0", putCalls().last().headers["If-Match"]) // create-only
        assertEquals(1, repo.current.profileVersion)
    }

    @Test fun serverVersionBelowLocalTriggersReupload() {
        http.on("PUT", PATH) { http.json(200, full(5)) }
        save(); repo.update { it.copy(profileVersion = 4, syncState = SyncState.SYNCED) }
        http.on("GET", "/v1/devices/$DEVICE") { http.json(200, """{"id":"$DEVICE","profile_version":2}""") }
        assertEquals(ProfileSyncOutcome.Synced(5), sync.run())
        assertEquals("2", putCalls().single().headers["If-Match"])
    }

    @Test fun syncedAndCurrentOnlyVerifiesPeriodicallyWithoutSendingTheProfile() {
        http.on("PUT", PATH) { http.json(201, full(2)) }
        save(); sync.run()
        http.on("GET", "/v1/devices/$DEVICE") { http.json(200, """{"id":"$DEVICE","profile_version":2}""") }
        assertEquals(ProfileSyncOutcome.Idle, sync.run()) // verified a moment ago
        now += ProfileSync.VERIFY_EVERY_MS + 1
        assertEquals(ProfileSyncOutcome.Synced(2), sync.run())
        assertEquals(1, putCalls().size)
        assertEquals(1, http.callsTo("GET", "/v1/devices/$DEVICE").size)
    }

    @Test fun rateLimitBacksOffHonouringRetryAfter() {
        http.on("PUT", PATH) { http.json(429, err("rate_limited"), mapOf("retry-after" to "120")) }
        save()
        assertEquals(ProfileSyncOutcome.Failed("rate_limited"), sync.run())
        assertEquals(SyncState.PENDING, repo.current.syncState)
        assertEquals(NOW0 + 120_000, repo.current.nextAttemptAtMs)
        assertEquals(ProfileSyncOutcome.Deferred, sync.run())
        assertEquals(1, putCalls().size)
        now += 121_000
        http.on("PUT", PATH) { http.json(201, full(1)) }
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
        assertEquals(0, repo.current.attempts)
    }

    @Test fun offlineKeepsPendingWithExponentialBackoffAndRecovers() {
        http.networkDown = true
        save()
        assertEquals(ProfileSyncOutcome.Offline, sync.run())
        assertEquals(SyncState.PENDING, repo.current.syncState); assertEquals("offline", repo.current.lastError)
        assertEquals(NOW0 + 15_000, repo.current.nextAttemptAtMs)
        now += 16_000
        assertEquals(ProfileSyncOutcome.Offline, sync.run())
        assertEquals(now + 30_000, repo.current.nextAttemptAtMs)
        assertEquals(15_000L, ProfileSync.backoff(0)); assertEquals(60_000L, ProfileSync.backoff(2)); assertEquals(30 * 60_000L, ProfileSync.backoff(20))
        assertEquals(300_000L, ProfileSync.backoff(0, 300))
        http.networkDown = false
        http.on("PUT", PATH) { http.json(201, full(1)) }
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run(force = true))
        assertEquals(SyncState.SYNCED, repo.current.syncState)
    }

    @Test fun serverErrorMarksFailedButStillRetriesAutomatically() {
        http.on("PUT", PATH) { http.json(500, err("internal")) }
        save()
        assertEquals(ProfileSyncOutcome.Failed("server_error"), sync.run())
        assertEquals(SyncState.FAILED, repo.current.syncState)
        now += 20_000
        http.on("PUT", PATH) { http.json(201, full(1)) }
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
    }

    @Test fun editDuringUploadKeepsTheNewerDataPending() {
        http.on("PUT", PATH) { save(profile.copy(notes = "edited meanwhile")); http.json(201, full(1)) }
        save()
        assertEquals(ProfileSyncOutcome.Synced(1), sync.run())
        assertEquals(SyncState.PENDING, repo.current.syncState)
        assertEquals(1, repo.current.profileVersion)
        http.on("PUT", PATH) { http.json(200, full(2)) }
        assertEquals(ProfileSyncOutcome.Synced(2), sync.run())
        assertEquals("1", putCalls().last().headers["If-Match"])
    }

    @Test fun erasureIsRetriedUntilTheServerConfirms() {
        http.on("PUT", PATH) { http.json(201, full(1)) }
        save(); sync.run()
        repo.eraseLocal()
        assertNull(repo.current.profile); assertTrue(repo.current.pendingErase)
        http.networkDown = true
        assertEquals(ProfileSyncOutcome.Offline, sync.run())
        assertTrue(repo.current.pendingErase)
        http.networkDown = false
        http.on("DELETE", PATH) { http.json(204, "") }
        assertEquals(ProfileSyncOutcome.Erased, sync.run(force = true))
        assertFalse(repo.current.pendingErase)
        assertEquals(ProfileSyncOutcome.Idle, sync.run())
    }

    @Test fun erasureTreats404AsDone() {
        save(); repo.eraseLocal()
        http.on("DELETE", PATH) { http.json(404, err("not_found")) }
        assertEquals(ProfileSyncOutcome.Erased, sync.run())
    }

    @Test fun nothingToSyncWithoutAProfile() {
        assertEquals(ProfileSyncOutcome.Idle, sync.run())
        assertTrue(http.calls.isEmpty())
    }

    @Test fun profileContentNeverReachesTheLogCallback() {
        val lines = ArrayList<String>()
        val s = ProfileSync(api, repo, cfg, { now }, { lines.add(it) })
        http.on("PUT", PATH) { http.json(201, full(1)) }
        save(); s.run()
        assertTrue(lines.isNotEmpty())
        assertTrue(lines.none { it.contains("Maria") || it.contains("555") })
    }
}
