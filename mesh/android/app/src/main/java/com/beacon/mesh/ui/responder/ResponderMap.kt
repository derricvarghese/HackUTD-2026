package com.beacon.mesh.ui.responder

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Point
import android.graphics.drawable.BitmapDrawable
import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.beacon.mesh.R
import com.beacon.mesh.responder.MapTarget
import com.beacon.mesh.responder.PinTone
import com.beacon.mesh.ui.haptics.HapticEvent
import com.beacon.mesh.ui.haptics.LocalHaptics
import com.beacon.mesh.ui.theme.LocalCategoryColors
import com.beacon.mesh.ui.theme.LocalReduceMotion
import org.osmdroid.config.Configuration
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.events.MapListener
import org.osmdroid.events.ScrollEvent
import org.osmdroid.events.ZoomEvent
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.Projection
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Overlay
import org.osmdroid.views.overlay.Polygon
import org.osmdroid.views.overlay.TilesOverlay
import java.io.File
import kotlin.math.cos

private data class PinPalette(val critical: Int, val high: Int, val normal: Int, val safe: Int, val mine: Int, val onPin: Int) {
    fun of(t: PinTone) = when (t) { PinTone.CRITICAL -> critical; PinTone.HIGH -> high; PinTone.NORMAL -> normal; PinTone.SAFE -> safe }
}

/**
 * OpenStreetMap map (osmdroid, no Google services). Each target is a translucent circle of its uncertainty
 * radius plus a pin; silent/unresponsive pins pulse. If tiles cannot load the map stays a blank surface
 * and everything else on screen keeps working. Camera survives rotation via saveable state.
 */
@Composable
fun ResponderMap(
    targets: List<MapTarget>,
    selectedId: String?,
    fitToken: Int,
    dark: Boolean,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val haptics = LocalHaptics.current
    val density = LocalDensity.current.density
    val reduceMotion = LocalReduceMotion.current
    val cat = LocalCategoryColors.current
    val scheme = MaterialTheme.colorScheme
    val palette = remember(cat, scheme) {
        PinPalette(cat.danger.toArgb(), cat.warn.toArgb(), scheme.secondary.toArgb(), cat.safe.toArgb(), scheme.primary.toArgb(), Color.White.toArgb())
    }
    val surface = scheme.surfaceVariant.toArgb()
    val onSelectNow by rememberUpdatedState(onSelect)
    val targetsNow by rememberUpdatedState(targets)

    // Camera kept across rotation / process death: lat, lng, zoom, and whether we already framed the cases.
    var saved by rememberSaveable { mutableStateOfDoubles() }

    val map = remember {
        configureOsm(context)
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            isTilesScaledToDpi = true
            zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
            minZoomLevel = 3.0
            maxZoomLevel = 19.0
            controller.setZoom(11.0)
        }
    }

    // Lifecycle: osmdroid needs resume/pause to start and stop its tile threads.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, map) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> map.onResume()
                Lifecycle.Event.ON_PAUSE -> map.onPause()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) map.onResume()
        onDispose {
            owner.lifecycle.removeObserver(obs)
            map.onPause()
            map.onDetach()
        }
    }

    // Persist the camera as the user moves it.
    DisposableEffect(map) {
        val l = object : MapListener {
            override fun onScroll(event: ScrollEvent?): Boolean { saveCamera(map) { saved = it }; return false }
            override fun onZoom(event: ZoomEvent?): Boolean { saveCamera(map) { saved = it }; return false }
        }
        map.addMapListener(l)
        onDispose { map.removeMapListener(l) }
    }

    fun fit(list: List<MapTarget>) {
        if (list.isEmpty()) return
        val doFit = {
            map.zoomToBoundingBox(boundsOf(list), true, (48 * density).toInt())
            saveCamera(map) { saved = it }
        }
        if (map.width > 0 && map.height > 0) doFit() else map.addOnFirstLayoutListener { _, _, _, _, _ -> doFit() }
    }

    // Restore a saved camera once, else frame the first non-empty set of targets.
    var framed by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(map) {
        val s = saved
        if (s.size == 3 && s[2] > 0) {
            map.controller.setZoom(s[2]); map.controller.setCenter(GeoPoint(s[0], s[1])); framed = true
        }
    }
    LaunchedEffect(targets.isEmpty(), framed) {
        if (!framed && targets.isNotEmpty()) { framed = true; fit(targets) }
    }
    var lastFit by rememberSaveable { mutableIntStateOf(fitToken) }
    LaunchedEffect(fitToken) {
        if (fitToken != lastFit) { lastFit = fitToken; fit(targetsNow) }
    }

    // Selecting from the list recentres the map on that case.
    LaunchedEffect(selectedId) {
        targets.firstOrNull { it.id == selectedId }?.let { map.controller.animateTo(GeoPoint(it.lat, it.lng)) }
    }

    val description = stringResource(R.string.responder_map_description, targets.size)
    val attribution = stringResource(R.string.responder_map_attribution)

    Box(modifier.semantics { contentDescription = description }) {
        AndroidView(
            factory = { map },
            modifier = Modifier,
            update = { v ->
                v.setBackgroundColor(surface)
                v.overlayManager.tilesOverlay.apply {
                    loadingBackgroundColor = surface
                    loadingLineColor = surface
                    setColorFilter(if (dark) TilesOverlay.INVERT_COLORS else null)
                }
                val key = Triple(targets, selectedId, dark to palette)
                if (v.tag != key) {
                    v.tag = key
                    rebuild(v, context, targets, selectedId, palette, density, reduceMotion) { onSelectNow(it) }
                }
            },
        )
        Surface(
            Modifier.align(Alignment.BottomStart).padding(8.dp),
            shape = MaterialTheme.shapes.extraSmall,
            color = scheme.surface.copy(alpha = 0.8f),
        ) { Text(attribution, Modifier.padding(horizontal = 6.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall) }
        Column(Modifier.align(Alignment.BottomEnd).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ZoomButton(true, stringResource(R.string.responder_zoom_in)) { haptics.perform(HapticEvent.LightTap); map.controller.zoomIn() }
            ZoomButton(false, stringResource(R.string.responder_zoom_out)) { haptics.perform(HapticEvent.LightTap); map.controller.zoomOut() }
        }
    }
}

