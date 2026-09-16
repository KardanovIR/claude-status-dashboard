package com.kardanov.agstatus

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.min

/**
 * App state: the adopted board, the live session list (newest first when it
 * first fills; after that rows keep their position as events arrive and new
 * sessions join at the top), the SSE connection lifecycle with backoff,
 * Focus presence and commands, and demo mode. Mirrors the iOS SessionStore.
 */
class SessionStore(app: Application) : AndroidViewModel(app) {

    enum class Connection { IDLE, CONNECTING, LIVE, RECONNECTING, BOARD_GONE, DEMO }

    // MARK: State

    private val _sessions = MutableStateFlow<List<Session>>(emptyList())
    val sessions: StateFlow<List<Session>> = _sessions.asStateFlow()

    private val _usage = MutableStateFlow<List<UsageInfo>>(emptyList())
    val usage: StateFlow<List<UsageInfo>> = _usage.asStateFlow()

    private val _connection = MutableStateFlow(Connection.IDLE)
    val connection: StateFlow<Connection> = _connection.asStateFlow()

    private val _board = MutableStateFlow<Board?>(null)
    val board: StateFlow<Board?> = _board.asStateFlow()

    /**
     * Wall clock of the last real board activity (a session update or removal;
     * demo ticks count too). Drives the keep-awake idle countdown — reconnect
     * snapshots and usage trickle deliberately don't reset it. Mirrors iOS.
     */
    private val _lastActivityAt = MutableStateFlow(System.currentTimeMillis())
    val lastActivityAt: StateFlow<Long> = _lastActivityAt.asStateFlow()

    private val _keepAwake = MutableStateFlow(false)
    val keepAwake: StateFlow<Boolean> = _keepAwake.asStateFlow()

    /** Minutes of board silence before the screen may sleep again; 0 = never. */
    private val _keepAwakeIdleMinutes = MutableStateFlow(DEFAULT_IDLE_MINUTES)
    val keepAwakeIdleMinutes: StateFlow<Int> = _keepAwakeIdleMinutes.asStateFlow()

    val isDemo: Boolean get() = _connection.value == Connection.DEMO

    /**
     * Focus listeners by machine id — the `machines` frame after every
     * snapshot re-seeds it, single `machine` frames keep it current. An entry
     * that went offline stays, so the card can say since when.
     */
    private val _machines = MutableStateFlow<Map<String, MachinePresence>>(emptyMap())
    val machines: StateFlow<Map<String, MachinePresence>> = _machines.asStateFlow()

    /** The latest Focus command each card is showing, by session id. */
    private val _focus = MutableStateFlow<Map<String, FocusStatus>>(emptyMap())
    val focus: StateFlow<Map<String, FocusStatus>> = _focus.asStateFlow()

    /** Per session, the timer its status waits on: the ack watchdog, or a success's fade. */
    private val focusTimers = HashMap<String, Job>()

    private val sse = SseClient()
    private var streamJob: Job? = null
    private var demoJob: Job? = null
    private var cachedPairCode: CachedPairCode? = null

    private data class CachedPairCode(val code: PairCode, val fetchedAtMillis: Long)

    // MARK: Lifecycle

    init {
        val prefs = app.getSharedPreferences(DISPLAY_PREFS, Application.MODE_PRIVATE)
        _keepAwake.value = prefs.getBoolean(KEY_KEEP_AWAKE, false)
        _keepAwakeIdleMinutes.value = prefs.getInt(KEY_IDLE_MINUTES, DEFAULT_IDLE_MINUTES)

        _board.value = BoardStorage.load(app)
        if (_board.value != null) connect()
    }

    fun setKeepAwake(enabled: Boolean) {
        _keepAwake.value = enabled
        displayPrefs().edit().putBoolean(KEY_KEEP_AWAKE, enabled).apply()
    }

    fun setKeepAwakeIdleMinutes(minutes: Int) {
        _keepAwakeIdleMinutes.value = minutes
        displayPrefs().edit().putInt(KEY_IDLE_MINUTES, minutes).apply()
    }

    private fun displayPrefs() =
        getApplication<Application>().getSharedPreferences(DISPLAY_PREFS, Application.MODE_PRIVATE)

