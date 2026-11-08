package com.beacon.mesh.responder

import com.beacon.mesh.responder.RF.loginOk
import com.beacon.mesh.support.FakeHttp
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LocationSharerTest {
    private class FakeSink : LocationSink {
        val sent = ArrayList<Pair<Double, Double>>()
        var clears = 0
        var sendResults = ArrayDeque<ShareResult>()
        var clearResults = ArrayDeque<ShareResult>()
        override suspend fun send(lat: Double, lng: Double): ShareResult {
            sent.add(lat to lng); return sendResults.removeFirstOrNull() ?: ShareResult.OK
        }
        override suspend fun clear(): ShareResult { clears++; return clearResults.removeFirstOrNull() ?: ShareResult.OK }
    }

    private val sink = FakeSink()
    private var online = true
    // ~0.0003 degrees of latitude is about 33 m; 0.0001 is about 11 m.
    private val base = 32.99 to -96.75

    private fun TestScope.sharer() = LocationSharer(backgroundScope, sink, { testScheduler.currentTime }, { online }).also { it.start() }

    @Test fun firstFixIsSentAtOnce() = runTest {
        val s = sharer(); s.onFix(base.first, base.second); runCurrent()
        assertEquals(1, sink.sent.size); assertTrue(s.state.value.lastSentAtMs != null)
    }

    @Test fun smallMovesAreHeldUntilSixtySecondsThenSent() = runTest {
        val s = sharer(); s.onFix(base.first, base.second); runCurrent()
        advanceTimeBy(15_000); s.onFix(base.first + 0.0001, base.second); runCurrent()
        advanceTimeBy(20_000); s.onFix(base.first + 0.0001, base.second); runCurrent()
        assertEquals(1, sink.sent.size)
        advanceTimeBy(30_000); runCurrent()          // 65 s since the first send: the held fix goes out on the timer
        assertEquals(2, sink.sent.size)
    }

    @Test fun movingTwentyFiveMetresSendsButNeverBeforeTenSeconds() = runTest {
        val s = sharer(); s.onFix(base.first, base.second); runCurrent()
        advanceTimeBy(3_000); s.onFix(base.first + 0.0003, base.second); runCurrent()
        assertEquals("too soon", 1, sink.sent.size)
        advanceTimeBy(7_001); runCurrent()
        assertEquals(2, sink.sent.size)
        assertEquals(base.first + 0.0003, sink.sent[1].first, 1e-12)
    }

    @Test fun onlyTheNewestFixIsKeptWhileWaiting() = runTest {
        val s = sharer(); s.onFix(base.first, base.second); runCurrent()
        advanceTimeBy(2_000)
        s.onFix(base.first + 0.001, base.second); s.onFix(base.first + 0.002, base.second); s.onFix(base.first + 0.003, base.second); runCurrent()
        advanceTimeBy(9_000); runCurrent()
        assertEquals(2, sink.sent.size)
        assertEquals(base.first + 0.003, sink.sent[1].first, 1e-12)
    }

    @Test fun offlineSendsNothingThenSendsOnlyTheLatestWhenBack() = runTest {
        val s = sharer(); online = false
        s.onFix(1.0, 1.0); s.onFix(2.0, 2.0); runCurrent()
        advanceTimeBy(40_000); runCurrent()
        assertTrue(sink.sent.isEmpty())
        online = true
        advanceTimeBy(LocationSharer.OFFLINE_RECHECK_MS + 1); runCurrent()
        assertEquals(listOf(2.0 to 2.0), sink.sent)
    }

    @Test fun failuresBackOffExponentiallyAndRecover() = runTest {
        sink.sendResults.addAll(listOf(ShareResult.RETRY, ShareResult.RETRY, ShareResult.OK))
        val s = sharer(); s.onFix(5.0, 5.0); runCurrent()
        assertEquals(1, sink.sent.size); assertTrue(s.state.value.failing)
        advanceTimeBy(9_999); runCurrent(); assertEquals(1, sink.sent.size)
        advanceTimeBy(2); runCurrent(); assertEquals("after 10 s", 2, sink.sent.size)
        advanceTimeBy(19_000); runCurrent(); assertEquals("20 s backoff not over", 2, sink.sent.size)
        advanceTimeBy(1_001); runCurrent(); assertEquals(3, sink.sent.size)
        assertFalse(s.state.value.failing)
        assertEquals(listOf(10_000L, 20_000L, 40_000L, 80_000L, 120_000L, 120_000L), List(6) { LocationSharer.backoff(it + 1) })
    }

    @Test fun fatalResultStopsSharing() = runTest {
        sink.sendResults.add(ShareResult.FATAL)
        val s = sharer(); s.onFix(1.0, 1.0); runCurrent()
        assertFalse(s.state.value.armed)
        s.onFix(2.0, 2.0); advanceTimeBy(100_000); runCurrent()
        assertEquals(1, sink.sent.size)
    }

    @Test fun stopWithClearRetriesUntilTheServerAccepts() = runTest {
        val s = sharer(); s.onFix(1.0, 1.0); runCurrent()
        sink.clearResults.addAll(listOf(ShareResult.RETRY, ShareResult.RETRY, ShareResult.OK))
        s.stop(clearRemote = true); runCurrent()
        assertEquals(1, sink.clears); assertTrue(s.state.value.clearing)
        advanceTimeBy(10_001); runCurrent(); assertEquals(2, sink.clears)
        advanceTimeBy(20_001); runCurrent(); assertEquals(3, sink.clears)
        assertFalse(s.state.value.clearing)
        advanceTimeBy(200_000); runCurrent(); assertEquals(3, sink.clears)
        s.onFix(9.0, 9.0); runCurrent(); assertEquals("no sends after stop", 1, sink.sent.size)
    }

    @Test fun abandonStopsTheClearLoopWhenSignedOut() = runTest {
        val s = sharer(); s.onFix(1.0, 1.0); runCurrent()
        sink.clearResults.addAll(List(10) { ShareResult.RETRY })
        s.stop(true); runCurrent(); assertEquals(1, sink.clears)
        s.abandon(); advanceTimeBy(300_000); runCurrent()
        assertEquals(1, sink.clears); assertEquals(ShareState(), s.state.value)
    }

    @Test fun fatalClearEndsTheLoop() = runTest {
        val s = sharer(); s.onFix(1.0, 1.0); runCurrent()
        sink.clearResults.add(ShareResult.FATAL)
        s.stop(true); runCurrent(); advanceTimeBy(100_000); runCurrent()
        assertEquals(1, sink.clears)
    }

    @Test fun neverArmedNeverClears() = runTest {
        val s = LocationSharer(backgroundScope, sink, { 0L }, { true })
        s.stop(true); runCurrent()
        assertEquals(0, sink.clears)
    }

    @Test fun distanceIsRoughlyRight() {
        val d = LocationSharer.distanceM(32.0 to -96.0, 32.0003 to -96.0)
        assertEquals(33.4, d, 0.5)
    }

    // ---- client bodies ----
    @Test fun clientPatchesLocationAvailabilityAndNull() = runTest {
        val http = FakeHttp(); http.loginOk()
        http.on("PATCH", "/v1/responders/r-1") { http.json(200, RF.tokens().let { """{"id":"r-1","username":"a","name":"A","role":"responder"}""" }) }
        val c = ResponderClient("https://x.example", http, InMemorySessionStore(), { 1L }, StandardTestDispatcher(testScheduler))
        c.login("a", "b")
        c.shareLocation(1.5, 2.5); c.clearLocation(); c.setAvailable(true)
        val bodies = http.callsTo("PATCH", "/v1/responders/r-1").map { JSONObject(it.body) }
        assertEquals(2.5, bodies[0].getJSONObject("location").getDouble("lng"), 0.0)
        assertTrue(bodies[1].has("location") && bodies[1].isNull("location"))
        assertTrue(bodies[2].getBoolean("available"))
    }
}
