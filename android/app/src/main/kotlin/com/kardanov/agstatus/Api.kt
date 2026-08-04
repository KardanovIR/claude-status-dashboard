package com.kardanov.agstatus

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.CacheControl
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * REST client for the status server, mirroring the iOS app's API.swift:
 * config probing, workspace creation, session listing, dismissal, board
 * deletion and pairing codes. One shared OkHttp client with a 10s call
 * timeout; every call runs on the IO dispatcher.
 */

// MARK: - ApiException

class ApiException(val status: Int, val kind: Kind, message: String) : Exception(message) {

    enum class Kind { UNREACHABLE, BOARD_NOT_FOUND, RATE_LIMITED, AT_CAPACITY, LEGACY_SERVER, BAD_RESPONSE }

    companion object {
        fun unreachable() =
            ApiException(0, Kind.UNREACHABLE, "Can't reach the server. Check your connection and try again.")

        fun boardNotFound() =
            ApiException(404, Kind.BOARD_NOT_FOUND, "This board no longer exists.")

        fun rateLimited() =
            ApiException(429, Kind.RATE_LIMITED, "Too many requests. Wait a moment and try again.")

        fun atCapacity() =
            ApiException(503, Kind.AT_CAPACITY, "The server is at capacity right now. Try again later.")

        fun legacyServer() =
            ApiException(0, Kind.LEGACY_SERVER, "This server doesn't support pairing codes.")

        fun badResponse(status: Int) =
            ApiException(status, Kind.BAD_RESPONSE, "Unexpected server response ($status).")

        /** Maps a non-2xx HTTP status onto the error the UI shows. */
        fun forStatus(status: Int): ApiException = when (status) {
            404 -> boardNotFound()
            429 -> rateLimited()
            503 -> atCapacity()
            else -> badResponse(status)
        }
    }
}

/** Tolerant decoder shared by the REST and SSE clients. */
internal val AgStatusJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

// MARK: - AgStatusApi

object AgStatusApi {

    private val client = OkHttpClient.Builder()
        .callTimeout(10, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json".toMediaType()

    // MARK: Public surface

    /** Probes `<base>/api/config`. Unknown/missing modes are treated as legacy. */
    suspend fun serverMode(baseUrl: String): String {
        val url = origin(baseUrl).append("api", "config")
        val config = decode<ServerConfig>(send("GET", url))
        return if (config.mode == "multi") "multi" else "legacy"
    }

    /**
     * Creates a fresh workspace on a multi-tenant server. The board is built
     * from the origin actually reached, not from the server-reported
     * dashboardUrl: a self-hosted server behind a proxy or on a LAN often
     * advertises a public URL this device can't route to.
     */
    suspend fun createBoard(baseUrl: String): Board {
        val serverOrigin = origin(baseUrl)
        val created = decode<WorkspaceResponse>(send("POST", serverOrigin.append("api", "workspaces")))
        return Board(serverOrigin.asBaseUrl(), created.token)
    }

    suspend fun sessions(board: Board): List<Session> =
        decode(send("GET", boardUrl(board).append("api", "sessions")))

    /**
     * Plan usage limits reported by the board's agents. Older servers have no
     * `/api/usage` — their 404 or HTML answer means "no usage data", not a
     * dead board.
     */
    suspend fun usage(board: Board): List<UsageInfo> {
        val body = sendAllowingMissingEndpoint("GET", boardUrl(board).append("api", "usage"))
            ?: return emptyList()
        return decodeOrNull<List<UsageInfo>>(body) ?: emptyList()
    }

    /**
     * A session's timeline, newest first. Servers without the endpoint just
     * yield an empty history.
     */
    suspend fun history(board: Board, sessionId: String): List<HistoryEvent> {
        val url = boardUrl(board).append("api", "sessions", sessionId, "history")
        val body = sendAllowingMissingEndpoint("GET", url) ?: return emptyList()
        return decodeOrNull<List<HistoryEvent>>(body) ?: emptyList()
    }

    suspend fun deleteSession(board: Board, id: String) {
        send("DELETE", boardUrl(board).append("sessions", id))
    }

    /** Deletes the whole board on the server (privacy reset). */
    suspend fun deleteBoard(board: Board) {
        send("DELETE", boardUrl(board))
    }

    suspend fun createPairCode(board: Board): PairCode {
        if (board.token == null) throw ApiException.legacyServer()
        return decode(send("POST", boardUrl(board).append("pair")))
    }

    /** Trades a pairing code shown by another device for that device's board. */
    suspend fun claimPairCode(baseUrl: String, code: String): Board {
        val serverOrigin = origin(baseUrl)
        val body = AgStatusJson.encodeToString(ClaimRequest(code))
        val claimed = decode<WorkspaceResponse>(send("POST", serverOrigin.append("api", "pair", "claim"), body))
        return Board(serverOrigin.asBaseUrl(), claimed.token)
    }

    // MARK: Requests

    /**
     * Performs a request and maps HTTP codes to ApiException
     * (404 → boardNotFound, 429 → rateLimited, 503 → atCapacity, other
     * non-2xx → badResponse). A non-null body is sent as JSON.
     */
    private suspend fun send(method: String, url: HttpUrl, body: String? = null): String =
        withContext(Dispatchers.IO) {
            val payload = when {
                body != null -> body.toRequestBody(jsonMediaType)
                method == "POST" -> ByteArray(0).toRequestBody()
                else -> null
            }
            val request = Request.Builder()
                .url(url)
                .method(method, payload)
                .header("Accept", "application/json")
                .cacheControl(CacheControl.FORCE_NETWORK)
                .build()

            val response = try {
                client.newCall(request).execute()
            } catch (transport: IOException) {
                throw ApiException.unreachable()
            }
            response.use {
                val text = try {
                    it.body?.string().orEmpty()
                } catch (transport: IOException) {
                    throw ApiException.unreachable()
                }
                if (!it.isSuccessful) throw ApiException.forStatus(it.code)
                text
            }
        }

    /** Like [send], but a 404 reads as "this server is too old" — null, not an error. */
    private suspend fun sendAllowingMissingEndpoint(method: String, url: HttpUrl): String? =
        try {
            send(method, url)
        } catch (error: ApiException) {
            if (error.kind == ApiException.Kind.BOARD_NOT_FOUND) null else throw error
        }

    // MARK: Decoding

    private inline fun <reified T> decode(body: String): T =
        decodeOrNull<T>(body) ?: throw ApiException.badResponse(200)

    private inline fun <reified T> decodeOrNull(body: String): T? =
        try {
            AgStatusJson.decodeFromString<T>(body)
        } catch (malformed: IllegalArgumentException) {
            null
        }

    // MARK: URLs

    /** Strips path, query and fragment, keeping scheme://host[:port]. */
    private fun origin(baseUrl: String): HttpUrl {
        val parsed = baseUrl.trim().toHttpUrlOrNull() ?: throw ApiException.unreachable()
        return parsed.newBuilder().encodedPath("/").query(null).fragment(null).build()
    }

    private fun boardUrl(board: Board): HttpUrl =
        board.boardUrl.toHttpUrlOrNull() ?: throw ApiException.unreachable()

    private fun HttpUrl.append(vararg segments: String): HttpUrl =
        newBuilder().apply { segments.forEach { addPathSegment(it) } }.build()

    /** Origin form Board expects: no trailing slash. */
    private fun HttpUrl.asBaseUrl(): String = toString().trimEnd('/')
}

// MARK: - Wire payloads

@Serializable
private data class ClaimRequest(val code: String)