    /** Saves the board and starts streaming. Stops demo mode if active. */
    fun adopt(board: Board) {
        stopDemoJob()
        _board.value = board
        BoardStorage.save(getApplication<Application>(), board)
        _sessions.value = emptyList()
        _usage.value = emptyList()
        clearFocus()
        cachedPairCode = null
        connect()
    }

    /** Forgets the board on this device only; the server is untouched. */
    fun disconnectBoard() {
        stopDemoJob()
        cancelStream()
        _board.value = null
        BoardStorage.clear(getApplication<Application>())
        _sessions.value = emptyList()
        _usage.value = emptyList()
        clearFocus()
        cachedPairCode = null
        _connection.value = Connection.IDLE
    }

    /**
     * Deletes the board on the server, then disconnects locally.
     * A board that is already gone counts as success.
     */
    suspend fun deleteBoardEverywhere() {
        val current = _board.value
        if (current == null) {
            disconnectBoard()
            return
        }
        try {
            AgStatusApi.deleteBoard(current)
        } catch (error: ApiException) {
            if (error.kind != ApiException.Kind.BOARD_NOT_FOUND) throw error
        }
        disconnectBoard()
    }

    // MARK: Streaming

    /**
     * Starts (or restarts) the SSE job. Reconnects with exponential backoff,
     * 1s doubling to 30s, reset after a successful snapshot. A 404 sets
     * BOARD_GONE and stops until adopt()/connect().
     */
    fun connect() {
        val current = _board.value ?: return
        stopDemoJob()
        cancelStream()
        _connection.value = Connection.CONNECTING
        _lastActivityAt.value = System.currentTimeMillis()
        streamJob = viewModelScope.launch { runStream(current) }
    }

    /**
     * Cancels the stream job. A command still waiting for its ack loses its
     * watchdog here: the activity is going to the background, and on return
     * the snapshot asks the server how it ended — so a stale timer can't
     * declare "asleep" over an answer already waiting there. The status
     * itself stays pending. Should the reconnect fail instead, runStream
     * puts the deadline back.
     */
    fun disconnect() {
        cancelStream()
        for ((sessionId, status) in _focus.value) {
            if (status.awaitsAck) focusTimers.remove(sessionId)?.cancel()
        }
        when (_connection.value) {
            Connection.CONNECTING, Connection.LIVE, Connection.RECONNECTING ->
                _connection.value = Connection.IDLE
            Connection.IDLE, Connection.BOARD_GONE, Connection.DEMO -> Unit
        }
    }

    private suspend fun runStream(board: Board) = coroutineScope {
        var backoffMillis = INITIAL_BACKOFF_MILLIS

        while (isActive) {
            try {
                sse.events(board).collect { event ->
                    when (event) {
                        is SseEvent.Snapshot -> {
                            _sessions.value = stableOrder(_sessions.value, event.sessions)
                            _connection.value = Connection.LIVE
                            backoffMillis = INITIAL_BACKOFF_MILLIS
                            // A card that left while we were away takes its
                            // command status with it; one still waiting asks
                            // the server for the ack it may have missed.
                            val present = event.sessions.mapTo(HashSet()) { it.id }
                            for (id in _focus.value.keys.toList()) {
                                if (id !in present) setFocus(id, null)
                            }
                            if (_focus.value.values.any { it.awaitsAck }) {
                                launch { resolvePendingCommands(board) }
                            }
                        }
                        is SseEvent.Upsert -> {
                            val current = _sessions.value
                            val index = current.indexOfFirst { it.id == event.session.id }
                            _sessions.value = if (index >= 0) {
                                current.toMutableList().also { it[index] = event.session }
                            } else {
                                listOf(event.session) + current
                            }
                            _lastActivityAt.value = System.currentTimeMillis()
                        }
                        is SseEvent.Remove -> {
                            _sessions.value = _sessions.value.filter { it.id != event.id }
                            setFocus(event.id, null)
                            _lastActivityAt.value = System.currentTimeMillis()
                        }
                        is SseEvent.Usage -> _usage.value = event.usage
                        is SseEvent.Machines ->
                            _machines.value = event.machines.associateBy { it.id }
                        is SseEvent.Machine -> {
                            val incoming = event.machine
                            _machines.value = _machines.value +
                                (incoming.id to incoming.mergedOver(_machines.value[incoming.id]))
                        }
                        is SseEvent.CommandAck -> handleAck(event.ack)
                    }
                }
                // Stream ended cleanly (server closed) — fall through to retry.
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: ApiException) {
                if (error.kind == ApiException.Kind.BOARD_NOT_FOUND) {
                    _connection.value = Connection.BOARD_GONE
                    return@coroutineScope
                }
            } catch (_: Exception) {
                // Transient failure — fall through to retry.
            }

            if (!isActive) return@coroutineScope
            // disconnect() dropped the ack watchdogs, and only a snapshot's
            // reconcile would bring them back — with the reconnect failing
            // there is none, so keep each pending card on its own deadline.
            // A snapshot's reconcile still wins if it arrives first.
            for ((sessionId, status) in _focus.value) {
                if (status.awaitsAck) keepAckWindow(sessionId, status)
            }
            _connection.value = Connection.RECONNECTING
            delay(backoffMillis)
            backoffMillis = min(backoffMillis * 2, MAX_BACKOFF_MILLIS)
        }
    }

