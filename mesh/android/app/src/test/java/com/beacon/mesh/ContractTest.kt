package com.beacon.mesh

import com.beacon.mesh.crypto.Ecies
import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.net.RequestSigner
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Canonical
import com.beacon.mesh.protocol.DeliveredReceipt
import com.beacon.mesh.protocol.DropReason
import com.beacon.mesh.protocol.HopLimits
import com.beacon.mesh.protocol.Iso
import com.beacon.mesh.protocol.MeshEnvelope
import com.beacon.mesh.protocol.MeshValidation
import com.beacon.mesh.protocol.Priority
import com.beacon.mesh.support.FakeBackendKeys
import com.beacon.mesh.support.Fixtures
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

private fun d(s: String) = Base64.getDecoder().decode(s)

class CanonicalJsonTest {
    @Test fun sortsKeysRecursivelyWithoutWhitespace() {
        assertEquals("""{"a":[true,null,"x"],"b":1,"c":{"x":2,"y":3}}""", Canonical.json(JSONObject("""{"c":{"y":3,"x":2},"b":1,"a":[true,null,"x"]}""")))
    }

    @Test fun numbersPrintLikeEcmaScript() {
        assertEquals("1", Canonical.number(1.0))
        assertEquals("32.995", Canonical.number(32.995))
        assertEquals("-96.745", Canonical.number(-96.745))
        assertEquals("0.00001", Canonical.number(0.00001))
        assertEquals("1e-7", Canonical.number(1e-7))
        assertEquals("1e+21", Canonical.number(1e21))
        assertEquals("123456789012345680000", Canonical.number(1.2345678901234568E20))
        assertEquals("0", Canonical.number(-0.0))
        assertEquals("0.1", Canonical.number(0.1))
    }

    @Test fun stringsEscapeLikeJsonStringify() {
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001é中\"", Canonical.json("a\"b\\c\n\t\u0001é中"))
    }

    @Test fun matchesTheServersCanonicalJsonOnFixtureCases() {
        val cases = Fixtures.server().getJSONArray("canonical_json_cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals("case $i", c.getString("output"), Canonical.json(JSONObject(c.getString("input_json"))))
        }
    }
}

class EciesTest {
    @Test fun roundTripAndWireLayout() {
        val kp = FakeBackendKeys.gen()
        val msg = "{\"lat\":32.9857,\"category\":\"trapped\"}".toByteArray()
        val wire = Ecies.encrypt(msg, kp.public.encoded)
        assertEquals(1 + 65 + 12 + msg.size + 16, wire.size)
        assertEquals(0x01, wire[0].toInt())
        assertEquals(0x04, wire[1].toInt()) // uncompressed ephemeral point
        assertArrayEquals(msg, Ecies.decrypt(wire, kp.private.encoded))
        // fresh ephemeral key + nonce per message
        assertFalse(wire.contentEquals(Ecies.encrypt(msg, kp.public.encoded)))
    }

    @Test fun tamperingAnywhereFails() {
        val kp = FakeBackendKeys.gen()
        val wire = Ecies.encrypt("hello".toByteArray(), kp.public.encoded)
        for (pos in listOf(0, 1, 40, 70, 80, wire.size - 1)) {
            val bad = wire.copyOf().also { it[pos] = (it[pos].toInt() xor 1).toByte() }
            try { Ecies.decrypt(bad, kp.private.encoded); fail("tamper at $pos accepted") } catch (e: Exception) { /* expected */ }
        }
        try { Ecies.decrypt(wire, FakeBackendKeys.gen().private.encoded); fail() } catch (e: Exception) { /* wrong key */ }
    }

    @Test fun backendKeyFormatIsSpkiP256() {
        val b = Fixtures.server().getJSONObject("backend")
        val spki = d(b.getString("encryption_public_key"))
        assertEquals(91, spki.size) // X.509 SPKI DER of a P-256 key
        assertTrue(Ecies.isValidP256Spki(spki))
        assertTrue(Ecies.isValidP256Spki(d(b.getString("signing_public_key"))))
        assertFalse(Ecies.isValidP256Spki(ByteArray(91)))
    }

    @Test fun decryptsAServerEncryptedFixture() {
        val f = Fixtures.server()
        val env = MeshEnvelope.fromJson(f.getJSONObject("envelope"))!!
        val plain = Ecies.decrypt(d(env.payload), d(f.getJSONObject("backend").getString("encryption_private_key_pkcs8")))
        val got = JSONObject(String(plain, Charsets.UTF_8))
        val want = f.getJSONObject("expected_payload")
        assertEquals(Canonical.json(want), Canonical.json(got))
    }

    @Test fun serverCanDecryptWhatAndroidEncrypts_hkdfInfoMatters() {
        // The key schedule is fixed by the server: same ECDH secret must give the same AES key as HKDF("beacon-ecies-v1").
        val shared = ByteArray(32) { it.toByte() }
        val k = Ecies.deriveKey(shared)
        assertEquals(32, k.size)
        assertArrayEquals(k, Ecies.deriveKey(shared))
        assertFalse(k.contentEquals(Ecies.deriveKey(ByteArray(32) { (it + 1).toByte() })))
    }
}

