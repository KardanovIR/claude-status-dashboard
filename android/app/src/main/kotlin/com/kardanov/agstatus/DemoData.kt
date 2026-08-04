package com.kardanov.agstatus

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
            Session(
                id = "demo-docs-site",
                name = "docs-site",
                status = AgentStatus.DONE,
                message = "All tasks complete — 12 files changed",
                project = "docs",
                createdAt = now - 3 * 3_600_000L,
                updatedAt = now - 26 * 60_000L,
            ),
        )
    }

    /** Plan-limit bars matching a busy-but-not-throttled evening. */
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
