package com.beacon.mesh.identity

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.heartbeat.Heartbeat
import com.beacon.mesh.support.FakeBackendKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeTransport : TransportIdentity {
    val calls = ArrayList<String>()
    var id = "old-instance"
    override fun regenerateInstanceId(): String { calls.add("regenerate"); id = "new-instance"; return id }
    override fun forgetPeers() { calls.add("forget") }
}

class IdentityResetTest {
    private val keys = FakeBackendKeys()
    private val signer = SoftwareSigner()
    private val kv = MemoryKeyValueStore()
    private val config = BackendConfig(kv, keys.encPublicB64, keys.signPublicB64)
    private val prefs = MemoryKeyValueStore()
    private val transport = FakeTransport()
    private var welfareCancelled = 0
    private var profileReset = 0
    private var newKeyB64: String? = null
    private val reset = IdentityReset(signer, config, transport, prefs, { welfareCancelled++ }, { profileReset++ }, { newKeyB64 = it })

    @Test fun replacesKeyClearsRegistrationAndResetsCounters() {
        config.deviceId = "0192a000-0000-7000-8000-0000000000d1"
        config.outboxCursor = "2026-11-07T00:00:00.000Z"
        prefs.putLong(Heartbeat.KEY_SEQ, 42); prefs.putLong(Heartbeat.KEY_LAST, 123)
        val oldKey = signer.publicKeyDer.copyOf()

        val r = reset.reset()

        assertFalse(oldKey.contentEquals(signer.publicKeyDer))
        assertEquals(java.util.Base64.getEncoder().encodeToString(signer.publicKeyDer), newKeyB64)
        assertNull(config.deviceId); assertNull(config.outboxCursor)
        assertEquals(0, prefs.getLong(Heartbeat.KEY_SEQ)); assertEquals(0, prefs.getLong(Heartbeat.KEY_LAST))
        assertEquals(1, welfareCancelled); assertEquals(1, profileReset)
        assertEquals(listOf("forget", "regenerate"), transport.calls)
        assertEquals("new-instance", transport.id)
        assertEquals("0192a000", r.oldShortId)
        assertEquals(IdentityReset.fingerprint(signer.publicKeyDer).take(8), r.newShortId)
        assertNotEquals(r.oldShortId, r.newShortId)
        assertEquals(8, r.newShortId.length)
    }

    @Test fun shortIdUsesTheKeyFingerprintBeforeRegistration() {
        val der = signer.publicKeyDer
        assertEquals(IdentityReset.fingerprint(der).take(8), IdentityReset.shortId(null, der))
        assertEquals("abcdef12", IdentityReset.shortId("abcdef12-0000", der))
        val r = reset.reset()
        assertEquals(IdentityReset.shortId(null, signer.publicKeyDer), r.newShortId)
    }

    @Test fun twoResetsGiveTwoDifferentIdentities() {
        val a = reset.reset().newShortId
        val b = reset.reset().newShortId
        assertNotEquals(a, b)
        assertTrue(welfareCancelled == 2)
    }

    @Test fun cachedServerInfoSurvivesTheReset() {
        // keys and hop table are the backend's, not ours
        reset.reset()
        assertEquals(keys.encPublicB64, config.encryptionKey)
    }
}
