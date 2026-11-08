package com.beacon.mesh.support

import com.beacon.mesh.backend.BackendConfig
import com.beacon.mesh.backend.MemoryKeyValueStore
import com.beacon.mesh.crypto.SoftwareSigner
import com.beacon.mesh.net.HttpClient
import com.beacon.mesh.net.HttpResponse
import com.beacon.mesh.protocol.BackendMessage
import com.beacon.mesh.protocol.Canonical
import com.beacon.mesh.protocol.Iso
import org.json.JSONObject
import java.io.File
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** A throwaway backend: encryption + signing P-256 key pairs, like the real server's two keys. */
class FakeBackendKeys {
    val enc: KeyPair = gen()
    val sign: KeyPair = gen()
    val encPublicB64: String = b64(enc.public.encoded)
    val signPublicB64: String = b64(sign.public.encoded)

    fun config(withSigning: Boolean = true, withEnc: Boolean = true) =
        BackendConfig(MemoryKeyValueStore(), if (withEnc) encPublicB64 else "", if (withSigning) signPublicB64 else "")

    fun signBackendMessage(
        sosId: String, kind: String, body: JSONObject, checkinId: String? = null,
        id: String = java.util.UUID.randomUUID().toString(), createdAtMs: Long, ttlMs: Long = 6 * 3_600_000L,
    ): BackendMessage {
        val unsigned = BackendMessage(id, kind, sosId, checkinId, body, 5, 0, emptyList(), Iso.format(createdAtMs + ttlMs), Iso.format(createdAtMs), "")
        return unsigned.copy(signature = ecdsa(sign, unsigned.signedPart()))
    }

    companion object {
        fun gen(): KeyPair = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
        fun ecdsa(kp: KeyPair, data: String): String = b64(
            Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(data.toByteArray()); sign() }
        )
    }
}

/** Scripted HTTP: each call is matched by "METHOD path" and recorded. */
class FakeHttp : HttpClient {
    data class Call(val method: String, val url: String, val headers: Map<String, String>, val body: String)
    val calls = ArrayList<Call>()
    private val handlers = LinkedHashMap<String, (Call) -> HttpResponse>()
    var networkDown = false

    fun on(method: String, path: String, handler: (Call) -> HttpResponse) { handlers["$method $path"] = handler }
    fun json(code: Int, body: String, headers: Map<String, String> = emptyMap()) = HttpResponse(code, body, headers)

    override fun execute(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpResponse {
        val c = Call(method, url, headers, body?.toString(Charsets.UTF_8) ?: "")
        calls.add(c)
        if (networkDown) throw java.io.IOException("down")
        val path = java.net.URL(url).path
        val h = handlers["$method $path"] ?: return HttpResponse(404, """{"code":"not_found","message":"no handler"}""")
        return h(c)
    }

    fun callsTo(method: String, path: String) = calls.filter { it.method == method && java.net.URL(it.url).path == path }
}

object Fixtures {
    /** Gradle runs unit tests with mesh/android/app as the working directory. */
    val dir = File("../../test-vectors/contract_v1")
    fun server(): JSONObject = JSONObject(File(dir, "server_envelope.json").readText())
    fun canonical(v: Any?) = Canonical.json(v)
}
