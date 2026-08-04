package com.kardanov.agstatus

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import okhttp3.CacheControl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/**
 * Server-Sent Events client for `<board>/events`. okhttp-sse parses the wire
 * format; this maps the named frames onto typed events. The store owns
 * reconnect and backoff.
 */

// MARK: - SseEvent

sealed interface SseEvent {
    data class Snapshot(val sessions: List<Session>) : SseEvent
    data class Upsert(val session: Session) : SseEvent
    data class Remove(val id: String) : SseEvent
    data class Usage(val usage: List<UsageInfo>) : SseEvent
}

// MARK: - SseClient

class SseClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // The stream is expected to stay open indefinitely — the server sends a
        // keepalive comment every 25s — so read and call timeouts are disabled.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    /**
     * Connects to `<board>/events` and emits parsed events until the stream
     * ends (flow completes) or fails (flow throws: 404 → boardNotFound,
     * 429 → rateLimited, network → unreachable). Unknown event names and
     * undecodable payloads are dropped, never fatal.
     */
    fun events(board: Board): Flow<SseEvent> = callbackFlow {
        val url = board.boardUrl.toHttpUrlOrNull()?.newBuilder()?.addPathSegment("events")?.build()
            ?: throw ApiException.unreachable()
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .cacheControl(CacheControl.FORCE_NETWORK)
            .build()

        val listener = object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                decodeEvent(type, data)?.let { trySend(it) }
            }

            override fun onClosed(eventSource: EventSource) {
                close()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val status = response?.code
                close(
                    if (status != null && status !in 200..299) ApiException.forStatus(status)
                    else ApiException.unreachable()
                )
            }
        }

        val source = EventSources.createFactory(client).newEventSource(request, listener)
        awaitClose { source.cancel() }
    }
        // The store's state is a fold over this stream, so a slow collector must
        // never cost an event.
        .buffer(Channel.UNLIMITED)

    private fun decodeEvent(type: String?, data: String): SseEvent? = when (type) {
        "snapshot" -> decodeOrNull<List<Session>>(data)?.let { SseEvent.Snapshot(it) }
        "session" -> decodeOrNull<Session>(data)?.let { SseEvent.Upsert(it) }
        "remove" -> decodeOrNull<RemovePayload>(data)?.let { SseEvent.Remove(it.id) }
        "usage" -> decodeOrNull<List<UsageInfo>>(data)?.let { SseEvent.Usage(it) }
        else -> null
    }

    private inline fun <reified T> decodeOrNull(data: String): T? =
        try {
            AgStatusJson.decodeFromString<T>(data)
        } catch (malformed: IllegalArgumentException) {
            null
        }

    @Serializable
    private data class RemovePayload(val id: String)
}
