package com.beacon.mesh.responder

import com.beacon.mesh.responder.RF.loginOk
import com.beacon.mesh.support.FakeHttp
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeSocket(val url: String, val listener: LiveListener) : LiveSocket {
    var closed = false
    override fun close() { closed = true }
}

private class FakeSockets : LiveSocketFactory {
    val opened = ArrayList<FakeSocket>()
    override fun open(url: String, listener: LiveListener): LiveSocket = FakeSocket(url, listener).also { opened.add(it) }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ResponderControllerTest {
    private val http = FakeHttp()
    private val sockets = FakeSockets()

    private fun TestScope.controller(): ResponderController {
        val client = ResponderClient("https://srv.example", http, InMemorySessionStore(), { 1_000_000L }, StandardTestDispatcher(testScheduler))
        return ResponderController(backgroundScope, client, sockets, Backoff())
    }

    private fun listing(vararg items: String) = { _: FakeHttp.Call -> http.json(200, RF.page(*items)) }

    @Test fun loginLoadsOpenCasesAndStartsSignedIn() = runTest {
        http.loginOk()
        http.on("GET", "/v1/sos", listing(RF.sos("a", 10), RF.sos("b", 90)))
        val c = controller()
        assertTrue(c.login("ana", "pw"))
        val s = c.state.value
        assertEquals("ana", s.account?.username); assertEquals(2, s.cases.size); assertTrue(s.loaded); assertNull(s.error); assertFalse(s.busy)
    }

    @Test fun wrongPasswordKeepsSignedOutWithAnError() = runTest {
        http.on("POST", "/v1/auth/login") { http.json(401, "{}") }
        val c = controller()
        assertFalse(c.login("ana", "bad"))
        assertNull(c.state.value.account)
        assertEquals(ResponderException.Kind.BAD_CREDENTIALS, c.state.value.error?.kind)
    }

    @Test fun activatingOpensTheSocketWithAWsUrlAndGoesLive() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw")
        c.setActive(true); runCurrent()
        assertEquals(Connection.CONNECTING, c.state.value.connection)
        val url = sockets.opened.single().url
        assertTrue(url, url.startsWith("wss://srv.example/v1/ws?token=acc1"))
        sockets.opened.single().listener.onOpen(); runCurrent()
        assertEquals(Connection.LIVE, c.state.value.connection)
    }

    @Test fun eventsTriggerADebouncedCatchUpUsingUpdatedSinceAndMergeTheResult() = runTest {
        http.loginOk()
        http.on("GET", "/v1/sos") { call ->
            if (call.url.contains("updated_since=")) http.json(200, RF.page(RF.sos("a", 99, updated = "2026-11-07T16:05:00Z"), RF.sos("b", status = "resolved"), RF.sos("n", 40)))
            else http.json(200, RF.page(RF.sos("a", 10), RF.sos("b", 20)))
        }
        val c = controller(); c.login("ana", "pw")
        c.setActive(true); runCurrent()
        val ws = sockets.opened.single().listener
        ws.onOpen(); advanceTimeBy(1_000); runCurrent()
        // The catch-up on socket open already advanced the cursor to the newest updated_at (16:05).
        http.calls.clear()
        // Burst of events -> one catch-up after the debounce window.
        ws.onEvent("sos.updated"); ws.onEvent("assignment.updated"); ws.onEvent("mesh.stats"); ws.onEvent("pong")
        advanceTimeBy(ResponderController.DEBOUNCE_MS + 50); runCurrent()
        val since = http.callsTo("GET", "/v1/sos")
        assertEquals(1, since.size)
        val url = since.single().url
        assertTrue(url, url.contains("updated_since=2026-11-07T16%3A04%3A59.000Z"))
        assertFalse("catch-up must not filter by status or finished cases would never be dropped", url.contains("status="))
        assertEquals(setOf("a", "n"), c.state.value.cases.map { it.id }.toSet())
        assertEquals(99, c.state.value.cases.first { it.id == "a" }.score)
    }