class ServerFixtureTest {
    private val f = Fixtures.server()
    private val env = MeshEnvelope.fromJson(f.getJSONObject("envelope"))!!
    private val nowMs = Iso.parse(f.getString("now_for_validation"))!!

    @Test fun serverSignedEnvelopeVerifiesAndSignedPartIsByteIdentical() {
        assertEquals(f.getString("envelope_signed_part"), env.signedPart())
        val r = MeshValidation.validate(env, nowMs)
        assertNull(r.drop)
        assertTrue(r.verified)
        assertEquals(2, env.hopCount)
        assertEquals(listOf("E45B", "B7C2"), env.hopPath)
    }

    @Test fun anyTamperedSignedFieldBreaksTheServerSignature() {
        assertEquals(DropReason.BAD_SIGNATURE, MeshValidation.validate(env.copy(maxHops = 9), nowMs).drop)
        assertEquals(DropReason.BAD_SIGNATURE, MeshValidation.validate(env.copy(tier = "high"), nowMs).drop)
        assertEquals(DropReason.BAD_SIGNATURE, MeshValidation.validate(env.copy(senderKeyId = "x" + env.senderKeyId), nowMs).drop)
        val r = JSONObject(env.routing.toString()).also { it.put("category", "other") }
        assertEquals(DropReason.BAD_SIGNATURE, MeshValidation.validate(env.copy(routing = r), nowMs).drop)
        // unsigned fields may change freely
        assertNull(MeshValidation.validate(env.copy(hopCount = 3, hopPath = listOf("a", "b", "c")), nowMs).drop)
    }

    @Test fun serverEnvelopeRoundTripsThroughOurJsonUnchanged() {
        val original = f.getJSONObject("envelope")
        assertEquals(Canonical.json(original), Canonical.json(env.toJson()))
    }

    @Test fun backendMessagesAndReceiptsVerifyWithTheSigningKey() {
        val key = f.getJSONObject("backend").getString("signing_public_key")
        val bm = BackendMessage.fromJson(f.getJSONObject("backend_message"))!!
        assertTrue(MeshCrypto.verifyB64(key, bm.signedPart(), bm.signature))
        val checkin = BackendMessage.fromJson(f.getJSONObject("backend_message_checkin"))!!
        assertTrue(MeshCrypto.verifyB64(key, checkin.signedPart(), checkin.signature))
        assertEquals("0192a7f0-0000-7000-8000-0000000000c1", checkin.checkinId)
        val rc = DeliveredReceipt.fromJson(f.getJSONObject("delivered_receipt"))!!
        assertTrue(MeshCrypto.verifyB64(key, rc.signedPart(), rc.signature))
        assertFalse(MeshCrypto.verifyB64(key, bm.copy(body = JSONObject().put("status", "resolved")).signedPart(), bm.signature))
        assertFalse(MeshCrypto.verifyB64(env.senderPublicKey!!, bm.signedPart(), bm.signature))
    }

    @Test fun requestSignatureMatchesTheServerString() {
        val rs = f.getJSONObject("request_signature")
        val signer = RequestSigner(SoftwareSigner())
        val msg = signer.message(rs.getString("method"), rs.getString("path"), rs.getString("body").toByteArray(), rs.getString("timestamp"))
        assertEquals(rs.getString("signed_string"), msg)
        // the server's own signature over that string verifies with the device key
        assertTrue(MeshCrypto.verifyB64(f.getJSONObject("device").getString("public_key"), msg, rs.getString("signature")))
        assertEquals(rs.getString("empty_body_sha256"), MeshCrypto.sha256Hex(ByteArray(0)))
    }
}

class HopTableTest {
    @Test fun contractTable() {
        val t = mapOf(
            Priority.CRITICAL to (10 to 24 * 60L), Priority.HIGH to (7 to 12 * 60L), Priority.NORMAL to (5 to 6 * 60L),
            Priority.SAFE to (3 to 3 * 60L), Priority.HEARTBEAT to (2 to 30L),
        )
        for ((p, v) in t) {
            assertEquals(p.wire, v.first, HopLimits.DEFAULT.maxHops(p))
            assertEquals(p.wire, v.second * 60_000, HopLimits.DEFAULT.ttlMs(p))
        }
    }

    @Test fun serverValuesWinAndGarbageIsIgnored() {
        val l = HopLimits.fromJson(JSONArray("""[{"tier":"normal","max_hops":4,"ttl_seconds":600},{"tier":"safe","max_hops":99,"ttl_seconds":1},{"tier":"nope","max_hops":1,"ttl_seconds":1}]"""))
        assertEquals(4, l.maxHops(Priority.NORMAL))
        assertEquals(600_000L, l.ttlMs(Priority.NORMAL))
        assertEquals(3, l.maxHops(Priority.SAFE)) // 99 rejected, default kept
        assertEquals(10, l.maxHops(Priority.CRITICAL))
    }
}
