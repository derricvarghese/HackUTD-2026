package com.beacon.mesh.responder

import com.beacon.mesh.responder.RF.loginOk
import com.beacon.mesh.support.FakeHttp
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ResponderClientTest {
    private var nowMs = 1_000_000L
    private val http = FakeHttp()
    private val store = InMemorySessionStore()

    private fun client(s: SessionStore = store) =
        ResponderClient("https://srv.example/v1/", http, s, { nowMs }, UnconfinedTestDispatcher())

    private suspend fun expectKind(kind: ResponderException.Kind, block: suspend () -> Unit) {
        try { block(); fail("expected $kind") } catch (e: ResponderException) { assertEquals(kind, e.kind) }
    }

    @Test fun baseUrlIsNormalised() {
        assertEquals("https://srv.example", client().baseUrl)
    }

    @Test fun loginKeepsAccessTokenInMemoryAndPersistsOnlyTheRefreshToken() = runTest {
        http.loginOk()
        val c = client()
        val a = c.login("ana", "pw")
        assertEquals(ResponderAccount("r-1", "ana", "Ana", "responder"), a)
        val saved = store.load()!!
        assertEquals("ref1", saved.refreshToken)
        assertEquals(a, saved.account)
        val sent = JSONObject(http.calls.single().body)
        assertEquals("ana", sent.getString("username")); assertEquals("pw", sent.getString("password"))
        assertNull(http.calls.single().headers["Authorization"])
    }

    @Test fun badCredentialsOn401And422() = runTest {
        http.on("POST", "/v1/auth/login") { http.json(401, """{"code":"unauthorized","message":"no"}""") }
        expectKind(ResponderException.Kind.BAD_CREDENTIALS) { client().login("a", "b") }
        http.on("POST", "/v1/auth/login") { http.json(422, "{}") }
        expectKind(ResponderException.Kind.BAD_CREDENTIALS) { client().login("a", "") }
        assertNull(store.load())
    }

    @Test fun rateLimitedLoginIsDistinct() = runTest {
        http.on("POST", "/v1/auth/login") { http.json(429, "{}") }
        expectKind(ResponderException.Kind.RATE_LIMITED) { client().login("a", "b") }
    }

    @Test fun unreachableServerIsOffline() = runTest {
        http.networkDown = true
        expectKind(ResponderException.Kind.OFFLINE) { client().login("a", "b") }
    }

    @Test fun listSendsBearerAndQueryAndParsesUnknownFieldsAndSkipsBrokenItems() = runTest {
        http.loginOk()
        http.on("GET", "/v1/sos") { http.json(200, RF.page(RF.sos("s1", 90, exact = true), """{"id":"bad"}""", RF.sos("s2", 20, name = null))) }
        val c = client(); c.login("ana", "pw")
        val cases = c.openCases()
        assertEquals(listOf("s1", "s2"), cases.map { it.id })
        val call = http.callsTo("GET", "/v1/sos").single()
        assertEquals("Bearer acc1", call.headers["Authorization"])
        assertTrue(call.url.contains("status=reported,assigned,en_route,on_scene"))
        assertTrue(call.url.contains("sort=priority"))
        val first = cases[0]
        assertTrue(first.hasExactLocation); assertEquals(32.9912, first.lat, 1e-9)
        assertEquals("Elena", first.displayName)
        assertEquals(listOf("A1", "B7", "C3"), first.hop?.path)
        assertFalse(cases[1].hasExactLocation); assertEquals(32.995, cases[1].lat, 1e-9)
        assertNull(cases[1].displayName)
    }

    @Test fun a401TriggersExactlyOneRefreshAndRetryWithTheNewToken() = runTest {
        http.loginOk()
        var listCalls = 0
        http.on("GET", "/v1/sos") { call ->
            listCalls++
            if (call.headers["Authorization"] == "Bearer acc1") http.json(401, """{"code":"unauthorized","message":"expired"}""")
            else http.json(200, RF.page(RF.sos("s1")))
        }
        http.on("POST", "/v1/auth/refresh") { http.json(200, RF.tokens("acc2", "ref2")) }
        val c = client(); c.login("ana", "pw")
        assertEquals(1, c.openCases().size)
        assertEquals(2, listCalls)
        assertEquals(1, http.callsTo("POST", "/v1/auth/refresh").size)
        assertEquals("ref1", JSONObject(http.callsTo("POST", "/v1/auth/refresh").single().body).getString("refresh_token"))
        assertEquals("ref2", store.load()!!.refreshToken)
    }

    @Test fun expiredAccessTokenIsRefreshedBeforeTheCall() = runTest {
        http.loginOk()
        http.on("POST", "/v1/auth/refresh") { http.json(200, RF.tokens("acc2", "ref2")) }
        http.on("GET", "/v1/sos") { call -> assertEquals("Bearer acc2", call.headers["Authorization"]); http.json(200, RF.page()) }
        val c = client(); c.login("ana", "pw")
        nowMs += 900_000
        c.openCases()
        assertEquals(1, http.callsTo("POST", "/v1/auth/refresh").size)
    }

    @Test fun failedRefreshSignsOutAndClearsTheStore() = runTest {
        http.loginOk()
        http.on("GET", "/v1/sos") { http.json(401, "{}") }
        http.on("POST", "/v1/auth/refresh") { http.json(401, "{}") }
        val c = client(); c.login("ana", "pw")
        expectKind(ResponderException.Kind.SIGNED_OUT) { c.openCases() }
        assertNull(store.load()); assertNull(c.account)
        expectKind(ResponderException.Kind.SIGNED_OUT) { c.openCases() }
    }

    @Test fun aRestoredSessionHasNoAccessTokenSoItRefreshesFirst() = runTest {
        val s = InMemorySessionStore(StoredSession("refOld", ResponderAccount("r-1", "ana", "Ana", "responder")))
        http.on("POST", "/v1/auth/refresh") { http.json(200, RF.tokens("acc9", "refNew")) }
        http.on("GET", "/v1/sos") { call -> assertEquals("Bearer acc9", call.headers["Authorization"]); http.json(200, RF.page(RF.sos("s1"))) }
        val c = client(s)
        assertEquals("ana", c.account?.username)
        assertEquals(1, c.openCases().size)
        assertEquals("refNew", s.load()!!.refreshToken)
    }

    @Test fun claimConflictCarriesTheOtherResponderName() = runTest {
        http.loginOk()
        http.on("POST", "/v1/assignments") { http.json(409, """{"code":"conflict","message":"x","details":{"responder_name":"Sam"}}""") }
        val c = client(); c.login("ana", "pw")
        try { c.claim("s1"); fail() } catch (e: ResponderException) {
            assertEquals(ResponderException.Kind.ALREADY_CLAIMED, e.kind); assertEquals("Sam", e.detail)
        }
    }

    @Test fun claimConflictWithoutDetailsStillMapsTo409() = runTest {
        http.loginOk()
        http.on("POST", "/v1/assignments") { http.json(409, """{"code":"conflict","message":"x","details":{"assignment_id":"a"}}""") }
        val c = client(); c.login("ana", "pw")
        try { c.claim("s1"); fail() } catch (e: ResponderException) {
            assertEquals(ResponderException.Kind.ALREADY_CLAIMED, e.kind); assertNull(e.detail)
        }
    }

    @Test fun claimReturnsAssignmentIdAndSendsSosId() = runTest {
        http.loginOk()
        http.on("POST", "/v1/assignments") { http.json(201, """{"id":"as-1","sos_id":"s1","responder_id":"r-1","status":"assigned"}""") }
        val c = client(); c.login("ana", "pw")
        assertEquals("as-1", c.claim("s1"))
        assertEquals("s1", JSONObject(http.callsTo("POST", "/v1/assignments").single().body).getString("sos_id"))
    }

    @Test fun resolveSendsOutcomeAndVolunteerForbiddenMapsTo403() = runTest {
        http.loginOk()
        http.on("PATCH", "/v1/assignments/as-1") { call -> http.json(200, call.body) }
        val c = client(); c.login("ana", "pw")
        c.updateAssignment("as-1", "resolved", "rescued")
        val b = JSONObject(http.callsTo("PATCH", "/v1/assignments/as-1").single().body)
        assertEquals("resolved", b.getString("status")); assertEquals("rescued", b.getString("outcome"))
        http.on("POST", "/v1/assignments") { http.json(403, """{"code":"forbidden","message":"x"}""") }
        expectKind(ResponderException.Kind.FORBIDDEN) { c.claim("s1") }
    }

    @Test fun noteIsPatchedOntoTheCase() = runTest {
        http.loginOk()
        http.on("PATCH", "/v1/sos/s1") { http.json(200, RF.sos("s1")) }
        val c = client(); c.login("ana", "pw")
        c.addNote("s1", "gate code 42")
        assertEquals("gate code 42", JSONObject(http.callsTo("PATCH", "/v1/sos/s1").single().body).getString("note"))
    }

    @Test fun detailParsesTriageHistoryAndOnlyShowsFullProfileWhenPresent() = runTest {
        http.loginOk()
        val base = RF.sos("s1", 80, exact = true).dropLast(1)
        http.on("GET", "/v1/sos/s1") { http.json(200, base + """,
          "triage":{"score":80,"confidence":"high","summary":"Critical","reasons":[{"source":"rule","text":"Trapped","weight":60},{"source":"llm","text":"Oxygen"}],"unknown":1},
          "checkins":[{"id":"k1","sos_id":"s1","sent_at":"2026-11-07T16:30:00Z","responded_at":null,"missed":true,"attempt":2}],
          "events":[{"id":"e1","type":"assigned","actor":{"kind":"responder"},"at":"2026-11-07T16:31:00Z"}],
          "notes":[{"responder_id":"r-1","text":"hi","created_at":"2026-11-07T16:32:00Z"}],
          "profile_full":{"view":"full","full_name":"Maria","phone":"+15550100","medical":{"conditions":["diabetes"],"medications":[]},"emergency_contact":{"name":"Dan","phone":"+15550101","relationship":"son"}}}""") }
        http.on("GET", "/v1/sos/s2") { http.json(200, RF.sos("s2")) }
        val c = client(); c.login("ana", "pw")
        val d = c.caseDetail("s1")
        assertEquals(listOf("Trapped", "Oxygen"), d.reasons.map { it.text }); assertEquals(60, d.reasons[0].weight); assertNull(d.reasons[1].weight)
        assertTrue(d.checkins.single().missed); assertEquals("assigned", d.events.single().type); assertEquals("hi", d.notes.single().text)
        assertEquals("+15550100", d.profileFull?.phone); assertEquals(listOf("diabetes"), d.profileFull?.conditions); assertEquals("son", d.profileFull?.contactRelationship)
        assertNull(c.caseDetail("s2").profileFull)
    }

    @Test fun logoutWipesLocalStateEvenWhenTheServerCallFails() = runTest {
        http.loginOk()
        http.on("POST", "/v1/auth/logout") { http.json(500, "{}") }
        val c = client(); c.login("ana", "pw")
        c.logout()
        assertNull(store.load()); assertNull(c.account)
        assertNotNull(http.callsTo("POST", "/v1/auth/logout").singleOrNull())
        expectKind(ResponderException.Kind.SIGNED_OUT) { c.openCases() }
    }

    @Test fun serverErrorsAreGeneric() = runTest {
        http.loginOk()
        http.on("GET", "/v1/sos") { http.json(503, "<html>") }
        val c = client(); c.login("ana", "pw")
        try { c.openCases(); fail() } catch (e: ResponderException) { assertEquals(ResponderException.Kind.SERVER, e.kind); assertEquals(503, e.code) }
    }
}
