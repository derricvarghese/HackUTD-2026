package com.beacon.mesh.responder

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** Seam over the WebSocket so reconnect logic runs on the JVM with a fake. */
interface LiveListener {
    fun onOpen()
    /** Server frame `{ "event": name, ... }`. The payload is deliberately not passed on: events only trigger a REST refetch. */
    fun onEvent(name: String)
    /** Closed or failed; the controller decides when to reconnect. */
    fun onClosed()
}

interface LiveSocket { fun close() }

fun interface LiveSocketFactory { fun open(url: String, listener: LiveListener): LiveSocket }

/** Exponential backoff: 1 s, 2 s, 4 s ... capped at 30 s. [reset] after a successful connect. */
class Backoff(private val baseMs: Long = 1_000, private val maxMs: Long = 30_000) {
    private var attempt = 0
    fun next(): Long {
        val d = minOf(maxMs, baseMs shl minOf(attempt, 16))
        attempt++
        return d
    }
    fun reset() { attempt = 0 }
}

object LiveEvents {
    /** Events that can change what the case list shows. Heartbeat and mesh/deadzone chatter is ignored. */
    fun relevant(name: String): Boolean =
        name.startsWith("sos.") || name.startsWith("assignment.") || name.startsWith("checkin.") ||
            name == "profile.updated" || name == "heartbeat.silent" || name == "heartbeat.resumed"

    /** `https://host/x` -> `wss://host/x/v1/ws?token=...`. The token is a short-lived JWT as the contract requires. */
    fun url(baseUrl: String, token: String): String {
        val b = baseUrl.trimEnd('/')
        val ws = when {
            b.startsWith("https://") -> "wss://" + b.removePrefix("https://")
            b.startsWith("http://") -> "ws://" + b.removePrefix("http://")
            else -> b
        }
        return "$ws/v1/ws?token=" + java.net.URLEncoder.encode(token, "UTF-8")
    }
}

class OkHttpLiveSocketFactory(private val client: OkHttpClient = OkHttpAdapter.Shared.http) : LiveSocketFactory {
    override fun open(url: String, listener: LiveListener): LiveSocket {
        val ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"action":"subscribe","channels":["sos","assignments"]}""")
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val name = try { JSONObject(text).optString("event") } catch (e: Exception) { "" }
                if (name.isNotEmpty()) listener.onEvent(name)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { listener.onClosed() }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { listener.onClosed() }
        })
        return object : LiveSocket { override fun close() { ws.close(1000, null) } }
    }
}
