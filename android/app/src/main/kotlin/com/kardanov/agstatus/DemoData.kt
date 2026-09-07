package com.kardanov.agstatus

import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * Believable fake sessions for demo mode, plus a tick() that walks them
 * through plausible status transitions so the board feels alive.
 */
object DemoData {

    /** Four sessions that look like a real evening of agent work. */
    fun initialSessions(): List<Session> {
        val now = System.currentTimeMillis()
        return listOf(
            Session(
                id = "demo-api-server",
                name = "api-server",
                status = AgentStatus.CODING,
                message = "Editing src/auth/token.ts",
                project = "acme-api",
                createdAt = now - 42 * 60_000L,
                updatedAt = now - 15_000L,
            ),
            Session(
                id = "demo-webapp",
                name = "webapp",
                status = AgentStatus.TESTING,
                message = "npm test — 42 passing, 1 pending",
                project = "acme-web",
                createdAt = now - 95 * 60_000L,
                updatedAt = now - 70_000L,
            ),
            Session(
                id = "demo-data-pipeline",
                name = "data-pipeline",
                status = AgentStatus.BLOCKED,
                message = "Needs permission approval",
                project = "etl-jobs",
                createdAt = now - 18 * 60_000L,
                updatedAt = now - 3 * 60_000L,
            ),
            // A Codex session so the demo board shows both agents' limit
            // blocks, not just Claude's.
            Session(
                id = "demo-docs-site",
                name = "docs-site",
                status = AgentStatus.DONE,
                message = "All tasks complete — 12 files changed",
                project = "docs",
                source = "codex",
                createdAt = now - 3 * 3_600_000L,
                updatedAt = now - 26 * 60_000L,
            ),
        )
    }

    /**
     * Plan-limit bars matching a busy-but-not-throttled evening: one block per
     * agent, each with its own session, all-models and per-model windows.
     */
    fun usage(): List<UsageInfo> {
        val now = System.currentTimeMillis()
        return listOf(
            UsageInfo(
                source = "claude",
                windows = listOf(
                    UsageWindow(
                        id = "session",
                        label = "Current session",
                        usedPct = 34.0,
                        resetsAt = now + 137 * 60_000L,
                    ),
                    UsageWindow(
                        id = "week",
                        label = "Weekly (all models)",
                        usedPct = 62.0,
                        resetsAt = now + 2 * 86_400_000L + 5 * 3_600_000L,
                    ),
                    UsageWindow(
                        id = "week_fable",
                        label = "Weekly (Fable)",
                        usedPct = 41.0,
                        resetsAt = now + 2 * 86_400_000L + 5 * 3_600_000L,
                    ),
                ),
                updatedAt = now,
            ),
            UsageInfo(
                source = "codex",
                windows = listOf(
                    UsageWindow(
                        id = "week",
                        label = "Weekly (all models)",
                        usedPct = 47.0,
                        resetsAt = now + 4 * 86_400_000L + 2 * 3_600_000L,
                    ),
                    UsageWindow(
                        id = "session_gpt_6_astra",
                        label = "Session (GPT-6-Astra)",
                        usedPct = 22.0,
                        resetsAt = now + 96 * 60_000L,
                    ),
                    UsageWindow(
                        id = "week_gpt_6_astra",
                        label = "Weekly (GPT-6-Astra)",
                        usedPct = 38.0,
                        resetsAt = now + 4 * 86_400_000L + 2 * 3_600_000L,
                    ),
                ),
                updatedAt = now,
            ),
        )
    }

    /**
     * A month of plausible detail behind those bars, generated locally so demo
     * mode never touches the network: weekly caps sawtoothing as they reset,
     * session windows wandering, and per-project token totals underneath.
     * Deterministic, so a demo screenshot looks the same every launch.
     */
    fun usageHistory(
        days: Int = UsageDetail.DEFAULT_DAYS,
        nowMillis: Long = System.currentTimeMillis(),
    ): UsageHistory {
        val range = UsageDetail.dayRange(days, nowMillis)
        if (range.isEmpty()) return UsageHistory(days = days)
        val blocks = usage()
        return UsageHistory(
            days = days,
            history = blocks.flatMap { info ->
                info.windows.mapIndexed { index, window ->
                    demoSeries(info.source, window, range, index, nowMillis)
                }
            },
            projects = blocks.flatMap { demoProjectDays(it.source, range) },
        )
    }