@Composable
private fun ZoomButton(plus: Boolean, label: String, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        colors = IconButtonDefaults.filledTonalIconButtonColors(),
    ) { Icon(if (plus) Icons.Rounded.Add else Icons.Rounded.Remove, label) }
}

private fun mutableStateOfDoubles() = mutableStateOf(emptyList<Double>())

private fun saveCamera(map: MapView, set: (List<Double>) -> Unit) {
    val c = map.mapCenter
    set(listOf(c.latitude, c.longitude, map.zoomLevelDouble))
}

private fun configureOsm(context: Context) {
    val cfg = Configuration.getInstance()
    cfg.userAgentValue = context.packageName // OSM tile policy needs an identifying User-Agent
    val base = File(context.cacheDir, "osmdroid")
    cfg.osmdroidBasePath = base // cache dir: no storage permission, and Android may reclaim it
    cfg.osmdroidTileCache = File(base, "tiles")
}

internal fun boundsOf(list: List<MapTarget>): BoundingBox {
    var n = -90.0; var s = 90.0; var e = -180.0; var w = 180.0
    for (t in list) {
        val r = maxOf(t.radiusM, 500.0)
        val dLat = r / 111_320.0
        val dLng = r / (111_320.0 * cos(Math.toRadians(t.lat)).coerceAtLeast(0.1))
        n = maxOf(n, t.lat + dLat); s = minOf(s, t.lat - dLat)
        e = maxOf(e, t.lng + dLng); w = minOf(w, t.lng - dLng)
    }
    return BoundingBox(n.coerceAtMost(85.0), e.coerceAtMost(180.0), s.coerceAtLeast(-85.0), w.coerceAtLeast(-180.0))
}

private fun rebuild(
    v: MapView, context: Context, targets: List<MapTarget>, selectedId: String?, p: PinPalette,
    density: Float, reduceMotion: Boolean, onSelect: (String) -> Unit,
) {
    v.overlays.clear()
    // Biggest circles first so smaller (more precise) ones sit on top, as on iOS.
    for (t in targets.sortedByDescending { it.radiusM }) {
        val color = p.of(t.tone)
        v.overlays.add(Polygon(v).apply {
            points = Polygon.pointsAsCircle(GeoPoint(t.lat, t.lng), t.radiusM)
            fillPaint.color = withAlpha(color, if (t.exact) 90 else 40)
            outlinePaint.color = if (t.mine) p.mine else color
            outlinePaint.strokeWidth = (if (t.mine) 3f else 2f) * density
            if (t.source == MapTarget.Source.MESH) outlinePaint.pathEffect = DashPathEffect(floatArrayOf(6f * density, 5f * density), 0f)
            infoWindow = null
            setOnClickListener { _, _, _ -> false }
        })
    }
    val pulsing = targets.filter { it.attention }
    if (pulsing.isNotEmpty()) v.overlays.add(PulseOverlay(v, pulsing, p, density, reduceMotion))
    for (t in targets) {
        v.overlays.add(Marker(v).apply {
            position = GeoPoint(t.lat, t.lng)
            title = t.title
            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            icon = BitmapDrawable(context.resources, pinBitmap(t, t.id == selectedId, p, density))
            infoWindow = null
            setOnMarkerClickListener { _, _ -> false }
        })
    }
    // Top-most: taps land here first. A pin wins; otherwise the smallest circle containing the tap.
    v.overlays.add(MapEventsOverlay(object : MapEventsReceiver {
        override fun singleTapConfirmedHelper(p0: GeoPoint): Boolean {
            val hit = hitTest(v, targets, p0, density) ?: return false
            onSelect(hit.id)
            return true
        }
        override fun longPressHelper(p0: GeoPoint): Boolean = false
    }))
    v.invalidate()
}

