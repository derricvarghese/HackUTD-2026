package com.beacon.mesh.ui.responder

import android.content.Context
import android.graphics.drawable.Drawable
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.MapTileProviderBasic
import org.osmdroid.tileprovider.modules.IFilesystemCache
import org.osmdroid.tileprovider.modules.INetworkAvailablityCheck
import org.osmdroid.tileprovider.modules.MapTileDownloader
import org.osmdroid.tileprovider.modules.TileDownloader
import org.osmdroid.tileprovider.tilesource.ITileSource
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit

/**
 * osmdroid's built-in downloader uses HttpURLConnection with NO connect/read timeout and tries addresses one
 * after another. On a network where one address family black-holes (VPN with IPv4 only, NAT64 cellular) both of
 * its two download threads block in connect() forever, so no tile is ever delivered and the map stays blank.
 * This downloader uses OkHttp instead: hard timeouts, parallel IPv4/IPv6 fallback, HTTP/2 and redirects.
 */
internal class OkHttpTileDownloader(private val client: OkHttpClient = sharedClient) : TileDownloader() {
    override fun downloadTile(
        pMapTileIndex: Long, redirectCount: Int, url: String, cache: IFilesystemCache?, source: OnlineTileSourceBase,
    ): Drawable? {
        val cfg = Configuration.getInstance()
        val ua = (if (source.tileSourcePolicy.normalizesUserAgent()) cfg.normalizedUserAgent else null) ?: cfg.userAgentValue
        if (!source.tileSourcePolicy.acceptsUserAgent(ua)) return null
        val req = Request.Builder().url(url).header(cfg.userAgentHttpHeader, ua).build()
        val call: Call = client.newCall(req)
        return try {
            call.execute().use { rsp ->
                if (!rsp.isSuccessful) return null
                val body = rsp.body ?: return null
                val bytes = body.bytes()
                if (bytes.isEmpty()) return null
                val expires = computeExpirationTime(rsp.header("Expires"), rsp.header("Cache-Control"), System.currentTimeMillis())
                cache?.saveFile(source, pMapTileIndex, ByteArrayInputStream(bytes), expires)
                source.getDrawable(ByteArrayInputStream(bytes))
            }
        } catch (_: java.io.IOException) {
            null // timeout / offline: osmdroid backs the URL off and retries later
        }
    }

    companion object {
        val sharedClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}

/** MapTileProviderBasic whose downloader is [OkHttpTileDownloader]. */
internal class OkHttpTileProvider(context: Context, source: ITileSource) : MapTileProviderBasic(context, source) {
    override fun createDownloaderProvider(check: INetworkAvailablityCheck?, source: ITileSource?): MapTileDownloader =
        super.createDownloaderProvider(check, source).also { it.setTileDownloader(OkHttpTileDownloader()) }
}