    // MARK: Data

    /**
     * Fetches the session list and merges it in, never resurrecting local
     * sessions that are newer than what the server returned, nor sessions
     * removed while the fetch was in flight.
     */
    suspend fun refresh() {
        if (isDemo) return
        val current = _board.value ?: return
        val fetchStart = System.currentTimeMillis()
        val idsAtFetchStart = _sessions.value.mapTo(HashSet()) { it.id }

        val fetched = try {
            AgStatusApi.sessions(current)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            if (error is ApiException && error.kind == ApiException.Kind.BOARD_NOT_FOUND) {
                cancelStream()
                _connection.value = Connection.BOARD_GONE
            }
            return // transient — keep what we have
        }

        // Usage and presence are best-effort side fetches — a failure changes nothing.
        try {
            _usage.value = AgStatusApi.usage(current)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
        }
        try {
            _machines.value = AgStatusApi.machines(current).associateBy { it.id }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
        }

        // A fetched session we knew at fetch start but no longer hold was
        // removed mid-fetch (dismissed here, elsewhere, or swept) — the fetch
        // predates that removal, so re-adding it would resurrect a ghost.
        val currentIds = _sessions.value.mapTo(HashSet()) { it.id }
        val merged = LinkedHashMap<String, Session>()
        for (session in fetched) {
            if (session.id in idsAtFetchStart && session.id !in currentIds) continue
            merged[session.id] = session
        }
        for (local in _sessions.value) {
            val remote = merged[local.id]
            if (remote != null) {
                if (local.updatedAt > remote.updatedAt) {
                    merged[local.id] = local // SSE beat the fetch
                }
            } else if (local.updatedAt > fetchStart) {
                merged[local.id] = local // arrived via SSE mid-fetch
            }
        }
        _sessions.value = stableOrder(_sessions.value, merged.values.toList())
    }

    /**
     * Optimistically removes the session, then deletes it on the server.
     * On failure the session returns to its old spot and the list refreshes.
     */
    suspend fun dismiss(session: Session) {
        if (isDemo) {
            _sessions.value = _sessions.value.filter { it.id != session.id }
            return
        }
        val current = _board.value ?: return

        // Anchor the restore spot to the row below rather than a numeric
        // index, which SSE events arriving during the DELETE would shift.
        val index = _sessions.value.indexOfFirst { it.id == session.id }
        val successorId = if (index >= 0) _sessions.value.getOrNull(index + 1)?.id else null
        _sessions.value = _sessions.value.filter { it.id != session.id }
        try {
            AgStatusApi.deleteSession(current, session.id)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            if (error is ApiException && error.kind == ApiException.Kind.BOARD_NOT_FOUND) {
                cancelStream()
                _connection.value = Connection.BOARD_GONE
                return
            }
            if (_sessions.value.none { it.id == session.id }) {
                val list = _sessions.value.toMutableList()
                val below = successorId?.let { id -> list.indexOfFirst { it.id == id } } ?: -1
                val at = when {
                    below >= 0 -> below
                    index >= 0 && successorId == null -> list.size // was the bottom row
                    else -> index.coerceIn(0, list.size)
                }
                list.add(at, session)
                _sessions.value = list
            }
            refresh()
        }
    }

