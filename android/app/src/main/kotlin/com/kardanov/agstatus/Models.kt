package com.kardanov.agstatus

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * Core value types, mirroring the iOS app's Models.swift so both clients speak
 * the same wire format. Decoding is deliberately tolerant: an older or newer
 * server must never crash the board.
 */

// MARK: - AgentStatus

@Serializable(with = AgentStatusSerializer::class)
enum class AgentStatus(val wire: String) {
    IDLE("idle"),
    PLANNING("planning"),
    CODING("coding"),
    TESTING("testing"),
    BLOCKED("blocked"),
    DONE("done");

    /** Capitalized English label, e.g. "Coding". */
    val label: String get() = wire.replaceFirstChar { it.uppercase() }

    /** Statuses that represent an agent actively working. */
    val isActive: Boolean get() = this == PLANNING || this == CODING || this == TESTING

    companion object {
        /** Unknown status strings degrade to idle rather than failing the parse. */
        fun fromWire(value: String?): AgentStatus =
            entries.firstOrNull { it.wire == value } ?: IDLE
    }
}

object AgentStatusSerializer : KSerializer<AgentStatus> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("AgentStatus", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): AgentStatus =
        AgentStatus.fromWire(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: AgentStatus) =
        encoder.encodeString(value.wire)
}

// MARK: - Session

@Serializable
data class Session(
    val id: String,
    val name: String = "",
    val status: AgentStatus = AgentStatus.IDLE,
    val message: String = "",
    val project: String = "",
    /** Agent kind that owns the session ("claude", "codex", …). */
    val source: String = "claude",
    /** Epoch milliseconds. */
    val createdAt: Long = 0,
    /** Epoch milliseconds. */
    val updatedAt: Long = 0,
) {
    /** Falls back to the id so a card is never nameless. */
    val displayName: String get() = name.ifBlank { id }
}

// MARK: - History

/** One entry in a session's timeline: what the agent switched to, and when. */
@Serializable
data class HistoryEvent(
    /** Server-assigned, monotonically increasing per session. */
    val seq: Long,
    val status: AgentStatus = AgentStatus.IDLE,
    val message: String = "",
    /** Epoch milliseconds. */
    val at: Long = 0,
)

// MARK: - Usage

/** One plan-limit window (the 5-hour session window or a weekly cap). */
@Serializable
data class UsageWindow(
    val id: String,
    val label: String = "",
    /** Percent of the limit consumed, 0–100. */
    val usedPct: Double = 0.0,
    /** Epoch milliseconds when the window resets; null when unknown. */
    val resetsAt: Long? = null,
) {
    val displayLabel: String get() = label.ifBlank { id }

    /** Clamped, because a server is free to send nonsense. */
    val fraction: Float get() = (usedPct / 100.0).coerceIn(0.0, 1.0).toFloat()
}

/** Plan usage reported by one agent kind. */
@Serializable
data class UsageInfo(
    val source: String,
    val windows: List<UsageWindow> = emptyList(),
    val updatedAt: Long = 0,
) {
    /** Human name for the source, e.g. "Claude". */
    val displayName: String get() = when (source) {
        "claude" -> "Claude"
        "codex" -> "Codex"
        else -> source.replaceFirstChar { it.uppercase() }
    }
}

// MARK: - Board

/**
 * A server plus optional workspace token. `token == null` means a legacy
 * single-tenant server whose board lives at the origin itself.
 */
data class Board(
    /** Origin with no trailing slash, e.g. https://agstatus.online */
    val baseUrl: String,
    val token: String? = null,
) {
    /** `<base>/w/<token>` for multi-tenant boards, or the base itself. */
    val boardUrl: String get() = if (token == null) baseUrl else "$baseUrl/w/$token"

    /** Where agents POST status updates. */
    val webhookUrl: String get() = "$boardUrl/webhook"

    val isDefaultServer: Boolean get() = baseUrl.trimEnd('/') == DEFAULT_SERVER

    companion object {
        /** The public default server. Constant lives here, in one place. */
        const val DEFAULT_SERVER = "https://agstatus.online"

        val TOKEN_REGEX = Regex("^ags_[A-Za-z0-9_-]{32}$")

        /**
         * Parses a board URL as scanned or pasted by a user. Accepts
         * `https://host/w/ags_<32>` with or without a trailing slash or a
         * `/webhook` suffix, and plain origins (legacy, token null).
         */
        fun parse(raw: String): Board? {
            val trimmed = raw.trim()
            if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null

            val withoutScheme = trimmed.substringAfter("://")
            if (withoutScheme.isBlank() || withoutScheme.startsWith("/")) return null

            val scheme = trimmed.substringBefore("://")
            val hostAndPort = withoutScheme.substringBefore('/')
            if (hostAndPort.isBlank()) return null
            val origin = "$scheme://$hostAndPort"

            var path = withoutScheme.substringAfter('/', "").trimEnd('/')
            if (path.endsWith("/webhook")) path = path.removeSuffix("/webhook").trimEnd('/')
            if (path == "webhook") path = ""

            if (path.isEmpty()) return Board(origin, null)

            val parts = path.split('/')
            if (parts.size != 2 || parts[0] != "w" || !TOKEN_REGEX.matches(parts[1])) return null
            return Board(origin, parts[1])
        }
    }
}

// MARK: - Pairing

@Serializable
data class PairCode(
    /** Dash-grouped pairing code, e.g. "AB12-CD34". */
    val code: String,
    val expiresInSeconds: Int = 0,
) {
    /** The terminal command a user runs to wire their machine to the board. */
    fun command(board: Board): String = buildString {
        append("npx agstatus init --code ")
        append(code)
        if (!board.isDefaultServer) {
            append(" --url ")
            append(board.baseUrl)
        }
    }
}

/** `POST /api/workspaces` and `POST /api/pair/claim` both answer with this. */
@Serializable
data class WorkspaceResponse(val token: String)

/** Subset of `GET /api/config` the app cares about. */
@Serializable
data class ServerConfig(
    val mode: String? = null,
    val push: Boolean? = null,
)
