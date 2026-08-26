//
//  SessionStore.swift
//  AgStatus
//
//  Observable app state: the adopted board, the live session list (newest
//  first when it first fills; after that rows keep their position as events
//  arrive and new sessions join at the top), the SSE connection lifecycle
//  with backoff, and demo mode. Everything runs on the main actor.
//

import Foundation
import Observation

@MainActor @Observable
final class SessionStore {

    enum Connection: Equatable {
        case idle, connecting, live, reconnecting, boardGone, demo
    }

    // MARK: State

    private(set) var sessions: [Session] = []
    private(set) var usage: [UsageInfo] = []
    private(set) var connection: Connection = .idle
    private(set) var board: Board?

    /// Wall clock of the last real board activity (a session update or
    /// removal; demo ticks count too). Drives the keep-awake idle countdown —
    /// reconnect snapshots and usage trickle deliberately don't reset it.
    private(set) var lastActivityAt = Date()

    var isDemo: Bool {
        connection == .demo
    }

    /// Fires when a board stops being this device's board (disconnect or
    /// replacement by a different one), so push registration can be torn
    /// down without the store knowing anything about notifications.
    @ObservationIgnored var onBoardReleased: ((Board) -> Void)?

    @ObservationIgnored private let sse = SSEClient()
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var demoTask: Task<Void, Never>?
    @ObservationIgnored private var cachedPairCode: (code: PairCode, fetchedAt: Date)?

    // MARK: Lifecycle

    init() {
        board = BoardKeychain.load()

        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["AGSTATUS_BOARD_URL"],
           let url = URL(string: raw),
           let parsed = AgStatusAPI.parseBoardURL(url) {
            adopt(parsed)
            return
        }
        if environment["AGSTATUS_DEMO"] == "1" {
            startDemo()
            return
        }
        #endif

        if board != nil {
            connect()
        }
    }

    /// Saves the board and starts streaming. Stops demo mode if active.
    func adopt(_ board: Board) {
        stopDemoTask()
        if let old = self.board, old != board {
            onBoardReleased?(old)
        }
        self.board = board
        BoardKeychain.save(board)
        sessions = []
        usage = []
        cachedPairCode = nil
        connect()
    }

    /// Forgets the board on this device only; the server is untouched
    /// (apart from releasing this device's push registration).
    func disconnectBoard() {
        stopDemoTask()
        cancelStream()
        if let board {
            onBoardReleased?(board)
        }
        board = nil
        BoardKeychain.clear()
        sessions = []
        usage = []
        cachedPairCode = nil
        connection = .idle
    }

    /// Deletes the board on the server, then disconnects locally.
    /// A board that is already gone counts as success.
    func deleteBoardEverywhere() async throws {
        guard let board else {
            disconnectBoard()
            return
        }
        do {
            try await AgStatusAPI.deleteBoard(board)
        } catch let error as APIError where error == .boardNotFound {
            // Already deleted elsewhere — treat as success.
        }
        disconnectBoard()
    }

    // MARK: Streaming

    /// Starts (or restarts) the SSE task. Reconnects with exponential
    /// backoff, 1s doubling to 30s, reset after a successful snapshot.
    /// A 404 sets `.boardGone` and stops until adopt()/connect().
    func connect() {
        guard let board else { return }
        stopDemoTask()
        cancelStream()
        connection = .connecting
        lastActivityAt = Date()
        streamTask = Task { [weak self] in
            await self?.runStream(for: board)
        }
    }

    /// Cancels the stream task.
    func disconnect() {
        cancelStream()
        switch connection {
        case .connecting, .live, .reconnecting:
            connection = .idle
        case .idle, .boardGone, .demo:
            break
        }
    }

