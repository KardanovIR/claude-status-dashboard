//
//  DemoData.swift
//  AgStatus
//
//  Believable fake sessions for demo mode, plus a tick() that walks them
//  through plausible status transitions so the board feels alive.
//

import Foundation

enum DemoData {

    /// Four sessions that look like a real evening of agent work.
    static func initialSessions() -> [Session] {
        let now = nowMillis()
        return [
            Session(id: "demo-api-server",
                    name: "api-server",
                    status: .coding,
                    message: "Editing src/auth/token.ts",
                    project: "acme-api",
                    createdAt: now - 42 * 60_000,
                    updatedAt: now - 15_000),
            Session(id: "demo-webapp",
                    name: "webapp",
                    status: .testing,
                    message: "npm test — 42 passing, 1 pending",
                    project: "acme-web",
                    createdAt: now - 95 * 60_000,
                    updatedAt: now - 70_000),
            Session(id: "demo-data-pipeline",
                    name: "data-pipeline",
                    status: .blocked,
                    message: "Needs permission approval",
                    project: "etl-jobs",
                    createdAt: now - 18 * 60_000,
                    updatedAt: now - 3 * 60_000),
            // A Codex session so the demo board shows both agents' limit
            // blocks, not just Claude's.
            Session(id: "demo-docs-site",
                    name: "docs-site",
                    status: .done,
                    message: "All tasks complete — 12 files changed",
                    project: "docs",
                    source: "codex",
                    createdAt: now - 3 * 3_600_000,
                    updatedAt: now - 26 * 60_000),
        ]
    }

    /// Plan-limit bars matching a busy-but-not-throttled evening: one block
    /// per agent, each with its own session, all-models and per-model windows.
    static func usage() -> [UsageInfo] {
        let now = nowMillis()
        return [
            UsageInfo(source: "claude",
                      windows: [
                          UsageWindow(id: "session",
                                      label: "Current session",
                                      usedPct: 34,
                                      resetsAt: now + 137 * 60_000),
                          UsageWindow(id: "week",
                                      label: "Weekly (all models)",
                                      usedPct: 62,
                                      resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000),
                          UsageWindow(id: "week_fable",
                                      label: "Weekly (Fable)",
                                      usedPct: 41,
                                      resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000),
                      ],
                      updatedAt: now),
            UsageInfo(source: "codex",
                      windows: [
                          UsageWindow(id: "week",
                                      label: "Weekly (all models)",
                                      usedPct: 47,
                                      resetsAt: now + 4 * 86_400_000 + 2 * 3_600_000),
                          UsageWindow(id: "session_gpt_6_astra",
                                      label: "Session (GPT-6-Astra)",
                                      usedPct: 22,
                                      resetsAt: now + 96 * 60_000),
                          UsageWindow(id: "week_gpt_6_astra",
                                      label: "Weekly (GPT-6-Astra)",
                                      usedPct: 38,
                                      resetsAt: now + 4 * 86_400_000 + 2 * 3_600_000),
                      ],
                      updatedAt: now),
        ]
    }

    /// Offline stand-in for `/api/usage/history`: a month of plausible token
    /// spend per project, with the plan-limit readings recorded over it. The
    /// limit series deliberately start partway through the range — a board only
    /// knows the limits it has actually seen — and each one lands on the same
    /// percentage the demo bars show, so the two screens agree. Seeded, so the
    /// demo (and its screenshots) look the same on every launch.
    static func usageHistory(days: Int = UsageHistory.defaultDays) -> UsageHistory {
        let grid = UsageHistory.dayRange(days)
        var rng = SeededGenerator(seed: 0x51E5_A6ED_D0C5)
        var series: [UsageHistorySeries] = []
        var projects: [UsageProjectDay] = []

        for plan in demoPlans {
            for window in plan.windows {
                series.append(limitSeries(source: plan.source, window: window, grid: grid, rng: &rng))
            }
            for project in plan.projects {
                projects.append(contentsOf: tokenRows(source: plan.source,
                                                      project: project,
                                                      grid: grid,
                                                      rng: &rng))
            }
        }
        return UsageHistory(days: grid.count, history: series, projects: projects)
    }

    /// What each demo agent has been spending, and on what.
    private struct DemoPlan {
        let source: String
        /// One per limit window: its id, how far back the board first recorded
        /// it, where it stands today, and whether it accrues over a week.
        let windows: [(id: String, startsDaysAgo: Int, endPct: Double, weekly: Bool)]
        /// Projects and their share of this agent's daily spend.
        let projects: [(name: String, weight: Double)]
    }

    private static let demoPlans: [DemoPlan] = [
        DemoPlan(source: "claude",
                 windows: [("session", 9, 34, false),
                           ("week", 22, 62, true),
                           ("week_fable", 22, 41, true)],
                 projects: [("acme-api", 1.0),
                            ("acme-web", 0.66),
                            ("etl-jobs", 0.31),
                            ("infra-scripts", 0.12)]),
        DemoPlan(source: "codex",
                 windows: [("week", 16, 47, true),
                           ("session_gpt_6_astra", 6, 22, false),
                           ("week_gpt_6_astra", 16, 38, true)],
                 projects: [("docs", 1.0), ("acme-web", 0.42)]),
    ]

