package com.beacon.mesh.crypto

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * ECIES over P-256 exactly as in server/docs/crypto.md section 3:
 *
 *   wire = 0x01 || ephemeral public key (65 B, X9.62 uncompressed) || nonce (12) || ciphertext || tag (16)
 *   key  = HKDF-SHA256(ikm = ECDH x-coordinate (32 B), salt = empty, info = "beacon-ecies-v1", L = 32)
 *   AEAD = AES-256-GCM, AAD = wire[0..65] (version byte + ephemeral public key)
 *
 * Plain javax.crypto only (HKDF is a one-block HMAC loop), so it runs identically on Android (API 26+) and the JVM.
 */
object Ecies {
    const val VERSION: Byte = 0x01
    private val INFO = "beacon-ecies-v1".toByteArray(Charsets.US_ASCII)
    private const val HEADER = 1 + 65
    private const val NONCE = 12
    private const val TAG = 16
    private val rnd = SecureRandom()

    /** @param recipientSpki backend encryption key, X.509 SubjectPublicKeyInfo DER of a P-256 key. */
    fun encrypt(plaintext: ByteArray, recipientSpki: ByteArray): ByteArray {
        val recipient = parsePublic(recipientSpki)
        val eph = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"), rnd)
            generateKeyPair()
        }
        val head = ByteArray(HEADER).also {
            it[0] = VERSION
            uncompressedPoint((eph.public as ECPublicKey).w).copyInto(it, 1)
        }
        val key = deriveKey(ecdh(eph.private, recipient))
        val nonce = ByteArray(NONCE).also { rnd.nextBytes(it) }
        val ct = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD(head)
            doFinal(plaintext) // ciphertext || tag
        }
        return head + nonce + ct
    }

    /** Inverse, used by tests and tooling (a phone never holds the backend private key). Throws on tampering. */
    fun decrypt(wire: ByteArray, recipientPkcs8: ByteArray): ByteArray {
        require(wire.size >= HEADER + NONCE + TAG && wire[0] == VERSION) { "bad ciphertext" }
        val head = wire.copyOfRange(0, HEADER)
        val nonce = wire.copyOfRange(HEADER, HEADER + NONCE)
        val ct = wire.copyOfRange(HEADER + NONCE, wire.size)
        val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(recipientPkcs8))
        val eph = publicFromPoint(head.copyOfRange(1, HEADER))
        val key = deriveKey(ecdh(priv, eph))
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            updateAAD(head)
            doFinal(ct)
        }
    }

    /** True when [spki] parses as a P-256 public key (used to reject garbage keys before caching them). */
    fun isValidP256Spki(spki: ByteArray): Boolean = try {
        val k = parsePublic(spki) as ECPublicKey
        k.params.curve.field.fieldSize == 256 && k.params.order.bitLength() == 256
    } catch (e: Exception) {
        false
    }

    fun parsePublic(spki: ByteArray): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))

    private fun ecdh(priv: PrivateKey, pub: PublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run {
        init(priv)
        doPhase(pub, true)
        generateSecret()
    }

    /** RFC 5869 with empty salt (= 32 zero bytes) and a single 32-byte output block. */
    fun deriveKey(shared: ByteArray): ByteArray {
        val prk = hmac(ByteArray(32), shared)
        return hmac(prk, INFO + byteArrayOf(0x01))
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    /** 0x04 || X(32) || Y(32), left-padded. */
    fun uncompressedPoint(w: ECPoint): ByteArray {
        val out = ByteArray(65)
        out[0] = 0x04
        fixed32(w.affineX).copyInto(out, 1)
        fixed32(w.affineY).copyInto(out, 33)
        return out
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        val out = ByteArray(32)
        val len = minOf(b.size, 32)
        System.arraycopy(b, b.size - len, out, 32 - len, len)
        return out
    }

    private fun publicFromPoint(p: ByteArray): PublicKey {
        require(p.size == 65 && p[0] == 0x04.toByte()) { "bad ephemeral key" }
        val params = (KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1")); generateKeyPair().public as ECPublicKey
        }).params
        val x = BigInteger(1, p.copyOfRange(1, 33))
        val y = BigInteger(1, p.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }
}