    /**
     * Returns a pairing code, reusing the last unexpired one so reopening the
     * sheet doesn't burn through the server's 3-outstanding-codes cap.
     * `forceNew` mints a fresh code (e.g. after pairing a first machine).
     */
    suspend fun pairCode(forceNew: Boolean = false): PairCode {
        val current = _board.value ?: throw ApiException(
            0,
            ApiException.Kind.LEGACY_SERVER,
            "This server doesn't support pairing codes.",
        )
        if (!forceNew) {
            val cached = cachedPairCode
            if (cached != null) {
                val elapsed = (System.currentTimeMillis() - cached.fetchedAtMillis) / 1000
                val remaining = cached.code.expiresInSeconds - elapsed
                if (remaining > 60) {
                    return PairCode(cached.code.code, remaining.toInt())
                }
            }
        }
        val fresh = AgStatusApi.createPairCode(current)
        cachedPairCode = CachedPairCode(fresh, System.currentTimeMillis())
        return fresh
    }

    /**
     * Recorded limit history and per-project tokens behind the usage detail
     * screen. Demo mode synthesises it offline; a server too old to serve the
     * endpoint — or any transient failure — degrades to an empty screen.
     */
    suspend fun usageHistory(days: Int = UsageDetail.DEFAULT_DAYS): UsageHistory {
        if (isDemo) return DemoData.usageHistory(days)
        val current = _board.value ?: return UsageHistory(days = days)
        return try {
            AgStatusApi.usageHistory(current, days)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            UsageHistory(days = days)
        }
    }

