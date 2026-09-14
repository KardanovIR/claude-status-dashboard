package com.kardanov.agstatus

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
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
    /**
     * Where the session runs — only from hooks that opted in to Focus. Null
     * (absent, `null`, or unreadable) means no control on the card, never an
     * error state.
     */
    @Serializable(with = SessionHostSerializer::class)
    val host: SessionHost? = null,
) {
    /** Falls back to the id so a card is never nameless. */
    val displayName: String get() = name.ifBlank { id }
}

// MARK: - Host (Focus)

/** The machine a session runs on, as its hook labelled it (docs/api.md `host`). */
@Serializable
data class HostMachine(
    /** A per-board hash, 32 lowercase hex — never a raw machine id. */
    val id: String = "",
    val name: String = "",
) {
    /** The hook's label, or the server's placeholder for a blank one. */
    val displayName: String get() = name.ifBlank { "Machine" }

    companion object {
        /** What the server accepts as a machine id (docs/api.md `host`). */
        val ID_REGEX = Regex("^[0-9a-f]{32}$")
    }
}

/** The app the session runs in: a whitelisted slug, a short name, a kind. */
@Serializable
data class HostApp(
    val slug: String = "other",
    val name: String = "",
    /** `terminal | multiplexer | ide | desktop-app | unknown`. */
    val kind: String = "unknown",
) {
    /** How the ack copy names the app ("Opened agterm on Mac…"). */
    val displayName: String get() = name.ifBlank { "the app" }
}

/**
 * `session.host`: two short labels and a per-board machine id, nothing else.
 * The card can say where a session runs, and the server can route a Focus
 * command to that one machine.
 */
@Serializable
data class SessionHost(
    val machine: HostMachine = HostMachine(),
    val app: HostApp = HostApp(),
)

/**
 * Decodes `host` leniently. A missing or `null` host is null, and so is one
 * this app can't make sense of — not an object, or without a machine id of
 * the shape commands are routed by. A card without a control beats a board
 * that fails to parse the whole session.
 */
object SessionHostSerializer : KSerializer<SessionHost?> {
    private val delegate = SessionHost.serializer().nullable

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): SessionHost? {
        val json = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val element = json.decodeJsonElement()
        val host = try {
            json.json.decodeFromJsonElement(delegate, element)
        } catch (malformed: IllegalArgumentException) {
            null
        }
        return host?.takeIf { HostMachine.ID_REGEX.matches(it.machine.id) }
    }

    override fun serialize(encoder: Encoder, value: SessionHost?) =
        delegate.serialize(encoder, value)
}

// MARK: - Focus presence and commands

/**
 * A Focus listener as the board sees it. The `machines` frame lists the ones
 * online; a `machine` frame announces one arriving (`online`, `since`) or
 * leaving (`online: false`, `lastSeen`). Nothing about platform or version.
 */
@Serializable
data class MachinePresence(
    val id: String,
    val name: String = "",
    val online: Boolean = false,
    /** Epoch milliseconds the listener connected — online frames only. */
    val since: Long? = null,
    /** Epoch milliseconds the listener went away — offline frames only. */
    val lastSeen: Long? = null,
) {
    /**
     * Fills in what a terser frame left out: an offline frame carries no
     * name, and the "<name> is offline" copy still needs one.
     */
    fun mergedOver(previous: MachinePresence?): MachinePresence =
        if (previous == null) {
            this
        } else {
            copy(
                name = name.ifBlank { previous.name },
                since = since ?: previous.since,
                lastSeen = lastSeen ?: previous.lastSeen,
            )
        }
}

/** What a tap asks the listener to do. */
enum class CommandType(val wire: String) {
    FOCUS("focus"),
    RESUME("resume"),
}

/** `POST <board>/commands` — ids only, never a path or an argument. */
@Serializable
data class CommandRequest(
    /** A client-minted UUID v4, lowercase, so a retry can be told from a second tap. */
    val id: String,
    /** [CommandType.wire]. */
    val type: String,
    @SerialName("session_id") val sessionId: String,
)

/**
 * The answer to `POST <board>/commands`. `delivered` says whether a listener
 * for the session's machine is connected right now — not that it acted.
 */
@Serializable
data class CommandReceipt(
    val id: String = "",
    val delivered: Boolean = true,
    @SerialName("expires_in_ms") val expiresInMs: Long = 0,
)

/** How a command ended. Enums only: the server refuses free text on this channel. */
enum class CommandResult(val wire: String) {
    FOCUSED("focused"),
    ACTIVATED("activated"),
    SELECTED("selected"),
    RESUMED("resumed"),
    FAILED("failed");

    companion object {
        /** Null for a value this app predates — the copy then quotes the raw string. */
        fun fromWire(value: String?): CommandResult? = entries.firstOrNull { it.wire == value }
    }
}

/** How far the listener got before it answered. */
enum class CommandReach(val wire: String) {
    PANE("pane"),
    TAB("tab"),
    WINDOW("window"),
    APP("app"),
    THREAD("thread");

    companion object {
        fun fromWire(value: String?): CommandReach? = entries.firstOrNull { it.wire == value }
    }
}

/** Why a command failed. */
enum class CommandReason(val wire: String) {
    NO_RECORD("no-record"),
    REMOTE("remote"),
    NOT_RUNNING("not-running"),
    APP_NOT_RUNNING("app-not-running"),
    CONSENT_NEEDED("consent-needed"),
    MUX_DETACHED("mux-detached"),
    AMBIGUOUS("ambiguous"),
    UNSUPPORTED_HOST("unsupported-host"),
    BAD_RECORD("bad-record"),
    RESPAWN_FAILED("respawn-failed"),
    UNSUPPORTED_TYPE("unsupported-type"),
    SUPERSEDED("superseded"),
    EXPIRED("expired");

    companion object {
        fun fromWire(value: String?): CommandReason? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The `command_ack` frame. `result`, `reach` and `reason` stay raw strings
 * so an enum value this app predates still reads back in the failure copy
 * instead of failing the frame.
 */
@Serializable
data class CommandAck(
    val id: String,
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("machine_id") val machineId: String = "",
    val type: String = "",
    val result: String? = null,
    val reach: String? = null,
    val reason: String? = null,
)

/**
 * `GET <board>/commands/:id`: the ack plus where the command is in its life,
 * for a phone that dropped the stream while backgrounded and missed the frame.
 */
@Serializable
data class CommandState(
    val id: String,
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("machine_id") val machineId: String = "",
    val type: String = "",
    /** `pending | claimed | done | expired`. */
    val state: String = "",
    val result: String? = null,
    val reach: String? = null,
    val reason: String? = null,
) {
    val isFinished: Boolean get() = state == "done" || state == "expired"

    /** The ack this state amounts to; an expired command reads as `failed / expired`. */
    fun asAck(): CommandAck = CommandAck(
        id = id,
        sessionId = sessionId,
        machineId = machineId,
        type = type,
        result = result ?: if (state == "expired") CommandResult.FAILED.wire else null,
        reach = reach,
        reason = reason ?: if (state == "expired") CommandReason.EXPIRED.wire else null,
    )
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
