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
import kotlin.math.min

/**
 * App state: the adopted board, the live session list (always sorted by
 * updatedAt desc), the SSE connection lifecycle with backoff, and demo mode.
 * Mirrors the iOS SessionStore.
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

    val isDemo: Boolean get() = _connection.value == Connection.DEMO

    private val sse = SseClient()
    private var streamJob: Job? = null
    private var demoJob: Job? = null
    private var cachedPairCode: CachedPairCode? = null

    private data class CachedPairCode(val code: PairCode, val fetchedAtMillis: Long)

    // MARK: Lifecycle

    init {
        _board.value = BoardStorage.load(app)
        if (_board.value != null) connect()
    }

    /** Saves the board and starts streaming. Stops demo mode if active. */
    fun adopt(board: Board) {
        stopDemoJob()
        _board.value = board
        BoardStorage.save(getApplication<Application>(), board)
        _sessions.value = emptyList()
        _usage.value = emptyList()
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
        streamJob = viewModelScope.launch { runStream(current) }
    }

    /** Cancels the stream job. */
    fun disconnect() {
        cancelStream()
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
                            _sessions.value = sortedByUpdate(event.sessions)
                            _connection.value = Connection.LIVE
                            backoffMillis = INITIAL_BACKOFF_MILLIS
                        }
                        is SseEvent.Upsert -> {
                            val others = _sessions.value.filter { it.id != event.session.id }
                            _sessions.value = sortedByUpdate(others + event.session)
                        }
                        is SseEvent.Remove ->
                            _sessions.value = _sessions.value.filter { it.id != event.id }
                        is SseEvent.Usage -> _usage.value = event.usage
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
            _connection.value = Connection.RECONNECTING
            delay(backoffMillis)
            backoffMillis = min(backoffMillis * 2, MAX_BACKOFF_MILLIS)
        }
    }

    // MARK: Data

    /**
     * Fetches the session list and merges it in, never resurrecting local
     * sessions that are newer than what the server returned.
     */
    suspend fun refresh() {
        if (isDemo) return
        val current = _board.value ?: return
        val fetchStart = System.currentTimeMillis()

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

        // Usage is a best-effort side fetch — a failure changes nothing.
        try {
            _usage.value = AgStatusApi.usage(current)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
        }

        val merged = LinkedHashMap<String, Session>()
        for (session in fetched) {
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
        _sessions.value = sortedByUpdate(merged.values.toList())
    }

    /**
     * Optimistically removes the session, then deletes it on the server.
     * On failure the session is re-added and the list refreshed.
     */
    suspend fun dismiss(session: Session) {
        if (isDemo) {
            _sessions.value = _sessions.value.filter { it.id != session.id }
            return
        }
        val current = _board.value ?: return

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
                _sessions.value = sortedByUpdate(_sessions.value + session)
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

    // MARK: Demo mode

    /** Board-less fake mode driven by DemoData on a ~4s tick. */
    fun startDemo() {
        cancelStream()
        stopDemoJob()
        _sessions.value = sortedByUpdate(DemoData.initialSessions())
        _usage.value = DemoData.usage()
        _connection.value = Connection.DEMO
        demoJob = viewModelScope.launch {
            while (isActive) {
                delay(DEMO_TICK_MILLIS)
                if (_connection.value != Connection.DEMO) return@launch
                _sessions.value = sortedByUpdate(DemoData.tick(_sessions.value))
            }
        }
    }

    fun stopDemo() {
        stopDemoJob()
        if (_connection.value != Connection.DEMO) return
        _sessions.value = emptyList()
        _usage.value = emptyList()
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

    private companion object {
        const val INITIAL_BACKOFF_MILLIS = 1_000L
        const val MAX_BACKOFF_MILLIS = 30_000L
        const val DEMO_TICK_MILLIS = 4_000L

        fun sortedByUpdate(sessions: List<Session>): List<Session> =
            sessions.sortedByDescending { it.updatedAt }
    }
}
