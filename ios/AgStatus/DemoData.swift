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
            Session(id: "demo-docs-site",
                    name: "docs-site",
                    status: .done,
                    message: "All tasks complete — 12 files changed",
                    project: "docs",
                    createdAt: now - 3 * 3_600_000,
                    updatedAt: now - 26 * 60_000),
        ]
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
