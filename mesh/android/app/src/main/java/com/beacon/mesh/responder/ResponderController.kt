package com.beacon.mesh.responder

import com.beacon.mesh.protocol.Iso
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class Connection { IDLE, CONNECTING, LIVE, RECONNECTING }

data class ResponderState(
    val account: ResponderAccount? = null,
    val cases: List<ResponderCase> = emptyList(),
    val loaded: Boolean = false,
    val lastUpdatedMs: Long? = null,
    val connection: Connection = Connection.IDLE,
    val busy: Boolean = false,
    val error: ResponderException? = null,
    /** Responder's `available` flag from the server; null until known. */
    val available: Boolean? = null,
)

/**
 * Responder session logic with no Android types: login state, the open-case set, live updates.
 *
 * Live updates: while [setActive] is true a WebSocket is kept open (reconnect with [Backoff]). Frames only
 * *signal* a change; the data always comes from `GET /v1/sos` (the contract says events are not replayed), using
 * `updated_since` as the catch-up cursor after every (re)connect. If the socket is down the list polls every
 * [POLL_MS] like the iOS app; while it is up a slow safety resync still runs.
 */
class ResponderController(
    private val scope: CoroutineScope,
    private val client: ResponderClient,
    private val sockets: LiveSocketFactory,
    private val backoff: Backoff = Backoff(),
) {
    private val _state = MutableStateFlow(ResponderState(account = client.account))
    val state: StateFlow<ResponderState> = _state

    private var held = LinkedHashMap<String, ResponderCase>()
    private var cursorMs: Long? = null
    private val syncLock = Mutex()
    private val signals = Channel<Unit>(Channel.CONFLATED)
    private var liveJob: Job? = null

    // ---- session ----

    suspend fun login(username: String, password: String): Boolean {
        setBusy(true)
        return try {
            val account = client.login(username, password)
            held = LinkedHashMap(); cursorMs = null
            _state.update { it.copy(account = account, error = null, cases = emptyList(), loaded = false) }
            fullRefresh()
            true
        } catch (e: ResponderException) {
            fail(e); false
        } finally {
            setBusy(false)
        }
    }

    suspend fun logout() {
        stopLive()
        stopPresence(sendOffline = false)
        if (_state.value.account != null) {
            runCatching { client.setPresence(false) }
            runCatching { client.clearLocation() }
        }
        client.logout()
        held = LinkedHashMap(); cursorMs = null
        _state.value = ResponderState()
    }

    // ---- data ----

    /** Replaces the held set with the server's current open cases. */
    suspend fun fullRefresh() {
        runSync {
            val list = client.openCases()
            held = LinkedHashMap(list.filter { it.isOpen }.associateBy { it.id })
            cursorMs = list.mapNotNull { it.updatedAtMs }.maxOrNull() ?: cursorMs
        }
    }

    /** Only what changed since the last sync; falls back to a full refresh when there is no cursor yet. */
    suspend fun catchUp() {
        val since = cursorMs ?: return fullRefresh()
        runSync {
            val list = client.casesUpdatedSince(Iso.format(since - OVERLAP_MS))
            held = LinkedHashMap(CaseRules.merge(held, list))
            list.mapNotNull { it.updatedAtMs }.maxOrNull()?.let { m -> cursorMs = maxOf(cursorMs ?: 0, m) }
        }
    }

    private suspend fun runSync(op: suspend () -> Unit) {
        if (_state.value.account == null) return
        syncLock.withLock {
            try {
                op()
                _state.update {
                    it.copy(cases = held.values.toList(), loaded = true, lastUpdatedMs = System.currentTimeMillis(), error = null)
                }
            } catch (e: ResponderException) {
                fail(e)
            }
        }
    }

    // ---- actions (each ends with a full refresh so the exact location and status come back) ----

    suspend fun claim(c: ResponderCase): Boolean = act { client.claim(c.id) }

    suspend fun advance(c: ResponderCase, status: String, outcome: String? = null): Boolean {
        val a = c.assignmentId ?: return false
        return act { client.updateAssignment(a, status, outcome) }
    }

    suspend fun addNote(c: ResponderCase, text: String): Boolean = act { client.addNote(c.id, text) }

    suspend fun detail(id: String): CaseDetail? = try {
        client.caseDetail(id)
    } catch (e: ResponderException) {
        fail(e); null
    }

    private suspend fun act(op: suspend () -> Unit): Boolean {
        setBusy(true)
        var failure: ResponderException? = null
        val ok = try {
            op(); _state.update { it.copy(error = null) }; true
        } catch (e: ResponderException) {
            fail(e); failure = e; false
        } finally {
            setBusy(false)
        }
        if (_state.value.account != null) {
            fullRefresh()
            // The refresh that follows a failed action must not wipe the reason it failed.
            if (failure != null && _state.value.account != null) _state.update { it.copy(error = failure) }
        }
        return ok
    }

    suspend fun loadAvailability() {
        try { val a = client.myAvailability(); _state.update { it.copy(available = a) } } catch (e: ResponderException) { if (e.kind == ResponderException.Kind.SIGNED_OUT) fail(e) }
    }

    /** Optimistic: flips at once, reverts and reports the error if the server refuses. */
    suspend fun setAvailable(on: Boolean): Boolean {
        val before = _state.value.available
        _state.update { it.copy(available = on) }
        return try { client.setAvailable(on); true } catch (e: ResponderException) {
            _state.update { it.copy(available = before) }; fail(e); false
        }
    }

    suspend fun uploadImage(sosId: String, imageId: String, bytes: ByteArray, caption: String? = null): Boolean = act {
        client.uploadCaseImage(sosId, imageId, bytes, caption)
    }

    fun clearError() = _state.update { it.copy(error = null) }

    // ---- live & presence ----

    private var presenceJob: Job? = null
    private var offlineJob: Job? = null

    fun setActive(active: Boolean) {
        if (active && _state.value.account != null) {
            startLive()
            startPresence()
        } else {
            stopLive()
            stopPresence(sendOffline = true)
        }
    }

    private fun startPresence() {
        offlineJob?.cancel()
        offlineJob = null
        if (presenceJob?.isActive == true) return
        presenceJob = scope.launch {
            while (true) {
                runCatching {
                    val avail = client.setPresence(true)
                    if (avail != null) _state.update { it.copy(available = avail) }
                }
                delay(PRESENCE_INTERVAL_MS)
            }
        }
    }

    private fun stopPresence(sendOffline: Boolean) {
        presenceJob?.cancel()
        presenceJob = null
        if (sendOffline && _state.value.account != null) {
            offlineJob?.cancel()
            offlineJob = scope.launch {
                runCatching { client.setPresence(false) }
                runCatching { client.clearLocation() }
            }
        }
    }

    private fun startLive() {
        if (liveJob?.isActive == true) return
        liveJob = scope.launch {
            launch { for (s in signals) { delay(DEBOUNCE_MS); catchUp() } }
            launch { fullRefresh(); loadAvailability(); while (true) { delay(if (_state.value.connection == Connection.LIVE) RESYNC_MS else POLL_MS); catchUp() } }
            runSocket()
        }
    }

    private fun stopLive() {
        liveJob?.cancel()
        liveJob = null
        _state.update { it.copy(connection = Connection.IDLE) }
    }

    private suspend fun runSocket() {
        var first = true
        while (true) {
            setConnection(if (first) Connection.CONNECTING else Connection.RECONNECTING)
            first = false
            val closed = CompletableDeferred<Unit>()
            var socket: LiveSocket? = null
            try {
                val token = client.accessToken()
                socket = sockets.open(LiveEvents.url(client.baseUrl, token), object : LiveListener {
                    override fun onOpen() {
                        backoff.reset()
                        setConnection(Connection.LIVE)
                        // Close the gap between the last sync and the socket coming up.
                        signals.trySend(Unit)
                    }
                    override fun onEvent(name: String) { if (LiveEvents.relevant(name)) signals.trySend(Unit) }
                    override fun onClosed() { closed.complete(Unit) }
                })
                closed.await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ResponderException) {
                if (e.kind == ResponderException.Kind.SIGNED_OUT) { handleSignedOut(); return }
                fail(e)
            } finally {
                socket?.close()
            }
            setConnection(Connection.RECONNECTING)
            delay(backoff.next())
        }
    }

    private fun setConnection(c: Connection) = _state.update { it.copy(connection = c) }
    private fun setBusy(b: Boolean) = _state.update { it.copy(busy = b) }

    private fun fail(e: ResponderException) {
        if (e.kind == ResponderException.Kind.SIGNED_OUT) handleSignedOut()
        _state.update { it.copy(error = e) }
    }

    private fun handleSignedOut() {
        liveJob?.cancel(); liveJob = null
        presenceJob?.cancel(); presenceJob = null
        offlineJob?.cancel(); offlineJob = null
        held = LinkedHashMap(); cursorMs = null
        _state.update { ResponderState(error = ResponderException(ResponderException.Kind.SIGNED_OUT)) }
    }

    companion object {
        const val POLL_MS = 15_000L
        const val RESYNC_MS = 120_000L
        const val DEBOUNCE_MS = 300L
        const val OVERLAP_MS = 1_000L
        const val PRESENCE_INTERVAL_MS = 60_000L
    }
}
