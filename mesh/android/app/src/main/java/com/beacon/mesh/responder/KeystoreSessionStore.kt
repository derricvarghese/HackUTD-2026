package com.beacon.mesh.responder

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Refresh token + account, AES-256-GCM encrypted with a non-exportable Android Keystore key.
 * (androidx.security:security-crypto is deprecated, so this is the 40 lines it wrapped.)
 * Any decryption problem (key lost after a restore, tampering) just means "signed out".
 */
class KeystoreSessionStore(context: Context) : SessionStore {
    private val prefs = context.applicationContext.getSharedPreferences("beacon_responder", Context.MODE_PRIVATE)

    override fun load(): StoredSession? = try {
        val blob = prefs.getString(KEY_BLOB, null) ?: return null
        val raw = Base64.decode(blob, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, IV_LEN)))
        val j = JSONObject(String(c.doFinal(raw, IV_LEN, raw.size - IV_LEN), Charsets.UTF_8))
        StoredSession(j.getString("refresh"), ResponderAccount.from(j.getJSONObject("account"))!!)
    } catch (e: Exception) {
        prefs.edit().clear().apply()
        null
    }

    override fun save(session: StoredSession?) {
        if (session == null) {
            prefs.edit().clear().apply()
            return
        }
        try {
            val a = session.account
            val json = JSONObject().put("refresh", session.refreshToken).put(
                "account", JSONObject().put("id", a.id).put("username", a.username).put("name", a.name).put("role", a.role),
            )
            val c = Cipher.getInstance(TRANSFORM)
            c.init(Cipher.ENCRYPT_MODE, key())
            val out = c.iv + c.doFinal(json.toString().toByteArray(Charsets.UTF_8))
            prefs.edit().putString(KEY_BLOB, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        } catch (e: Exception) {
            // Cannot protect the token: keep nothing on disk; the session lasts until the process dies.
            prefs.edit().clear().apply()
        }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ALIAS = "beacon_responder_session"
        const val KEY_BLOB = "session"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_LEN = 12
    }
}
