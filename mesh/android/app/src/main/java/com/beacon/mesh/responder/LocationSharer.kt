package com.beacon.mesh.responder

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

enum class ShareResult { OK, RETRY, FATAL }

/** Where positions go (PATCH /v1/responders/{id}). Faked in tests. */
interface LocationSink {
    suspend fun send(lat: Double, lng: Double): ShareResult
    /** `location: null` on the server. */
    suspend fun clear(): ShareResult
}

data class ShareState(
    val armed: Boolean = false,
    /** Wall time of the last accepted position, null until the first one. */
    val lastSentAtMs: Long? = null,
    val failing: Boolean = false,
    val clearing: Boolean = false,
)

/**
 * Throttled position sharing. A send happens when the position moved at least [MIN_MOVE_M] since the last
 * accepted one, or [MAX_AGE_MS] passed, whichever first, but never closer than [MIN_GAP_MS] to the previous
 * attempt. Only the newest fix is kept while waiting (offline, backoff, throttle). Failures back off
 * exponentially. [stop] with clearing keeps trying `location:null` until it works, the user signs out
 * ([abandon]) or the server says we are no longer allowed ([ShareResult.FATAL]). Coordinates are never logged.
 */
class LocationSharer(
    private val scope: CoroutineScope,
    private val sink: LocationSink,
    private val clock: () -> Long,
    private val online: () -> Boolean = { true },
) {
    private val _state = MutableStateFlow(ShareState())
    val state: StateFlow<ShareState> = _state

    private var pending: Pair<Double, Double>? = null
    private var last: Pair<Double, Double>? = null
    private var lastSentAt = 0L
    private var nextAllowedAt = 0L
    private var fails = 0
    private var wake: Job? = null
    private var clearJob: Job? = null
    private val lock = Mutex()

    fun start() {
        clearJob?.cancel(); clearJob = null
        pending = null; last = null; lastSentAt = 0; nextAllowedAt = 0; fails = 0
        _state.value = ShareState(armed = true)
    }

    fun onFix(lat: Double, lng: Double) {
        if (!_state.value.armed) return
        pending = lat to lng
        scope.launch { pump() }
    }

    /** Stops sending. With [clearRemote] the stored position is removed server-side, retrying until it works. */
    fun stop(clearRemote: Boolean) {
        wake?.cancel(); wake = null
        pending = null
        val wasArmed = _state.value.armed
        _state.update { it.copy(armed = false, failing = false) }
        if (clearRemote && (wasArmed || last != null) && clearJob?.isActive != true) {
            _state.update { it.copy(clearing = true) }
            clearJob = scope.launch {
                var n = 0
                while (true) {
                    if (online() && sink.clear() != ShareResult.RETRY) break
                    delay(backoff(++n))
                }
                _state.update { it.copy(clearing = false) }
            }
        }
        last = null
    }

    /** Give up on clearing (signed out: the server can no longer be reached with our token). */
    fun abandon() {
        wake?.cancel(); wake = null; clearJob?.cancel(); clearJob = null; pending = null; last = null
        _state.value = ShareState()
    }

    private fun schedule(inMs: Long) {
        wake?.cancel()
        wake = scope.launch { delay(maxOf(1, inMs)); pump() }
    }

    private suspend fun pump() = lock.withLock {
        if (!_state.value.armed) return
        val p = pending ?: return
        val now = clock()
        if (!online()) { schedule(OFFLINE_RECHECK_MS); return }
        if (now < nextAllowedAt) { schedule(nextAllowedAt - now); return }
        val prev = last
        val due = prev == null || distanceM(prev, p) >= MIN_MOVE_M || now - lastSentAt >= MAX_AGE_MS
        if (!due) { schedule(lastSentAt + MAX_AGE_MS - now); return }
        nextAllowedAt = now + MIN_GAP_MS
        pending = null
        when (sink.send(p.first, p.second)) {
            ShareResult.OK -> {
                last = p; lastSentAt = clock(); fails = 0
                _state.update { it.copy(lastSentAtMs = lastSentAt, failing = false) }
            }
            ShareResult.RETRY -> {
                fails++
                nextAllowedAt = now + backoff(fails)
                if (pending == null) pending = p // keep only the newest
                _state.update { it.copy(failing = true) }
                schedule(nextAllowedAt - now)
            }
            ShareResult.FATAL -> { pending = null; _state.value = ShareState() }
        }
    }

    companion object {
        const val MIN_MOVE_M = 25.0
        const val MAX_AGE_MS = 60_000L
        const val MIN_GAP_MS = 10_000L
        const val OFFLINE_RECHECK_MS = 15_000L
        const val MAX_BACKOFF_MS = 120_000L

        /** 10 s, 20 s, 40 s ... capped at 2 min. */
        fun backoff(failures: Int): Long = min(MAX_BACKOFF_MS, (MIN_GAP_MS * 2.0.pow(min(failures - 1, 10).coerceAtLeast(0))).toLong())

        fun distanceM(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
            val r = 6_371_000.0
            val dLat = Math.toRadians(b.first - a.first)
            val dLng = Math.toRadians(b.second - a.second)
            val h = sin(dLat / 2).pow(2) + cos(Math.toRadians(a.first)) * cos(Math.toRadians(b.first)) * sin(dLng / 2).pow(2)
            return 2 * r * atan2(sqrt(h), sqrt(1 - h))
        }
    }
}
