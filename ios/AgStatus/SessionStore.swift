//
//  SessionStore.swift
//  AgStatus
//
//  Observable app state: the adopted board, the live session list (newest
//  first when it first fills; after that rows keep their position as events
//  arrive and new sessions join at the top), the SSE connection lifecycle
//  with backoff, Focus (listener presence and the command each card is
//  waiting on), and demo mode. Everything runs on the main actor.
//

import Foundation
import Observation

@MainActor @Observable
final class SessionStore {

    enum Connection: Equatable {
        case idle, connecting, live, reconnecting, boardGone, demo
    }

    /// What a card's focus row shows: the command it is waiting on, or the
    /// outcome it last heard (docs/design/focus-protocol.md §7). Successes
    /// clear themselves after a while; failures stay until the next tap.
    struct FocusState: Equatable, Sendable {
        enum Kind: Equatable, Sendable {
            case pending, ok, fail
        }

        /// The one command this card honours — an older one that a re-tap
        /// superseded, or a stray ack, has nothing to say to it.
        let cmdId: String
        let type: CommandType
        /// The machine's label at tap time, so the copy holds still even if
        /// presence changes underneath it.
        let name: String
        let appName: String
        /// When the tap happened; the answer window counts from here.
        let startedAt: Date
        var kind: Kind = .pending
        var text = "Sending…"
        var resumeOffered = false
        var done = false
    }

    /// No ack by then → "is it asleep?" (the web board waits the same).
    static let ackTimeout: TimeInterval = 15
    /// Successes fade after this; failures stay until the next tap.
    static let statusClearDelay: TimeInterval = 8

    // MARK: State

    private(set) var sessions: [Session] = []
    private(set) var usage: [UsageInfo] = []
    private(set) var connection: Connection = .idle
    private(set) var board: Board?
    /// Focus listeners by machine id: re-seeded by every `machines` frame and
    /// kept current by `machine` frames — an offline one keeps the last name
    /// so the card can still say who is offline.
    private(set) var machines: [String: MachinePresence] = [:]
    /// The command each card is waiting on or last heard about, by session id.
    private(set) var focus: [String: FocusState] = [:]

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
    /// Per session: the ack deadline while pending, or the fade while ok.
    @ObservationIgnored private var focusTimers: [String: Task<Void, Never>] = [:]
    /// A "Bring to front" tapped on a push, waiting for the board to come in.
    @ObservationIgnored private var notificationFocus: (sessionId: String, at: Date)?

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
        machines = [:]
        clearFocus()
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
        machines = [:]
        clearFocus()
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

