package com.kardanov.agstatus

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToLong

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
    val displayName: String get() = sourceDisplayName(source)
}

/**
 * Human name for an agent kind. Lives outside [UsageInfo] because the usage
 * detail screen names a source it may have no current reading for.
 */
fun sourceDisplayName(source: String): String = when (source) {
    "claude" -> "Claude"
    "codex" -> "Codex"
    else -> source.replaceFirstChar { it.uppercase() }
}

// MARK: - Usage history

/** One recorded reading of a limit window's utilization. */
@Serializable
data class UsagePoint(
    /** Epoch milliseconds. */
    val at: Long = 0,
    val usedPct: Double = 0.0,
)

/**
 * One window's recorded readings, oldest first. The server appends a point
 * only when the value changed, so this is a step function — and a board that
 * has only just started recording legitimately holds a single point.
 */
@Serializable
data class UsageSeries(
    val source: String = "",
    val windowId: String = "",
    val points: List<UsagePoint> = emptyList(),
)

/** Tokens one agent spent on one project during one UTC day — an absolute total. */
@Serializable
data class ProjectDay(
    val source: String = "",
    val project: String = "",
    /** YYYY-MM-DD, UTC. */
    val day: String = "",
    val tokens: Long = 0,
)

/**
 * `GET <board>/api/usage/history?days=N`. Both arrays cover every source, so
 * a view filters them down to the one it is showing.
 */
@Serializable
data class UsageHistory(
    val days: Int = UsageDetail.DEFAULT_DAYS,
    val history: List<UsageSeries> = emptyList(),
    val projects: List<ProjectDay> = emptyList(),
)

/** One project's share of a source's tokens over the whole range. */
data class ProjectTotal(val project: String, val tokens: Long)

/**
 * The arithmetic behind the usage detail screen, kept out of the composables
 * so it can be tested — and so it stays identical to the web dashboard's
 * (public/app.js, "usage detail") and the iOS app's.
 */
object UsageDetail {

    const val DEFAULT_DAYS = 30

    /** How far back the server will look; asking for more is pointless. */
    const val MAX_DAYS = 90

    private const val DAY_MILLIS = 86_400_000L

    /** The [days] UTC days ending today, oldest first, as "YYYY-MM-DD". */
    fun dayRange(days: Int, nowMillis: Long = System.currentTimeMillis()): List<String> {
        if (days <= 0) return emptyList()
        val today = Instant.ofEpochMilli(nowMillis).atZone(ZoneOffset.UTC).toLocalDate()
        return (days - 1 downTo 0).map { today.minusDays(it.toLong()).toString() }
    }

    /** Midnight UTC opening [day]. */
    fun dayStartMillis(day: String): Long =
        LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

    /** The last instant of [day] — the cutoff a step sample reads at. */
    fun dayEndMillis(day: String): Long = dayStartMillis(day) + DAY_MILLIS - 1_000L

    /**
     * Step-samples a recorded series onto the day grid: for each day, the last
     * reading taken at or before the end of it. A day before the series starts
     * has no value at all, which is why this is a list of nullables.
     */
    fun sampleSeries(points: List<UsagePoint>, days: List<String>): List<Double?> =
        days.map { day ->
            val end = dayEndMillis(day)
            var value: Double? = null
            for (point in points) {
                if (point.at > end) break
                value = point.usedPct
            }
            value
        }

    /**
     * Tokens this source spent on each day of the grid, in the grid's order.
     * Rows outside the grid are ignored; a day nobody worked reads as zero.
     */
    fun tokensPerDay(projects: List<ProjectDay>, source: String, days: List<String>): List<Long> {
        val byDay = HashMap<String, Long>(days.size)
        for (row in projects) {
            if (row.source != source) continue
            byDay[row.day] = (byDay[row.day] ?: 0L) + row.tokens
        }
        return days.map { byDay[it] ?: 0L }
    }

    /** Per-project totals for this source over the range, largest first. */
    fun projectTotals(projects: List<ProjectDay>, source: String): List<ProjectTotal> {
        val byProject = LinkedHashMap<String, Long>()
        for (row in projects) {
            if (row.source != source) continue
            byProject[row.project] = (byProject[row.project] ?: 0L) + row.tokens
        }
        return byProject.map { (project, tokens) -> ProjectTotal(project, tokens) }
            .sortedByDescending { it.tokens }
    }

    /** "1.2B", "3.4M", "12K", "870" — the web dashboard's exact ladder. */
    fun fmtTokens(tokens: Long): String = when {
        tokens >= 1_000_000_000L -> String.format(Locale.US, "%.1fB", tokens / 1e9)
        tokens >= 1_000_000L -> String.format(Locale.US, "%.1fM", tokens / 1e6)
        tokens >= 1_000L -> "${(tokens / 1e3).roundToLong()}K"
        else -> tokens.toString()
    }

    /** "9 Aug" — the UTC day, spelled for a tick label. */
    fun dayLabel(day: String): String = LocalDate.parse(day).format(DAY_LABEL)

    /**
     * Ticks every seventh day, plus the final day when it would not collide
     * with the tick before it.
     */
    fun showTick(index: Int, lastIndex: Int): Boolean =
        index % 7 == 0 || (index == lastIndex && lastIndex % 7 > 2)

    private val DAY_LABEL: DateTimeFormatter =
        DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
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