    private func runStream(for board: Board) async {
        var delay: Double = 1

        while !Task.isCancelled {
            do {
                for try await event in sse.events(for: board) {
                    switch event {
                    case .snapshot(let list):
                        sessions = Self.stableOrder(current: sessions, incoming: list)
                        connection = .live
                        delay = 1
                    case .upsert(let session):
                        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
                            sessions[index] = session
                        } else {
                            sessions.insert(session, at: 0)
                        }
                        lastActivityAt = Date()
                    case .remove(let id):
                        sessions.removeAll { $0.id == id }
                        lastActivityAt = Date()
                    case .usage(let list):
                        usage = list
                    }
                }
                // Stream ended cleanly (server closed) — fall through to retry.
            } catch let error as APIError where error == .boardNotFound {
                connection = .boardGone
                return
            } catch is CancellationError {
                return
            } catch {
                // Transient failure — fall through to retry.
            }

            if Task.isCancelled { return }
            connection = .reconnecting
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    // MARK: Data

    /// Fetches the session list and merges it in, never resurrecting local
    /// sessions that are newer than what the server returned, nor sessions
    /// removed while the fetch was in flight.
    func refresh() async {
        guard !isDemo, let board else { return }
        let fetchStart = Int64(Date().timeIntervalSince1970 * 1000)
        let idsAtFetchStart = Set(sessions.map(\.id))

        let fetched: [Session]
        do {
            fetched = try await AgStatusAPI.sessions(for: board)
        } catch let error as APIError where error == .boardNotFound {
            cancelStream()
            connection = .boardGone
            return
        } catch {
            return // transient — keep what we have
        }

        // Usage is a best-effort side fetch — a failure changes nothing.
        if let fetchedUsage = try? await AgStatusAPI.usage(for: board) {
            usage = fetchedUsage
        }

        // A fetched session we knew at fetch start but no longer hold was
        // removed mid-fetch (dismissed here, elsewhere, or swept) — the fetch
        // predates that removal, so re-adding it would resurrect a ghost.
        let currentIDs = Set(sessions.map(\.id))
        var merged: [String: Session] = [:]
        for session in fetched {
            if idsAtFetchStart.contains(session.id) && !currentIDs.contains(session.id) {
                continue
            }
            merged[session.id] = session
        }
        for local in sessions {
            if let remote = merged[local.id] {
                if local.updatedAt > remote.updatedAt {
                    merged[local.id] = local // SSE beat the fetch
                }
            } else if local.updatedAt > fetchStart {
                merged[local.id] = local // arrived via SSE mid-fetch
            }
        }
        sessions = Self.stableOrder(current: sessions, incoming: Array(merged.values))
    }

    /// Optimistically removes the session, then deletes it on the server.
    /// On failure the session returns to its old spot and the list refreshes.
    func dismiss(_ session: Session) async {
        if isDemo {
            sessions.removeAll { $0.id == session.id }
            return
        }
        guard let board else { return }

        // Anchor the restore spot to the row below rather than a numeric
        // index, which SSE events arriving during the DELETE would shift.
        let index = sessions.firstIndex { $0.id == session.id }
        let successorID = index.flatMap { i in
            sessions.indices.contains(i + 1) ? sessions[i + 1].id : nil
        }
        sessions.removeAll { $0.id == session.id }
        do {
            try await AgStatusAPI.deleteSession(session.id, from: board)
        } catch let error as APIError where error == .boardNotFound {
            cancelStream()
            connection = .boardGone
        } catch {
            if !sessions.contains(where: { $0.id == session.id }) {
                let at: Int
                if let successorID,
                   let below = sessions.firstIndex(where: { $0.id == successorID }) {
                    at = below
                } else if index != nil, successorID == nil {
                    at = sessions.count // was the bottom row
                } else {
                    at = min(index ?? 0, sessions.count)
                }
                sessions.insert(session, at: at)
            }
            await refresh()
        }
    }

    /// Returns a pairing code, reusing the last unexpired one so reopening the
    /// sheet doesn't burn through the server's 3-outstanding-codes cap.
    /// `forceNew` mints a fresh code (e.g. after pairing a first machine).
    func pairCode(forceNew: Bool = false) async throws -> PairCode {
        guard let board else { throw APIError.legacyServer }
        if !forceNew, let cached = cachedPairCode {
            let remaining = Double(cached.code.expiresInSeconds)
                - Date().timeIntervalSince(cached.fetchedAt)
            if remaining > 60 {
                return PairCode(code: cached.code.code, expiresInSeconds: Int(remaining))
            }
        }
        let fresh = try await AgStatusAPI.createPairCode(for: board)
        cachedPairCode = (fresh, Date())
        return fresh
    }

    // MARK: Demo mode

    /// Board-less fake mode driven by DemoData on a ~4s tick.
    func startDemo() {
        cancelStream()
        stopDemoTask()
        sessions = Self.sortedByUpdate(DemoData.initialSessions())
        usage = DemoData.usage()
        connection = .demo
        demoTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard let self, !Task.isCancelled, self.connection == .demo else { return }
                self.sessions = Self.stableOrder(current: self.sessions,
                                                 incoming: DemoData.tick(self.sessions))
                self.lastActivityAt = Date()
            }
        }
    }

    func stopDemo() {
        stopDemoTask()
        guard connection == .demo else { return }
        sessions = []
        usage = []
        connection = .idle
        if board != nil {
            connect()
        }
    }

    // MARK: Helpers

    private func cancelStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func stopDemoTask() {
        demoTask?.cancel()
        demoTask = nil
    }

    private static func sortedByUpdate(_ sessions: [Session]) -> [Session] {
        sessions.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Arranges `incoming` so sessions already on screen keep their relative
    /// order (with fresh data) and unseen ones join at the top, newest first.
    /// With nothing on screen this is a plain newest-first sort.
    private static func stableOrder(current: [Session], incoming: [Session]) -> [Session] {
        let incomingByID = Dictionary(incoming.map { ($0.id, $0) }) { _, last in last }
        let kept = current.compactMap { incomingByID[$0.id] }
        let currentIDs = Set(current.map(\.id))
        let fresh = incoming.filter { !currentIDs.contains($0.id) }
        return sortedByUpdate(fresh) + kept
    }
}