    /// A step function: one reading per day, kept only when it changed.
    private static func limitSeries(source: String,
                                    window: (id: String, startsDaysAgo: Int, endPct: Double, weekly: Bool),
                                    grid: [String],
                                    rng: inout SeededGenerator) -> UsageHistorySeries {
        let first = max(0, grid.count - window.startsDaysAgo)
        let now = nowMillis()
        var value = Double.random(in: 4...12, using: &rng)
        var last: Double?
        var points: [UsageHistoryPoint] = []

        for index in first..<grid.count {
            if window.weekly {
                // Weekly caps saw-tooth: they climb all week, then reset.
                if (grid.count - 1 - index) % 7 == 6 {
                    value = Double.random(in: 2...9, using: &rng)
                } else {
                    value = min(96, value + Double.random(in: 3...13, using: &rng))
                }
            } else {
                // A session window is short-lived; each day stands on its own.
                value = Double.random(in: 6...58, using: &rng)
            }
            // Today's reading is the one the board's bars already show.
            let reading = (index == grid.count - 1 ? window.endPct : value).rounded()
            guard reading != last else { continue }
            last = reading
            let at = min(now, UsageHistory.dayStartMillis(grid[index]) + 18 * 3_600_000)
            points.append(UsageHistoryPoint(at: at, usedPct: reading))
        }
        return UsageHistorySeries(source: source, windowId: window.id, points: points)
    }

    /// Absolute per-day totals, with the quiet days a real month has.
    private static func tokenRows(source: String,
                                  project: (name: String, weight: Double),
                                  grid: [String],
                                  rng: inout SeededGenerator) -> [UsageProjectDay] {
        var rows: [UsageProjectDay] = []
        for (index, day) in grid.enumerated() {
            if Double.random(in: 0..<1, using: &rng) < 0.18 { continue } // a day off
            let ramp = 0.55 + 0.45 * Double(index) / Double(max(1, grid.count - 1))
            let jitter = Double.random(in: 0.45...1.45, using: &rng)
            let tokens = (26_000_000 * project.weight * ramp * jitter).rounded()
            rows.append(UsageProjectDay(source: source, project: project.name, day: day, tokens: tokens))
        }
        return rows
    }

    /// splitmix64 — a few lines of deterministic randomness, so the demo screen
    /// is the same every time without pulling in a dependency.
    private struct SeededGenerator: RandomNumberGenerator {
        private var state: UInt64

        init(seed: UInt64) { state = seed }

        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// Advances a random subset of sessions (at least one) along plausible
    /// transitions, refreshing messages and updatedAt. An emptied demo board
    /// re-seeds itself so the demo never dead-ends.
    static func tick(_ sessions: [Session]) -> [Session] {
        guard !sessions.isEmpty else { return initialSessions() }
        let now = nowMillis()
        var updated = sessions
        var changedAny = false

        for index in updated.indices where Double.random(in: 0..<1) < 0.45 {
            updated[index] = advance(updated[index], at: now)
            changedAny = true
        }
        if !changedAny, let index = updated.indices.randomElement() {
            updated[index] = advance(updated[index], at: now)
        }
        return updated
    }

    /// A believable timeline for a demo session, ending in its current state.
    static func history(for session: Session) -> [HistoryEvent] {
        // A full session's worth of steps: enough to fill the timeline on the
        // largest iPhone, and to show a blocked stretch resolving.
        let steps: [(AgentStatus, String, Int64)] = [
            (.idle, "Session started", 46),
            (.planning, "Reading the codebase…", 44),
            (.planning, "Drafting an implementation plan", 40),
            (.coding, "Editing src/auth/token.ts", 35),
            (.coding, "Implementing retry with backoff", 31),
            (.testing, "npm test — 41 passing, 2 failing", 26),
            (.coding, "Fixing null check in parser.js", 22),
            (.blocked, "Needs permission approval", 18),
            (.coding, "Refactoring api/routes.ts", 14),
            (.testing, "npm test — 42 passing, 1 pending", 9),
            (.coding, "Writing SessionStore.swift", 5),
        ]
        var events: [HistoryEvent] = []
        for (index, step) in steps.enumerated() {
            events.append(HistoryEvent(seq: Int64(index),
                                       status: step.0,
                                       message: step.1,
                                       at: session.updatedAt - step.2 * 60_000))
        }
        events.append(HistoryEvent(seq: Int64(steps.count),
                                   status: session.status,
                                   message: session.message,
                                   at: session.updatedAt))
        return events.reversed() // newest first, like the server
    }

    // MARK: Internals

    private static func advance(_ session: Session, at now: Int64) -> Session {
        var next = session
        let status = transitions[session.status]?.randomElement() ?? session.status
        next.status = status
        if status != session.status || Bool.random() {
            next.message = messages[status]?.randomElement() ?? session.message
        }
        next.updatedAt = now
        return next
    }

    /// Weighted plausible transitions (duplicates raise the odds of staying put).
    private static let transitions: [AgentStatus: [AgentStatus]] = [
        .idle: [.planning, .planning, .idle],
        .planning: [.coding, .coding, .planning],
        .coding: [.coding, .coding, .coding, .testing],
        .testing: [.testing, .coding, .done, .blocked],
        .blocked: [.blocked, .blocked, .coding],
        .done: [.done, .done, .planning],
    ]

    private static let messages: [AgentStatus: [String]] = [
        .idle: [
            "Waiting for a task",
            "Session idle",
        ],
        .planning: [
            "Reading the codebase…",
            "Exploring src/ for entry points",
            "Drafting an implementation plan",
            "Reviewing open issues",
        ],
        .coding: [
            "Editing src/auth/token.ts",
            "Refactoring api/routes.ts",
            "Implementing retry with backoff",
            "Writing SessionStore.swift",
            "Fixing null check in parser.js",
        ],
        .testing: [
            "npm test",
            "Running unit tests…",
            "pytest -q — 87 passed",
            "vitest run — 3 suites",
        ],
        .blocked: [
            "Needs permission approval",
            "Waiting for your input",
            "Merge conflict needs review",
        ],
        .done: [
            "All tasks complete",
            "PR ready for review",
            "Finished — 12 files changed",
        ],
    ]

    private static func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
