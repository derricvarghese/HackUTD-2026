package com.beacon.mesh.responder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffTest {
    @Test fun doublesUpToTheCapAndResets() {
        val b = Backoff(1_000, 30_000)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), List(7) { b.next() })
        b.reset()
        assertEquals(1_000L, b.next())
    }

    @Test fun neverOverflowsAfterManyAttempts() {
        val b = Backoff()
        repeat(200) { assertTrue(b.next() in 1_000L..30_000L) }
    }

    @Test fun wsUrlSwitchesSchemeAndEncodesTheToken() {
        assertEquals("wss://h.example/v1/ws?token=a.b-c", LiveEvents.url("https://h.example/", "a.b-c"))
        assertEquals("ws://10.0.2.2:3000/v1/ws?token=a%2Bb", LiveEvents.url("http://10.0.2.2:3000", "a+b"))
    }

    @Test fun onlyCaseAffectingEventsAreRelevant() {
        listOf("sos.created", "sos.updated", "sos.merged", "sos.silent", "assignment.created", "assignment.updated",
            "checkin.sent", "checkin.responded", "profile.updated", "heartbeat.silent", "heartbeat.resumed")
            .forEach { assertTrue(it, LiveEvents.relevant(it)) }
        listOf("pong", "mesh.stats", "deadzones.updated", "images.added", "gateway.synced", "")
            .forEach { assertTrue(it, !LiveEvents.relevant(it)) }
    }
}