    /**
     * Advances a random subset of sessions (at least one) along plausible
     * transitions, refreshing messages and updatedAt. An emptied demo board
     * re-seeds itself so the demo never dead-ends.
     */
    fun tick(sessions: List<Session>): List<Session> {
        if (sessions.isEmpty()) return initialSessions()
        val now = System.currentTimeMillis()
        val updated = sessions.toMutableList()
        var changedAny = false

        for (index in updated.indices) {
            if (Random.nextDouble() < 0.45) {
                updated[index] = advance(updated[index], now)
                changedAny = true
            }
        }
        if (!changedAny) {
            val index = updated.indices.random()
            updated[index] = advance(updated[index], now)
        }
        return updated
    }

    /** A believable timeline for a demo session, ending in its current state. */
    fun history(session: Session): List<HistoryEvent> {
        // A full session's worth of steps: enough to fill the timeline on the
        // largest phone, and to show a blocked stretch resolving.
        val steps = listOf(
            Triple(AgentStatus.IDLE, "Session started", 46L),
            Triple(AgentStatus.PLANNING, "Reading the codebase…", 44L),
            Triple(AgentStatus.PLANNING, "Drafting an implementation plan", 40L),
            Triple(AgentStatus.CODING, "Editing src/auth/token.ts", 35L),
            Triple(AgentStatus.CODING, "Implementing retry with backoff", 31L),
            Triple(AgentStatus.TESTING, "npm test — 41 passing, 2 failing", 26L),
            Triple(AgentStatus.CODING, "Fixing null check in parser.js", 22L),
            Triple(AgentStatus.BLOCKED, "Needs permission approval", 18L),
            Triple(AgentStatus.CODING, "Refactoring api/routes.ts", 14L),
            Triple(AgentStatus.TESTING, "npm test — 42 passing, 1 pending", 9L),
            Triple(AgentStatus.CODING, "Writing SessionStore.kt", 5L),
        )
        val events = steps.mapIndexed { index, (status, message, minutesAgo) ->
            HistoryEvent(
                seq = index.toLong(),
                status = status,
                message = message,
                at = session.updatedAt - minutesAgo * 60_000L,
            )
        } + HistoryEvent(
            seq = steps.size.toLong(),
            status = session.status,
            message = session.message,
            at = session.updatedAt,
        )
        return events.reversed() // newest first, like the server
    }

    // MARK: - Internals

    /**
     * One window's recorded readings. Weekly caps climb through a seven-day
     * cycle and drop when they reset; session windows wander. A block's last
     * window only starts halfway through the range, because a board records a
     * limit from the day it first saw it — that late start is exactly what the
     * detail screen's footnote is about. Readings are emitted only when the
     * value changes, matching the step function the server stores.
     */
    private fun demoSeries(
        source: String,
        window: UsageWindow,
        days: List<String>,
        index: Int,
        nowMillis: Long,
    ): UsageSeries {
        val random = Random(source.hashCode() * 31 + window.id.hashCode())
        val weekly = window.id.startsWith("week")
        val hours = if (weekly) intArrayOf(11) else intArrayOf(7, 13, 19)
        val firstDay = if (index == 2 && days.size > 8) days.size / 2 else 0

        val points = mutableListOf<UsagePoint>()
        var previous = Double.NaN
        // A session window wanders from wherever it was rather than being
        // redrawn each reading: consecutive readings of a real limit correlate.
        var level = 24.0 + random.nextInt(20)
        for (dayIndex in firstDay until days.size) {
            val phase = (dayIndex - firstDay) % 7
            for (hour in hours) {
                val at = UsageDetail.dayStartMillis(days[dayIndex]) + hour * 3_600_000L
                if (at > nowMillis) continue // no readings from the future
                val value = if (weekly) {
                    5.0 + phase * 9.0 + random.nextInt(7)
                } else {
                    level = (level + random.nextInt(-11, 12)).coerceIn(6.0, 76.0)
                    level
                }
                val rounded = value.roundToInt().toDouble()
                if (rounded != previous) {
                    points += UsagePoint(at = at, usedPct = rounded)
                    previous = rounded
                }
            }
        }
        // Land on the percentage the board's bars are showing right now.
        if (previous != window.usedPct) {
            points += UsagePoint(at = nowMillis, usedPct = window.usedPct)
        }
        return UsageSeries(source = source, windowId = window.id, points = points)
    }