    /** A session's timeline, newest first. Failures read as an empty history. */
    suspend fun history(sessionId: String): List<HistoryEvent> {
        if (isDemo) {
            val session = _sessions.value.firstOrNull { it.id == sessionId } ?: return emptyList()
            return DemoData.history(session)
        }
        val current = _board.value ?: return emptyList()
        return try {
            AgStatusApi.history(current, sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            emptyList()
        }
    }

    // MARK: Focus

    /**
     * Sends a Focus command for [sessionId] — the explicit control on a card,
     * never its tap. The status goes "Sending…" → "Sent…" → the ack's copy;
     * a re-tap replaces the status, so only the newest command is honoured.
     * No ack within [ACK_TIMEOUT_MILLIS] reads as "is it asleep?".
     */
    fun sendCommand(sessionId: String, type: CommandType) {
        val session = _sessions.value.firstOrNull { it.id == sessionId } ?: return
        val host = session.host ?: return
        val name = FocusCopy.machineLabel(host, _machines.value)
        val status = FocusStatus(
            commandId = UUID.randomUUID().toString(),
            type = type,
            machineName = name,
            appName = host.app.displayName,
            startedAt = System.currentTimeMillis(),
        )
        setFocus(sessionId, status)
        armWatchdog(sessionId, status, ACK_TIMEOUT_MILLIS)

        if (isDemo) {
            viewModelScope.launch { demoAck(sessionId, status, host) }
            return
        }
        val current = _board.value
        if (current == null) {
            showResult(sessionId, status.commandId, FocusStatus.Phase.FAIL, FocusCopy.sendFailed(0))
            return
        }
        viewModelScope.launch {
            val receipt = try {
                AgStatusApi.sendCommand(current, CommandRequest(status.commandId, type.wire, sessionId))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                // No status means the transport failed, so the POST may have
                // created the command and only its answer been lost.
                val httpStatus = (error as? ApiException)?.status ?: 0
                showResult(
                    sessionId, status.commandId, FocusStatus.Phase.FAIL,
                    FocusCopy.sendFailed(httpStatus), provisional = httpStatus == 0,
                )
                return@launch
            }
            markSent(sessionId, status.commandId, receipt.delivered)
        }
    }

    /** The demo's listener: answers a beat later, always successfully. */
    private suspend fun demoAck(sessionId: String, status: FocusStatus, host: SessionHost) {
        delay(DEMO_SEND_MILLIS)
        markSent(sessionId, status.commandId, delivered = true)
        delay(DEMO_ACK_MILLIS)
        val result = if (status.type == CommandType.RESUME) CommandResult.RESUMED else CommandResult.FOCUSED
        handleAck(
            CommandAck(
                id = status.commandId,
                sessionId = sessionId,
                machineId = host.machine.id,
                type = status.type.wire,
                result = result.wire,
                reach = CommandReach.TAB.wire,
            ),
        )
    }

    /** The POST was accepted; say whether anyone is there to receive it. */
    private fun markSent(sessionId: String, commandId: String, delivered: Boolean) {
        val current = _focus.value[sessionId] ?: return
        // A newer tap, or an ack that beat the response, already took over.
        if (current.commandId != commandId || current.done) return
        _focus.value = _focus.value +
            (sessionId to current.copy(text = FocusCopy.sent(current.machineName, delivered)))
    }

    private fun handleAck(ack: CommandAck) {
        val current = _focus.value[ack.sessionId] ?: return
        // Only the command this card is waiting on: an older one that a re-tap
        // superseded, or a stray ack, has nothing to say to the viewer.
        if (current.commandId != ack.id || (current.done && !current.provisional)) return
        val outcome = FocusCopy.outcome(current, ack)
        showResult(ack.sessionId, ack.id, outcome.phase, outcome.text, outcome.offersResume)
    }

    /**
     * A final outcome for [commandId], if the card is still waiting on it.
     * Successes fade after [STATUS_CLEAR_MILLIS]; failures stay until the
     * next tap.
     */
    private fun showResult(
        sessionId: String,
        commandId: String,
        phase: FocusStatus.Phase,
        text: String,
        offersResume: Boolean = false,
        provisional: Boolean = false,
    ) {
        val current = _focus.value[sessionId] ?: return
        // A guess may be overwritten by the answer that arrives late; an answer
        // is final.
        if (current.commandId != commandId || (current.done && !current.provisional)) return
        focusTimers.remove(sessionId)?.cancel()
        val shown = current.copy(
            phase = phase, text = text, offersResume = offersResume, provisional = provisional,
        )
        _focus.value = _focus.value + (sessionId to shown)
        if (phase == FocusStatus.Phase.OK) {
            focusTimers[sessionId] = viewModelScope.launch {
                delay(STATUS_CLEAR_MILLIS)
                if (_focus.value[sessionId] == shown) setFocus(sessionId, null)
            }
        }
    }

    /**
     * The activity drops the stream while backgrounded (MainActivity.onStop),
     * so an ack can land while nobody is listening — and disconnect() took
     * the watchdog with it. After the reconnect's snapshot, ask the server
     * how each command still shown as pending ended: done or expired reads
     * as its ack; one the server no longer knows (swept, or restarted) is
     * asleep; anything else keeps what is left of the window since the tap.
     */
    private suspend fun resolvePendingCommands(board: Board) {
        for ((sessionId, status) in _focus.value) {
            if (!status.awaitsAck) continue
            val state = try {
                AgStatusApi.command(board, status.commandId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                keepAckWindow(sessionId, status) // transient — the deadline has the last word
                continue
            }
            when {
                state == null -> showResult(
                    sessionId,
                    status.commandId,
                    FocusStatus.Phase.FAIL,
                    FocusCopy.noAnswer(status.machineName),
                )
                state.isFinished -> handleAck(state.asAck().copy(sessionId = sessionId))
                else -> keepAckWindow(sessionId, status)
            }
        }
    }

    /** Whether [commandId] is still the command the card is waiting on. */
    private fun isCurrent(sessionId: String, commandId: String): Boolean {
        val current = _focus.value[sessionId] ?: return false
        return current.commandId == commandId && !current.done
    }

    /** No ack within [afterMillis] → "is it asleep?". Replaces any watchdog already running. */
    private fun armWatchdog(sessionId: String, status: FocusStatus, afterMillis: Long) {
        focusTimers.remove(sessionId)?.cancel()
        focusTimers[sessionId] = viewModelScope.launch {
            delay(afterMillis)
            showResult(
                sessionId, status.commandId, FocusStatus.Phase.FAIL,
                FocusCopy.noAnswer(status.machineName), provisional = true,
            )
        }
    }

    /**
     * Re-arms the watchdog for what is left of the [ACK_TIMEOUT_MILLIS]
     * window since the tap — or, with nothing left, declares the machine
     * asleep. A card that has moved on (a re-tap, an ack) is left alone.
     */
    private fun keepAckWindow(sessionId: String, status: FocusStatus) {
        if (!isCurrent(sessionId, status.commandId)) return
        val remaining = status.ackWindowLeft(System.currentTimeMillis(), ACK_TIMEOUT_MILLIS)
        if (remaining <= 0) {
            showResult(
                sessionId, status.commandId, FocusStatus.Phase.FAIL,
                FocusCopy.noAnswer(status.machineName), provisional = true,
            )
        } else {
            armWatchdog(sessionId, status, remaining)
        }
    }

    private fun setFocus(sessionId: String, status: FocusStatus?) {
        focusTimers.remove(sessionId)?.cancel()
        _focus.value = if (status == null) _focus.value - sessionId else _focus.value + (sessionId to status)
    }

    /** Leaving a board (or demo) forgets its machines and every card's status. */
    private fun clearFocus() {
        focusTimers.values.forEach { it.cancel() }
        focusTimers.clear()
        _focus.value = emptyMap()
        _machines.value = emptyMap()
    }

    // MARK: Demo mode

    /** Board-less fake mode driven by DemoData on a ~4s tick. */
    fun startDemo() {
        cancelStream()
        stopDemoJob()
        clearFocus()
        _sessions.value = sortedByUpdate(DemoData.initialSessions())
        _usage.value = DemoData.usage()
        _machines.value = DemoData.machines().associateBy { it.id }
        _connection.value = Connection.DEMO
        demoJob = viewModelScope.launch {
            while (isActive) {
                delay(DEMO_TICK_MILLIS)
                if (_connection.value != Connection.DEMO) return@launch
                _sessions.value = stableOrder(_sessions.value, DemoData.tick(_sessions.value))
                _lastActivityAt.value = System.currentTimeMillis()
            }
        }
    }

    fun stopDemo() {
        stopDemoJob()
        if (_connection.value != Connection.DEMO) return
        _sessions.value = emptyList()
        _usage.value = emptyList()
        clearFocus()
        _connection.value = Connection.IDLE
        if (_board.value != null) connect()
    }

    // MARK: Helpers

    private fun cancelStream() {
        streamJob?.cancel()
        streamJob = null
    }

    private fun stopDemoJob() {
        demoJob?.cancel()
        demoJob = null
    }

    internal companion object {
        private const val INITIAL_BACKOFF_MILLIS = 1_000L
        private const val MAX_BACKOFF_MILLIS = 30_000L
        private const val DEMO_TICK_MILLIS = 4_000L
        private const val DEMO_SEND_MILLIS = 350L
        private const val DEMO_ACK_MILLIS = 900L

        /** No ack by then → "is it asleep?" (the server's own TTL is 2 min). */
        private const val ACK_TIMEOUT_MILLIS = 15_000L

        /** How long a success stays on the card; failures stay until the next tap. */
        private const val STATUS_CLEAR_MILLIS = 8_000L
        private const val DISPLAY_PREFS = "agstatus_display"
        private const val KEY_KEEP_AWAKE = "keep_awake"
        private const val KEY_IDLE_MINUTES = "keep_awake_idle_minutes"
        private const val DEFAULT_IDLE_MINUTES = 10

        fun sortedByUpdate(sessions: List<Session>): List<Session> =
            sessions.sortedByDescending { it.updatedAt }

        /**
         * Arranges [incoming] so sessions already on screen keep their relative
         * order (with fresh data) and unseen ones join at the top, newest
         * first. With nothing on screen this is a plain newest-first sort.
         */
        fun stableOrder(current: List<Session>, incoming: List<Session>): List<Session> {
            val incomingById = incoming.associateBy { it.id }
            val kept = current.mapNotNull { incomingById[it.id] }
            val currentIds = current.mapTo(HashSet()) { it.id }
            val fresh = incoming.filter { it.id !in currentIds }
            return sortedByUpdate(fresh) + kept
        }
    }
}