    /// Cancels the stream task. A command still waiting for its ack loses
    /// its 15 s deadline here: the phone is going to the background, and on
    /// return the snapshot triggers a poll that decides — so a stale timer
    /// can't declare "asleep" over an answer already waiting on the server.
    /// Should the reconnect fail instead, `runStream` puts the deadline back.
    func disconnect() {
        cancelStream()
        for (id, state) in focus where !state.done {
            cancelFocusTimer(id)
        }
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
                        pruneFocus()
                        // Acks broadcast while the stream was down are gone;
                        // ask the server where anything still pending got to.
                        if focus.values.contains(where: { !$0.done }) {
                            Task { await self.reconcilePendingCommands(for: board) }
                        }
                    case .upsert(let session):
                        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
                            sessions[index] = session
                        } else {
                            sessions.insert(session, at: 0)
                        }
                        lastActivityAt = Date()
                    case .remove(let id):
                        sessions.removeAll { $0.id == id }
                        setFocus(id, nil)
                        lastActivityAt = Date()
                    case .usage(let list):
                        usage = list
                    case .machines(let list):
                        // The full list follows every snapshot, so a reconnect re-seeds it.
                        machines = Dictionary(list.map { ($0.id, $0) }) { _, last in last }
                        applyNotificationFocus()
                    case .machine(let presence):
                        var merged = presence
                        if merged.name == nil {
                            merged.name = machines[presence.id]?.name
                        }
                        machines[presence.id] = merged
                    case .commandAck(let ack):
                        handleAck(ack)
                    }
                }
                // Stream ended cleanly (server closed) — fall through to retry.
            } catch let error as APIError where error == .boardNotFound {
                markBoardGone()
                return
            } catch is CancellationError {
                return
            } catch {
                // Transient failure — fall through to retry.
            }

            if Task.isCancelled { return }
            // disconnect() dropped the ack timers, and only a snapshot's
            // reconcile would bring them back — with the reconnect failing
            // there is none, so keep each pending card on its own deadline.
            // A snapshot's reconcile still wins if it arrives first.
            for (id, state) in focus where !state.done {
                keepAckWindow(id, state)
            }
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
            markBoardGone()
            return
        } catch {
            return // transient — keep what we have
        }

        // Usage and presence are best-effort side fetches — a failure changes
        // nothing. Presence re-seeds like a `machines` frame would.
        if let fetchedUsage = try? await AgStatusAPI.usage(for: board) {
            usage = fetchedUsage
        }
        if let fetchedMachines = try? await AgStatusAPI.machines(for: board) {
            machines = Dictionary(fetchedMachines.map { ($0.id, $0) }) { _, last in last }
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
        pruneFocus()
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
            markBoardGone()
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

    // MARK: Focus

    /// Whether a Focus listener for the machine is connected right now.
    func isMachineOnline(_ machineId: String) -> Bool {
        machines[machineId]?.online == true
    }

    /// The hook's label, plus the id's last four hex when two online machines
    /// share it — the default names ("Mac", "PC") make that likely.
    func machineLabel(for host: Host) -> String {
        let name = [machines[host.machine.id]?.name, host.machine.name]
            .compactMap { $0 }
            .first { !$0.isEmpty } ?? "Machine"
        let same = machines.values.filter { $0.online && $0.name == name }.count
        return same > 1 ? "\(name) (\(host.machine.id.suffix(4)))" : name
    }

    /// Sends a focus/resume command for the session — the explicit control,
    /// never the card tap. The card shows "Sending…", then "Sent…" (or that
    /// the machine isn't connected), then whatever the ack says; with no ack
    /// in 15 s it asks whether the machine is asleep.
    func sendCommand(_ type: CommandType, for session: Session) async {
        guard let host = session.host else { return }
        let id = session.id
        let name = machineLabel(for: host)
        let state = FocusState(cmdId: UUID().uuidString.lowercased(),
                               type: type,
                               name: name,
                               appName: host.app.name.isEmpty ? "the app" : host.app.name,
                               startedAt: Date())
        setFocus(id, state)
        armAckTimer(id, cmdId: state.cmdId, after: Self.ackTimeout)

        if isDemo {
            demoAck(id, state, machineId: host.machine.id)
            return
        }
        guard let board else { return }
        let receipt: CommandReceipt
        do {
            receipt = try await AgStatusAPI.postCommand(id: state.cmdId, type: type,
                                                        sessionId: id, for: board)
        } catch {
            if isCurrent(id, state.cmdId) {
                showResult(id, .fail, Self.sendErrorText(error))
            }
            return
        }
        // A newer tap, or an ack that beat the response, already took over.
        guard isCurrent(id, state.cmdId) else { return }
        focus[id]?.text = receipt.delivered ? "Sent…" : "Sent — \(name) is not connected"
    }

    /// Applies a `command_ack`. Only the command this card is waiting on: an
    /// older one that a re-tap superseded, or a stray ack, has nothing to say.
    func handleAck(_ ack: CommandAck) {
        let id = ack.sessionId
        guard let state = focus[id], state.cmdId == ack.id, !state.done else { return }
        let name = state.name
        switch ack.result {
        case .focused:
            showResult(id, .ok, "Brought to front on \(name)")
            return
        case .activated:
            showResult(id, .ok, "Opened \(state.appName) on \(name) — couldn't find the exact window")
            return
        case .selected:
            showResult(id, .ok, "Selected the pane on \(name); the window stayed behind")
            return
        case .resumed:
            showResult(id, .ok, "Resumed on \(name)")
            return
        case .failed, .other:
            break
        }
        switch ack.reason {
        case .superseded:
            showResult(id, .ok, "Replaced by a newer tap")
            return
        case .notRunning:
            showResult(id, .fail, "Not running on \(name)", offerResume: true)
            return
        case .expired:
            showResult(id, .fail, "No answer from \(name) — is it asleep?")
            return
        case .unsupportedType where state.type == .resume:
            showResult(id, .fail, "Resume isn't available yet")
            return
        default:
            break
        }
        // As the web board puts it: the reason, else the result, else
        // "unknown" — an `.other("")` is an empty string here, not a nil.
        let detail = [ack.reason?.rawValue, ack.result.rawValue]
            .compactMap { $0 }
            .first { !$0.isEmpty } ?? "unknown"
        showResult(id, .fail, "Couldn't bring it to front (\(detail))")
    }

    /// A "Bring to front" tapped on a push. Remembered until the board is in
    /// (the snapshot, and the presence frame that follows it), then sent if
    /// the session is still there with its machine online — otherwise the
    /// app has simply opened, as the default tap would have.
    func focusFromNotification(sessionId: String) {
        notificationFocus = (sessionId, Date())
        if connection == .live || isDemo {
            applyNotificationFocus()
        }
    }

    private func applyNotificationFocus() {
        guard let request = notificationFocus else { return }
        notificationFocus = nil
        // A request older than this was for a board that took too long to
        // come back; acting on it now would surprise.
        guard Date().timeIntervalSince(request.at) < 60,
              let session = sessions.first(where: { $0.id == request.sessionId }),
              let host = session.host,
              isMachineOnline(host.machine.id) else { return }
        Task { await sendCommand(.focus, for: session) }
    }

    /// After a (re)connect, asks the server where each command still pending
    /// got to — the phone drops its stream in the background, so the ack may
    /// have been broadcast while nobody was listening. The 15 s window still
    /// counts from the tap. Unreachable? Keep waiting for what is left of it.
    private func reconcilePendingCommands(for board: Board) async {
        for (id, state) in focus where !state.done {
            let outcome: Result<CommandStatus, Error>
            do {
                outcome = .success(try await AgStatusAPI.command(state.cmdId, for: board))
            } catch {
                outcome = .failure(error)
            }
            guard isCurrent(id, state.cmdId) else { continue }
            let asleep = "No answer from \(state.name) — is it asleep?"
            switch outcome {
            case .success(let status) where status.state == .done:
                handleAck(CommandAck(id: state.cmdId, sessionId: id, machineId: status.machineId,
                                     type: state.type, result: status.result ?? .other(""),
                                     reach: status.reach, reason: status.reason))
            case .success(let status) where status.state == .expired:
                showResult(id, .fail, asleep)
            case .failure(let error as APIError) where error == .boardNotFound:
                // The server no longer knows the command: swept, or restarted.
                showResult(id, .fail, asleep)
            default:
                keepAckWindow(id, state)
            }
        }
    }

    /// Demo taps never touch the network: "Sent…" after a beat, then a
    /// `focused` (or `resumed`) ack about a second in.
    private func demoAck(_ id: String, _ state: FocusState, machineId: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, self.isDemo, self.isCurrent(id, state.cmdId) else { return }
            self.focus[id]?.text = "Sent…"
            try? await Task.sleep(for: .milliseconds(700))
            guard self.isDemo, self.isCurrent(id, state.cmdId) else { return }
            self.handleAck(CommandAck(id: state.cmdId, sessionId: id, machineId: machineId,
                                      type: state.type,
                                      result: state.type == .resume ? .resumed : .focused,
                                      reach: .pane, reason: nil))
        }
    }

    /// Why a tap couldn't be sent, in the board's words. 404 here is an
    /// unknown session, never a gone board.
    private static func sendErrorText(_ error: Error) -> String {
        switch error as? APIError {
        case .boardNotFound: "Session gone"
        case .rateLimited: "Too many taps — wait a moment"
        case .badResponse(401): "Not allowed — this board needs the webhook secret"
        case .badResponse(409): "No machine info for this session"
        case .badResponse(let code): "Couldn't send (HTTP \(code))"
        case .atCapacity: "Couldn't send (HTTP 503)"
        case .unreachable, .insecureRemote, .legacyServer, .none: "Couldn't reach the board"
        }
    }

    /// A final outcome: successes fade after a while, failures stay until the next tap.
    private func showResult(_ id: String, _ kind: FocusState.Kind, _ text: String,
                            offerResume: Bool = false) {
        guard var state = focus[id] else { return }
        state.done = true
        state.kind = kind
        state.text = text
        state.resumeOffered = offerResume
        focus[id] = state
        cancelFocusTimer(id)
        guard kind == .ok else { return }
        let cmdId = state.cmdId
        focusTimers[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.statusClearDelay))
            guard !Task.isCancelled, let self, self.focus[id]?.cmdId == cmdId else { return }
            self.setFocus(id, nil)
        }
    }

    /// Whether `cmdId` is still the command the card is waiting on.
    private func isCurrent(_ id: String, _ cmdId: String) -> Bool {
        guard let state = focus[id] else { return false }
        return state.cmdId == cmdId && !state.done
    }

    private func setFocus(_ id: String, _ state: FocusState?) {
        cancelFocusTimer(id)
        focus[id] = state
    }

    private func armAckTimer(_ id: String, cmdId: String, after seconds: TimeInterval) {
        cancelFocusTimer(id)
        focusTimers[id] = Task { [weak self] in
            // The default leeway is a tenth of the interval; keep "15 s" honest.
            try? await Task.sleep(for: .seconds(seconds), tolerance: .milliseconds(250))
            guard !Task.isCancelled, let self, self.isCurrent(id, cmdId),
                  let name = self.focus[id]?.name else { return }
            self.showResult(id, .fail, "No answer from \(name) — is it asleep?")
        }
    }

    /// Re-arms the ack deadline for what is left of the 15 s window since
    /// the tap — or, with nothing left, declares the machine asleep.
    private func keepAckWindow(_ id: String, _ state: FocusState) {
        let remaining = Self.ackTimeout - Date().timeIntervalSince(state.startedAt)
        if remaining <= 0 {
            showResult(id, .fail, "No answer from \(state.name) — is it asleep?")
        } else {
            armAckTimer(id, cmdId: state.cmdId, after: remaining)
        }
    }

    private func cancelFocusTimer(_ id: String) {
        focusTimers[id]?.cancel()
        focusTimers[id] = nil
    }

    /// Drops focus entries for sessions no longer on the board.
    private func pruneFocus() {
        let present = Set(sessions.map(\.id))
        for id in focus.keys where !present.contains(id) {
            setFocus(id, nil)
        }
    }

    private func clearFocus() {
        for id in focus.keys {
            cancelFocusTimer(id)
        }
        focus = [:]
        notificationFocus = nil
    }

    /// The board is gone: nothing on it can be focused any more.
    private func markBoardGone() {
        connection = .boardGone
        machines = [:]
        clearFocus()
    }

    // MARK: Demo mode

    /// Board-less fake mode driven by DemoData on a ~4s tick.
    func startDemo() {
        cancelStream()
        stopDemoTask()
        #if DEBUG
        DemoData.verifyFocusDecoding()
        #endif
        sessions = Self.sortedByUpdate(DemoData.initialSessions())
        usage = DemoData.usage()
        machines = DemoData.machines()
        clearFocus()
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
        machines = [:]
        clearFocus()
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