    /**
     * Daily per-project token totals. Quiet days are deliberate: a flat block
     * of thirty identical bars reads as fake at a glance.
     */
    private fun demoProjectDays(source: String, days: List<String>): List<ProjectDay> {
        val projects = demoProjects[source] ?: return emptyList()
        val random = Random(source.hashCode())
        val rows = mutableListOf<ProjectDay>()
        for (day in days) {
            val quiet = random.nextDouble() < 0.16
            for ((project, weight) in projects) {
                if (quiet || random.nextDouble() < 0.22) continue
                val spread = 0.45 + random.nextDouble() * 1.15
                // Rounded to 100K, the granularity a real token report lands on.
                val tokens = (weight * spread * 12_000_000.0).roundToLong() / 100_000L * 100_000L
                if (tokens <= 0L) continue
                rows += ProjectDay(source = source, project = project, day = day, tokens = tokens)
            }
        }
        return rows
    }

    /** The demo sessions' projects, weighted so one clearly leads the board. */
    private val demoProjects: Map<String, List<Pair<String, Double>>> = mapOf(
        "claude" to listOf("acme-api" to 1.0, "acme-web" to 0.64, "etl-jobs" to 0.27),
        "codex" to listOf("docs" to 0.58, "acme-web" to 0.31),
    )

    private fun advance(session: Session, now: Long): Session {
        val status = transitions[session.status]?.random() ?: session.status
        val message = if (status != session.status || Random.nextBoolean()) {
            messages[status]?.random() ?: session.message
        } else {
            session.message
        }
        return session.copy(status = status, message = message, updatedAt = now)
    }

    /** Weighted plausible transitions (duplicates raise the odds of staying put). */
    private val transitions: Map<AgentStatus, List<AgentStatus>> = mapOf(
        AgentStatus.IDLE to listOf(AgentStatus.PLANNING, AgentStatus.PLANNING, AgentStatus.IDLE),
        AgentStatus.PLANNING to listOf(AgentStatus.CODING, AgentStatus.CODING, AgentStatus.PLANNING),
        AgentStatus.CODING to listOf(
            AgentStatus.CODING,
            AgentStatus.CODING,
            AgentStatus.CODING,
            AgentStatus.TESTING,
        ),
        AgentStatus.TESTING to listOf(
            AgentStatus.TESTING,
            AgentStatus.CODING,
            AgentStatus.DONE,
            AgentStatus.BLOCKED,
        ),
        AgentStatus.BLOCKED to listOf(AgentStatus.BLOCKED, AgentStatus.BLOCKED, AgentStatus.CODING),
        AgentStatus.DONE to listOf(AgentStatus.DONE, AgentStatus.DONE, AgentStatus.PLANNING),
    )

    private val messages: Map<AgentStatus, List<String>> = mapOf(
        AgentStatus.IDLE to listOf(
            "Waiting for a task",
            "Session idle",
        ),
        AgentStatus.PLANNING to listOf(
            "Reading the codebase…",
            "Exploring src/ for entry points",
            "Drafting an implementation plan",
            "Reviewing open issues",
        ),
        AgentStatus.CODING to listOf(
            "Editing src/auth/token.ts",
            "Refactoring api/routes.ts",
            "Implementing retry with backoff",
            "Writing SessionStore.kt",
            "Fixing null check in parser.js",
        ),
        AgentStatus.TESTING to listOf(
            "npm test",
            "Running unit tests…",
            "pytest -q — 87 passed",
            "vitest run — 3 suites",
        ),
        AgentStatus.BLOCKED to listOf(
            "Needs permission approval",
            "Waiting for your input",
            "Merge conflict needs review",
        ),
        AgentStatus.DONE to listOf(
            "All tasks complete",
            "PR ready for review",
            "Finished — 12 files changed",
        ),
    )
}
