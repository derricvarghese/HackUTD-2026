package com.beacon.mesh.net

import java.net.HttpURLConnection
import java.net.URL

data class HttpResponse(val code: Int, val body: String, val headers: Map<String, String> = emptyMap())

/** Seam for tests: the app uses [UrlConnectionHttp], tests use a fake. Blocking; call off the main thread. */
interface HttpClient {
    @Throws(java.io.IOException::class)
    fun execute(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpResponse
}

class UrlConnectionHttp(private val connectTimeoutMs: Int = 10_000, private val readTimeoutMs: Int = 20_000) : HttpClient {
    override fun execute(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpResponse {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..399) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val h = HashMap<String, String>()
            conn.headerFields.forEach { (k, v) -> if (k != null && v.isNotEmpty()) h[k.lowercase()] = v.first() }
            return HttpResponse(code, text, h)
        } finally {
            conn.disconnect()
        }
    }
}
