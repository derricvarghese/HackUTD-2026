package com.beacon.mesh.responder

import com.beacon.mesh.net.HttpClient
import com.beacon.mesh.net.HttpResponse
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** The app's [HttpClient] seam backed by OkHttp (HttpURLConnection is flaky with PATCH on older Androids). */
class OkHttpAdapter(private val client: OkHttpClient = Shared.http) : HttpClient {
    override fun execute(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpResponse {
        val rb = when {
            body != null -> body.toRequestBody("application/json".toMediaType())
            method == "GET" || method == "HEAD" -> null
            else -> ByteArray(0).toRequestBody(null)
        }
        val req = Request.Builder().url(url).method(method, rb).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        client.newCall(req).execute().use { r ->
            return HttpResponse(r.code, r.body?.string().orEmpty(), emptyMap())
        }
    }

    object Shared {
        val http: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .pingInterval(30, TimeUnit.SECONDS)
                .build()
        }
    }
}
