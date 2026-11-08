package com.beacon.mesh.transport

import com.beacon.mesh.transport.PeerRegistry.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerRegistryTest {
    private val me = "11111111-1111-1111-1111-111111111111"
    private val peerA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    private val peerB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

    @Test fun acceptsNewPhone() {
        val r = PeerRegistry(me)
        assertEquals(Decision.Accept(peerA), r.identify("AA:01", peerA))
        assertEquals(1, r.count)
        assertEquals("AA:01", r.addressFor(peerA))
    }

    @Test fun samePhoneUnderRotatedAddressIsADuplicateNotAGhost() {
        val r = PeerRegistry(me)
        r.identify("AA:01", peerA)
        val d = r.identify("AA:02", peerA)
        assertEquals(Decision.Duplicate(peerA, "AA:01"), d)
        assertEquals(1, r.count)
        assertEquals("AA:01", r.addressFor(peerA))
        assertNull(r.idFor("AA:02"))
    }

    @Test fun identifyingTheSameLinkTwiceIsFine() {
        val r = PeerRegistry(me)
        r.identify("AA:01", peerA)
        assertTrue(r.identify("AA:01", peerA) is Decision.Accept)
        assertEquals(1, r.count)
    }

    @Test fun ownIdIsRecognisedCaseInsensitively() {
        val r = PeerRegistry(me)
        assertEquals(Decision.Self, r.identify("AA:09", me.uppercase()))
        assertEquals(0, r.count)
    }

    @Test fun twoDifferentPhonesCountSeparately() {
        val r = PeerRegistry(me)
        r.identify("AA:01", peerA)
        r.identify("BB:01", peerB)
        assertEquals(2, r.count)
        assertEquals(listOf(peerA, peerB), r.ids)
    }

    @Test fun releaseFreesThePhoneSoItCanReconnectOnANewAddress() {
        val r = PeerRegistry(me)
        r.identify("AA:01", peerA)
        assertEquals(peerA, r.release("AA:01"))
        assertEquals(0, r.count)
        assertTrue(r.identify("AA:02", peerA) is Decision.Accept)
    }

    @Test fun releasingADuplicateAddressDoesNotRemoveTheRealLink() {
        val r = PeerRegistry(me)
        r.identify("AA:01", peerA)
        r.identify("AA:02", peerA) // duplicate, never stored
        assertNull(r.release("AA:02"))
        assertEquals(1, r.count)
    }

    @Test fun legacyPeersKeyOnAddress() {
        val r = PeerRegistry(me)
        val id = PeerRegistry.legacyId("CC:01")
        assertEquals(Decision.Accept(id), r.identify("CC:01", id))
    }
}
