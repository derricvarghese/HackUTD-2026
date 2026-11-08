package com.beacon.mesh.identity

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.KeyValueStore
import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.RegenerableSigner
import com.beacon.mesh.heartbeat.Heartbeat

/** BLE instance identity (the persistent UUID peers see). */
interface TransportIdentity {
    /** New persistent instance UUID; the transport restarts so it re-advertises under the new id. */
    fun regenerateInstanceId(): String
    /** Drop links and peer state of the old identity. */
    fun forgetPeers()
}

data class IdentityResetResult(val oldShortId: String, val newShortId: String)

/**
 * Demo "Reset device identity": the phone becomes a new device for the server (new signing key -> new `sender_key_id`
 * and `sender_hash`), so repeated reports are no longer merged into one case. Pure logic over seams so it is unit-tested.
 *
 * What it does, in order:
 *  1. replaces the signing key (the Keystore key is deleted and a new one generated);
 *  2. new BLE instance UUID, peers forgotten, transport restarted by [TransportIdentity];
 *  3. forgets the server registration (device id, outbox cursor) so the next online moment registers the new key;
 *  4. resets the heartbeat sequence and cancels pending welfare check-ins and alarms of the old identity;
 *  5. resets the profile sync bookkeeping (version 0, pending) so the kept profile is uploaded for the new device.
 * It never deletes held messages, the profile, or the seen-id dedupe tables, and never logs keys.
 */
class IdentityReset(
    private val signer: RegenerableSigner,
    private val config: BackendConfig,
    private val transport: TransportIdentity,
    private val prefs: KeyValueStore,
    private val cancelWelfare: () -> Unit,
    private val resetProfileSync: () -> Unit,
    private val onNewPublicKey: (String) -> Unit,
) {
    fun reset(): IdentityResetResult {
        val old = shortId(config.deviceId, signer.publicKeyDer)
        val newKey = signer.regenerate()                                  // 1
        onNewPublicKey(java.util.Base64.getEncoder().encodeToString(newKey))
        transport.forgetPeers()                                           // 2
        transport.regenerateInstanceId()
        config.resetRegistration()                                        // 3
        prefs.putLong(Heartbeat.KEY_SEQ, 0)                               // 4
        prefs.putLong(Heartbeat.KEY_LAST, 0)
        cancelWelfare()
        resetProfileSync()                                                // 5
        return IdentityResetResult(old, shortId(config.deviceId, newKey))
    }

    companion object {
        /** First 8 chars of the server device id when registered, else of the key fingerprint (SHA-256 of the SPKI). */
        fun shortId(deviceId: String?, publicKeyDer: ByteArray): String =
            deviceId?.take(8) ?: fingerprint(publicKeyDer).take(8)

        fun fingerprint(publicKeyDer: ByteArray): String = MeshCrypto.sha256Hex(publicKeyDer)
    }
}
