package com.beacon.mesh.crypto

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/** Signs outgoing messages with ECDSA P-256 / SHA-256 (same as iOS CryptoKit `P256.Signing`). */
interface MeshSigner {
    /** SubjectPublicKeyInfo DER (`PublicKey.getEncoded()`), same bytes as iOS `derRepresentation`. */
    val publicKeyDer: ByteArray

    /** DER-encoded signature. */
    fun sign(data: ByteArray): ByteArray
}

/** Hardware-backed key in AndroidKeyStore; the private key never leaves the device. */
class KeystoreSigner(private val alias: String = "beacon_mesh_device_key") : MeshSigner {
    private val privateKey: PrivateKey
    override val publicKeyDer: ByteArray

    init {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(alias)) {
            val gen = KeyPairGenerator.getInstance(
                android.security.keystore.KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore"
            )
            gen.initialize(
                android.security.keystore.KeyGenParameterSpec.Builder(
                    alias, android.security.keystore.KeyProperties.PURPOSE_SIGN
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(android.security.keystore.KeyProperties.DIGEST_SHA256)
                    .build()
            )
            gen.generateKeyPair()
        }
        val entry = ks.getEntry(alias, null) as KeyStore.PrivateKeyEntry
        privateKey = entry.privateKey
        publicKeyDer = entry.certificate.publicKey.encoded
    }

    override fun sign(data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(data)
            sign()
        }
}

/** Plain JCA key, for JVM unit tests. */
class SoftwareSigner(private val keyPair: KeyPair = generate()) : MeshSigner {
    override val publicKeyDer: ByteArray = keyPair.public.encoded

    override fun sign(data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update(data)
            sign()
        }

    companion object {
        fun generate(): KeyPair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
    }
}

object MeshCrypto {
    fun verify(publicKeyDer: ByteArray, data: ByteArray, signatureDer: ByteArray): Boolean = try {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicKeyDer))
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(data)
            verify(signatureDer)
        }
    } catch (e: Exception) {
        false
    }

    fun verifyB64(publicKeySpkiB64: String, data: String, signatureB64: String): Boolean = try {
        verify(
            java.util.Base64.getDecoder().decode(publicKeySpkiB64),
            data.toByteArray(Charsets.UTF_8),
            java.util.Base64.getDecoder().decode(signatureB64),
        )
    } catch (e: IllegalArgumentException) {
        false
    }

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

    /** First 2 bytes of SHA-256(SPKI DER) as 4 uppercase hex chars. */
    fun relayId(publicKeyDer: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
        return "%02X%02X".format(d[0].toInt() and 0xFF, d[1].toInt() and 0xFF)
    }
}
