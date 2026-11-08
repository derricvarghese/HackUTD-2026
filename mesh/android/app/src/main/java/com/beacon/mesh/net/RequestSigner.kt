package com.beacon.mesh.net

import com.beacon.mesh.crypto.MeshCrypto
import com.beacon.mesh.crypto.MeshSigner
import com.beacon.mesh.protocol.Iso
import java.util.Base64

/**
 * Device-authenticated REST calls (server/docs/crypto.md section 4). Headers X-Device-Id, X-Timestamp, X-Device-Signature.
 * Signed string, joined by single "\n": METHOD (upper case), PATH (as sent, with /v1, no query), lower-case hex SHA-256 of
 * the exact body bytes (empty body = e3b0c442...), and the X-Timestamp header value verbatim. ECDSA P-256/SHA-256, DER, base64.
 */
class RequestSigner(private val signer: MeshSigner, private val now: () -> Long = System::currentTimeMillis) {
    fun message(method: String, path: String, body: ByteArray, timestamp: String): String =
        method.uppercase() + "\n" + path + "\n" + MeshCrypto.sha256Hex(body) + "\n" + timestamp

    fun headers(deviceId: String, method: String, path: String, body: ByteArray): Map<String, String> {
        val ts = Iso.format(now())
        val sig = Base64.getEncoder().encodeToString(signer.sign(message(method, path, body, ts).toByteArray(Charsets.UTF_8)))
        return mapOf("X-Device-Id" to deviceId, "X-Timestamp" to ts, "X-Device-Signature" to sig)
    }
}
