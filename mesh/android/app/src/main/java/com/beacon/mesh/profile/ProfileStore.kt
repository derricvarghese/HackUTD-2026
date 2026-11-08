package com.beacon.mesh.profile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Where the sealed profile blob lives. A seam so the repository and sync engine run in JVM tests. */
interface ProfileStorage {
    fun read(): String?
    fun write(text: String)
    fun delete()
}

class MemoryProfileStorage : ProfileStorage {
    var text: String? = null
    override fun read() = text
    override fun write(text: String) { this.text = text }
    override fun delete() { text = null }
}

/**
 * Profile JSON sealed with an AES-256-GCM key that lives in the Android Keystore (non-exportable, never in a backup), written to
 * app-private storage (`files/`, excluded from backup and device transfer). Layout: 12 byte IV followed by ciphertext+tag.
 * Reading a blob the key cannot open (key wiped, restored on another phone) behaves as "no profile" and the blob is dropped.
 */
class KeystoreProfileStorage(context: Context, private val alias: String = "beacon_profile_key") : ProfileStorage {
    private val file = File(context.applicationContext.filesDir, "profile.bin")
    private val tmp = File(context.applicationContext.filesDir, "profile.bin.tmp")

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    @Synchronized override fun read(): String? {
        if (!file.exists()) return null
        return try {
            val raw = file.readBytes()
            require(raw.size > IV_LEN + 16)
            val c = Cipher.getInstance(TRANSFORM)
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV_LEN))
            String(c.doFinal(raw, IV_LEN, raw.size - IV_LEN), Charsets.UTF_8)
        } catch (e: Exception) {
            file.delete() // unreadable (key lost): treat as no profile; never log details
            null
        }
    }

    @Synchronized override fun write(text: String) {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key()) // Keystore generates a fresh random IV per call
        val out = c.iv + c.doFinal(text.toByteArray(Charsets.UTF_8))
        tmp.writeBytes(out)
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    @Synchronized override fun delete() {
        file.delete(); tmp.delete()
    }

    private companion object {
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_LEN = 12
    }
}

/**
 * In-memory copy of the [ProfileRecord] with write-through to [ProfileStorage]. Thread safe; [state] feeds the UI.
 * Personal data lives here: callers must not log the record.
 */
class ProfileRepository(private val storage: ProfileStorage) {
    private val lock = Any()
    private val _state = MutableStateFlow(load())
    val state: StateFlow<ProfileRecord> = _state.asStateFlow()
    val current: ProfileRecord get() = _state.value
    /** Called (on the writer's thread) after every change; the node uses it to refresh its snapshot. */
    @Volatile var onChange: (() -> Unit)? = null

    private fun load(): ProfileRecord = try {
        storage.read()?.let { ProfileRecord.fromJson(JSONObject(it)) } ?: ProfileRecord()
    } catch (e: Exception) {
        ProfileRecord()
    }

    /** Atomically transforms the record and persists it. @return the new record. */
    fun update(f: (ProfileRecord) -> ProfileRecord): ProfileRecord {
        var changed = false
        val result = synchronized(lock) {
            val next = f(_state.value)
            if (next != _state.value) {
                _state.value = next
                try {
                    if (next == ProfileRecord()) storage.delete() else storage.write(next.toJson().toString())
                } catch (e: Exception) { /* keep the in-memory copy; the next write retries */ }
                changed = true
            }
            next
        }
        if (changed) onChange?.invoke()
        return result
    }

    /**
     * Saves an edited profile (and the consent it was saved under); marks it PENDING so the sync engine uploads it.
     * Everything in the previous sync bookkeeping that depends on the content is reset, [ProfileRecord.profileVersion] is kept.
     */
    fun saveProfile(profile: UserProfile, consent: Consent, nowMs: Long): ProfileRecord = update {
        it.copy(
            profile = profile, consent = consent, rev = it.rev + 1, syncState = SyncState.PENDING, lastError = null,
            attempts = 0, nextAttemptAtMs = 0, stepDone = true, draft = null, pendingErase = false,
        )
    }

    /** Onboarding step skipped (only shown when the server says `profile_required=false`). */
    fun markStepDone() { update { it.copy(stepDone = true) } }

    /** "Complete your profile" dismissed for this process only: not persisted, so the nudge returns next launch. */
    @Volatile var bannerDismissedThisSession = false
        private set

    fun dismissBanner() { bannerDismissedThisSession = true; onChange?.invoke() }

    fun saveDraft(draft: JSONObject?) { update { it.copy(draft = draft) } }

    /** The user re-confirmed the consent text (a newer version id); the profile is queued again. */
    fun acceptConsent(consent: Consent) { update { it.copy(consent = consent, syncState = SyncState.PENDING, lastError = null, attempts = 0, nextAttemptAtMs = 0) } }

    /** Wipes the local profile now. The server erasure (404 = already gone) is retried until it succeeds. Keeps `stepDone`. */
    fun eraseLocal() {
        update { ProfileRecord(pendingErase = it.profile != null || it.pendingErase, stepDone = true) }
    }

    /**
     * New device identity: the server has never seen this device, so forget what it acknowledged. The profile itself is kept and
     * uploaded again (`PUT` with version 0 = create) as soon as the phone is online.
     */
    fun resetForNewDevice() {
        update {
            if (it.profile == null) it
            else it.copy(profileVersion = 0, syncState = SyncState.PENDING, attempts = 0, nextAttemptAtMs = 0, lastError = null)
        }
    }

    /** Manual "retry" from the UI: forget the backoff. */
    fun retryNow() { update { if (it.pendingErase) it else it.copy(syncState = SyncState.PENDING, attempts = 0, nextAttemptAtMs = 0, lastError = null) } }
}