    @Test fun irrelevantEventsDoNotRefetch() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        sockets.opened.single().listener.onOpen(); advanceTimeBy(1_000); runCurrent()
        http.calls.clear()
        sockets.opened.single().listener.onEvent("mesh.stats"); sockets.opened.single().listener.onEvent("deadzones.updated")
        advanceTimeBy(2_000); runCurrent()
        assertTrue(http.callsTo("GET", "/v1/sos").isEmpty())
    }

    @Test fun droppedSocketReconnectsWithGrowingBackoffAndCatchesUpOnEveryReopen() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        sockets.opened[0].listener.onOpen(); runCurrent()
        // Drop #1: reconnect after 1 s.
        sockets.opened[0].listener.onClosed(); runCurrent()
        assertEquals(Connection.RECONNECTING, c.state.value.connection)
        advanceTimeBy(999); runCurrent(); assertEquals(1, sockets.opened.size)
        advanceTimeBy(2); runCurrent(); assertEquals(2, sockets.opened.size)
        assertTrue(sockets.opened[0].closed)
        // Reconnect fails to open (no onOpen) and drops again: backoff doubles to 2 s.
        sockets.opened[1].listener.onClosed(); runCurrent()
        advanceTimeBy(1_999); runCurrent(); assertEquals(2, sockets.opened.size)
        advanceTimeBy(2); runCurrent(); assertEquals(3, sockets.opened.size)
        // Opens fine: LIVE again, backoff resets, and a catch-up request goes out.
        http.calls.clear()
        sockets.opened[2].listener.onOpen(); advanceTimeBy(ResponderController.DEBOUNCE_MS + 50); runCurrent()
        assertEquals(Connection.LIVE, c.state.value.connection)
        assertEquals(1, http.callsTo("GET", "/v1/sos").size)
        sockets.opened[2].listener.onClosed(); runCurrent()
        advanceTimeBy(1_001); runCurrent(); assertEquals(4, sockets.opened.size)
    }

    @Test fun whileTheSocketIsDownTheListPollsEvery15Seconds() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        http.calls.clear()
        advanceTimeBy(ResponderController.POLL_MS + 10); runCurrent()
        assertTrue(http.callsTo("GET", "/v1/sos").isNotEmpty())
    }

    @Test fun deactivatingClosesTheSocketAndStopsPolling() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        sockets.opened[0].listener.onOpen(); runCurrent()
        c.setActive(false); runCurrent()
        assertTrue(sockets.opened[0].closed)
        assertEquals(Connection.IDLE, c.state.value.connection)
        http.calls.clear()
        advanceTimeBy(300_000); runCurrent()
        assertTrue(http.calls.isEmpty()); assertEquals(1, sockets.opened.size)
    }

    @Test fun claimThenRefreshReturnsExactLocation() = runTest {
        http.loginOk()
        var claimed = false
        http.on("GET", "/v1/sos") { http.json(200, RF.page(RF.sos("a", 50, exact = claimed, assignee = if (claimed) "r-1" else null, status = if (claimed) "assigned" else "reported"))) }
        http.on("POST", "/v1/assignments") { claimed = true; http.json(201, """{"id":"as-a","status":"assigned"}""") }
        val c = controller(); c.login("ana", "pw")
        val before = c.state.value.cases.single(); assertFalse(before.hasExactLocation)
        assertTrue(c.claim(before))
        val after = c.state.value.cases.single()
        assertTrue(after.hasExactLocation); assertTrue(after.isMine(c.state.value.account))
        assertFalse(c.state.value.busy)
    }

    @Test fun claimConflictSurfacesAsAnErrorAndStillRefreshes() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        http.on("POST", "/v1/assignments") { http.json(409, """{"code":"conflict","message":"x","details":{"responder_name":"Sam"}}""") }
        val c = controller(); c.login("ana", "pw")
        assertFalse(c.claim(c.state.value.cases.single()))
        assertEquals(ResponderException.Kind.ALREADY_CLAIMED, c.state.value.error?.kind)
        assertEquals("Sam", c.state.value.error?.detail)
        assertEquals(1, c.state.value.cases.size)
        c.clearError(); assertNull(c.state.value.error)
    }

    @Test fun advanceNeedsAnAssignmentId() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw")
        assertFalse(c.advance(c.state.value.cases.single(), "en_route"))
        assertTrue(http.callsTo("PATCH", "/v1/assignments/as-a").isEmpty())
    }

    @Test fun anExpiredSessionSignsOutClearsCasesAndStopsLive() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        sockets.opened[0].listener.onOpen(); runCurrent()
        http.on("GET", "/v1/sos") { http.json(401, "{}") }
        http.on("POST", "/v1/auth/refresh") { http.json(401, "{}") }
        c.fullRefresh()
        val s = c.state.value
        assertNull(s.account); assertTrue(s.cases.isEmpty()); assertEquals(ResponderException.Kind.SIGNED_OUT, s.error?.kind)
        runCurrent()
        assertEquals(Connection.IDLE, s.connection.takeIf { true } ?: Connection.IDLE)
    }

    @Test fun logoutClearsEverything() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        http.on("POST", "/v1/auth/logout") { http.json(204, "") }
        val c = controller(); c.login("ana", "pw"); c.setActive(true); runCurrent()
        c.logout(); runCurrent()
        assertEquals(ResponderState(), c.state.value)
        assertNotNull(http.callsTo("POST", "/v1/auth/logout").singleOrNull())
    }

    @Test fun offlineKeepsLastKnownCasesAndShowsAnError() = runTest {
        http.loginOk(); http.on("GET", "/v1/sos", listing(RF.sos("a")))
        val c = controller(); c.login("ana", "pw")
        http.networkDown = true
        c.fullRefresh()
        assertEquals(1, c.state.value.cases.size)
        assertEquals(ResponderException.Kind.OFFLINE, c.state.value.error?.kind)
        http.networkDown = false
        c.fullRefresh()
        assertNull(c.state.value.error)
    }
}