internal fun hitTest(v: MapView, targets: List<MapTarget>, tap: GeoPoint, density: Float): MapTarget? {
    val pj = v.projection
    val tapPx = pj.toPixels(tap, Point())
    val pinReach = 26f * density
    val pin = targets.minByOrNull { t ->
        val q = pj.toPixels(GeoPoint(t.lat, t.lng), Point())
        val dx = (q.x - tapPx.x).toFloat(); val dy = (q.y - tapPx.y).toFloat()
        dx * dx + dy * dy
    }?.takeIf { t ->
        val q = pj.toPixels(GeoPoint(t.lat, t.lng), Point())
        val dx = (q.x - tapPx.x).toFloat(); val dy = (q.y - tapPx.y).toFloat()
        dx * dx + dy * dy <= pinReach * pinReach
    }
    if (pin != null) return pin
    return targets.filter { GeoPoint(it.lat, it.lng).distanceToAsDouble(tap) <= it.radiusM }.minByOrNull { it.radiusM }
}

private fun withAlpha(color: Int, alpha: Int) = (color and 0x00FFFFFF) or (alpha shl 24)

private val bitmapCache = HashMap<String, Bitmap>()

/** Round pin: tone colour, white rim, glyph by tone; dashed rim for Bluetooth-only reports; blue ring for "mine". */
private fun pinBitmap(t: MapTarget, selected: Boolean, p: PinPalette, density: Float): Bitmap {
    val key = "${t.tone}|${t.source}|${t.mine}|$selected|${p.of(t.tone)}|$density"
    return bitmapCache.getOrPut(key) {
        val size = ((if (selected) 40 else 32) * density).toInt()
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val cx = size / 2f
        val r = size / 2f - 3f * density
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val tone = p.of(t.tone)
        paint.style = Paint.Style.FILL
        paint.color = if (t.source == MapTarget.Source.MESH) withAlpha(tone, 200) else tone
        c.drawCircle(cx, cx, r, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2.5f * density
        paint.color = if (t.mine) p.mine else p.onPin
        if (t.source == MapTarget.Source.MESH) paint.pathEffect = DashPathEffect(floatArrayOf(4f * density, 3f * density), 0f)
        c.drawCircle(cx, cx, r, paint)
        paint.pathEffect = null
        paint.style = Paint.Style.FILL
        paint.color = p.onPin
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        paint.textSize = r * 1.2f
        val glyph = when (t.tone) { PinTone.CRITICAL -> "!"; PinTone.HIGH -> "!"; PinTone.SAFE -> "✓"; PinTone.NORMAL -> "•" }
        val y = cx - (paint.descent() + paint.ascent()) / 2
        c.drawText(glyph, cx, y, paint)
        bmp
    }
}

/** Expanding ring behind pins that are silent or not answering check-ins. Static ring when animations are off. */
private class PulseOverlay(
    private val view: MapView, private val targets: List<MapTarget>, private val p: PinPalette, private val density: Float, private val reduceMotion: Boolean,
) : Overlay() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3f * density }
    private val pt = Point()

    override fun draw(c: Canvas, pj: Projection) {
        val phase = if (reduceMotion) 0.5f else (SystemClock.uptimeMillis() % PERIOD_MS) / PERIOD_MS.toFloat()
        for (t in targets) {
            pj.toPixels(GeoPoint(t.lat, t.lng), pt)
            paint.color = withAlpha(p.of(t.tone), ((1f - phase) * 220).toInt())
            c.drawCircle(pt.x.toFloat(), pt.y.toFloat(), (16f + 26f * phase) * density, paint)
        }
        if (!reduceMotion) view.postInvalidateOnAnimation()
    }

    private companion object { const val PERIOD_MS = 1600L }
}
