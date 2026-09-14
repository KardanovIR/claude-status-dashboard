//
//  Models.swift
//  AgStatus
//
//  Core value types shared across the app: agent status, session (with its
//  optional Focus host), listener presence and command acks, board (server +
//  workspace token) and pairing codes.
//

import Foundation

// MARK: - AgentStatus

enum AgentStatus: String, Codable, CaseIterable, Sendable {
    case idle, planning, coding, testing, blocked, done

    /// Capitalized English label, e.g. "Coding".
    var label: String {
        rawValue.capitalized
    }

    /// Statuses that represent an agent actively working.
    var isActive: Bool {
        switch self {
        case .planning, .coding, .testing: return true
        case .idle, .blocked, .done: return false
        }
    }
}

// MARK: - Session

struct Session: Identifiable, Codable, Equatable, Sendable {
    let id: String
    var name: String
    var status: AgentStatus
    var message: String
    var project: String
    /// Agent kind that owns the session ("claude", "codex", …).
    var source: String
    var createdAt: Int64 // epoch milliseconds
    var updatedAt: Int64 // epoch milliseconds
    /// Where the session runs, when its hook opted in to Focus; nil for the
    /// many sessions that haven't (the server always sends the key).
    var host: Host?

    var updatedDate: Date {
        Date(timeIntervalSince1970: Double(updatedAt) / 1000)
    }

    init(id: String,
         name: String,
         status: AgentStatus,
         message: String,
         project: String,
         source: String = "claude",
         createdAt: Int64,
         updatedAt: Int64,
         host: Host? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.message = message
        self.project = project
        self.source = source
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.host = host
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, status, message, project, source, createdAt, updatedAt, host
    }

    /// Tolerant decoding: unknown status strings become `.idle`, missing
    /// secondary fields fall back to sensible defaults. Only `id` is required.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = (try? container.decode(String.self, forKey: .name)) ?? ""
        let rawStatus = (try? container.decode(String.self, forKey: .status)) ?? ""
        status = AgentStatus(rawValue: rawStatus) ?? .idle
        message = (try? container.decode(String.self, forKey: .message)) ?? ""
        project = (try? container.decode(String.self, forKey: .project)) ?? ""
        let rawSource = (try? container.decode(String.self, forKey: .source)) ?? ""
        source = rawSource.isEmpty ? "claude" : rawSource
        createdAt = Self.decodeMillis(container, .createdAt) ?? 0
        updatedAt = Self.decodeMillis(container, .updatedAt) ?? createdAt
        // null, absent, or malformed all mean "no host" — never a dropped card.
        host = try? container.decode(Host.self, forKey: .host)
    }

    /// Accepts integral or floating epoch-milliseconds values.
    private static func decodeMillis(_ container: KeyedDecodingContainer<CodingKeys>,
                                     _ key: CodingKeys) -> Int64? {
        if let value = try? container.decode(Int64.self, forKey: key) {
            return value
        }
        // Int64(exactly:) never traps — out-of-range/NaN/inf fall through to defaults.
        if let value = try? container.decode(Double.self, forKey: key),
           let millis = Int64(exactly: value.rounded()) {
            return millis
        }
        return nil
    }
}

// MARK: - Focus

/// Where a session runs, as the hook reports it once Focus is opted in
/// (docs/design/focus-protocol.md §3.2): a label and per-board id for the
/// machine, and the app hosting the session. Two short labels — nothing that
/// names a path, a binary or a window.
struct Host: Codable, Equatable, Sendable {

    struct Machine: Codable, Equatable, Sendable {
        /// Per-board id, 32 hex. The listener proves ownership with a key the
        /// board never sees, so to a viewer the id is only a routing label.
        let id: String
        var name: String

        init(id: String, name: String) {
            self.id = id
            self.name = name
        }

        private enum CodingKeys: String, CodingKey {
            case id, name
        }

        /// Only the id is required (and must not be blank); a missing name
        /// falls back to "" so the board can substitute its own label.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let rawID = try container.decode(String.self, forKey: .id)
            guard !rawID.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .id, in: container,
                                                       debugDescription: "blank machine id")
            }
            id = rawID
            name = (try? container.decode(String.self, forKey: .name)) ?? ""
        }
    }

    struct App: Codable, Equatable, Sendable {
        /// Server-whitelisted app slug ("agterm", "iterm2", "vscode", …, "other").
        var slug: String
        var name: String
        /// "terminal", "multiplexer", "ide", "desktop-app" or "unknown".
        var kind: String

        init(slug: String, name: String, kind: String) {
            self.slug = slug
            self.name = name
            self.kind = kind
        }

        private enum CodingKeys: String, CodingKey {
            case slug, name, kind
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            slug = (try? container.decode(String.self, forKey: .slug)) ?? "other"
            name = (try? container.decode(String.self, forKey: .name)) ?? ""
            kind = (try? container.decode(String.self, forKey: .kind)) ?? "unknown"
        }
    }

    var machine: Machine
    var app: App

    init(machine: Machine, app: App) {
        self.machine = machine
        self.app = app
    }

    private enum CodingKeys: String, CodingKey {
        case machine, app
    }

    /// A host without a usable machine is no host at all (the session decodes
    /// with `host == nil`); a missing app just gets the neutral defaults.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        machine = try container.decode(Machine.self, forKey: .machine)
        app = (try? container.decode(App.self, forKey: .app))
            ?? App(slug: "other", name: "", kind: "unknown")
    }
}

/// A Focus listener's presence, from the `machines` and `machine` SSE frames
/// (and `GET <base>/api/machines`). An offline frame carries no name; the
/// store keeps the last one it saw for the "<name> is offline" copy.
struct MachinePresence: Identifiable, Codable, Equatable, Sendable {
    let id: String
    var name: String?
    var online: Bool
    /// Epoch milliseconds since the listener connected (online frames).
    var since: Int64?
    /// Epoch milliseconds the listener was last seen (offline frames).
    var lastSeen: Int64?

    var lastSeenDate: Date? {
        lastSeen.map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }

    init(id: String, name: String?, online: Bool, since: Int64? = nil, lastSeen: Int64? = nil) {
        self.id = id
        self.name = name
        self.online = online
        self.since = since
        self.lastSeen = lastSeen
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, online, since, lastSeen
    }

    /// Tolerant decoding, mirroring Session: only `id` is required, an
    /// unreadable `online` counts as offline, and bad timestamps become nil.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try? container.decode(String.self, forKey: .name)
        online = (try? container.decode(Bool.self, forKey: .online)) ?? false
        since = decodeOptionalMillis(container, .since)
        lastSeen = decodeOptionalMillis(container, .lastSeen)
    }
}

/// The string enums of the command channel (docs/api.md "Focus commands").
/// The server may grow them, and one unknown value must never drop a whole
/// frame — so each keeps an `.other(raw)` case and always decodes. They are
/// deliberately not RawRepresentable: the stdlib's `==` for raw-value types
/// compares `rawValue`s, which here is derived from `==` — a loop.
protocol CommandEnum: Codable, Hashable, Sendable {
    /// Every known case with its wire spelling.
    static var wireNames: [(Self, String)] { get }
    static func other(_ raw: String) -> Self
    /// The raw text of an `.other`; nil for a known case.
    var otherRaw: String? { get }
}

extension CommandEnum {
    /// The known case for a wire spelling, else `.other`.
    static func fromWire(_ raw: String) -> Self {
        wireNames.first { $0.1 == raw }?.0 ?? other(raw)
    }

    init(rawValue: String) {
        self = Self.fromWire(rawValue)
    }

    var rawValue: String {
        otherRaw ?? Self.wireNames.first { $0.0 == self }?.1 ?? ""
    }

    init(from decoder: Decoder) throws {
        self = Self.fromWire(try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// What a tap asks for: bring the window to the front, or start the session
/// again after "not running".
enum CommandType: CommandEnum {
    case focus, resume
    case other(String)

    static let wireNames: [(Self, String)] = [(.focus, "focus"), (.resume, "resume")]

    var otherRaw: String? {
        if case .other(let raw) = self { return raw }
        return nil
    }
}

/// How the listener's attempt ended.
enum CommandResult: CommandEnum {
    case focused, activated, selected, resumed, failed
    case other(String)

    static let wireNames: [(Self, String)] = [
        (.focused, "focused"), (.activated, "activated"), (.selected, "selected"),
        (.resumed, "resumed"), (.failed, "failed"),
    ]

    var otherRaw: String? {
        if case .other(let raw) = self { return raw }
        return nil
    }
}

/// How far the listener got: the exact pane, a tab, a window, only the app,
/// or a thread in a desktop app.
enum CommandReach: CommandEnum {
    case pane, tab, window, app, thread
    case other(String)

    static let wireNames: [(Self, String)] = [
        (.pane, "pane"), (.tab, "tab"), (.window, "window"), (.app, "app"), (.thread, "thread"),
    ]

    var otherRaw: String? {
        if case .other(let raw) = self { return raw }
        return nil
    }
}

/// Why a command failed. Enums only — no free text ever crosses this channel.
enum CommandReason: CommandEnum {
    case noRecord, remote, notRunning, appNotRunning, consentNeeded, muxDetached,
         ambiguous, unsupportedHost, badRecord, respawnFailed, unsupportedType,
         superseded, expired
    case other(String)

    static let wireNames: [(Self, String)] = [
        (.noRecord, "no-record"), (.remote, "remote"), (.notRunning, "not-running"),
        (.appNotRunning, "app-not-running"), (.consentNeeded, "consent-needed"),
        (.muxDetached, "mux-detached"), (.ambiguous, "ambiguous"),
        (.unsupportedHost, "unsupported-host"), (.badRecord, "bad-record"),
        (.respawnFailed, "respawn-failed"), (.unsupportedType, "unsupported-type"),
        (.superseded, "superseded"), (.expired, "expired"),
    ]

    var otherRaw: String? {
        if case .other(let raw) = self { return raw }
        return nil
    }
}

/// A `command_ack` frame: a command finished — acked by the listener,
/// superseded by a re-tap or the session's removal, or expired at the TTL.
struct CommandAck: Codable, Equatable, Sendable {
    let id: String
    let sessionId: String
    var machineId: String
    var type: CommandType
    var result: CommandResult
    var reach: CommandReach?
    var reason: CommandReason?

    init(id: String, sessionId: String, machineId: String, type: CommandType,
         result: CommandResult, reach: CommandReach?, reason: CommandReason?) {
        self.id = id
        self.sessionId = sessionId
        self.machineId = machineId
        self.type = type
        self.result = result
        self.reach = reach
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, result, reach, reason
        case sessionId = "session_id"
        case machineId = "machine_id"
    }

    /// Only the two ids are required — they say which card the ack is for.
    /// `reach` and `reason` are `null` when unset.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        machineId = (try? container.decode(String.self, forKey: .machineId)) ?? ""
        type = CommandType(rawValue: (try? container.decode(String.self, forKey: .type)) ?? "")
        result = CommandResult(rawValue: (try? container.decode(String.self, forKey: .result)) ?? "")
        reach = (try? container.decode(String.self, forKey: .reach)).map(CommandReach.init(rawValue:))
        reason = (try? container.decode(String.self, forKey: .reason)).map(CommandReason.init(rawValue:))
    }
}

/// `POST <base>/commands` — whether a listener for the session's machine was
/// connected when the command went out.
struct CommandReceipt: Codable, Equatable, Sendable {
    let id: String
    var delivered: Bool
    var expiresInMs: Int64?

    init(id: String, delivered: Bool, expiresInMs: Int64? = nil) {
        self.id = id
        self.delivered = delivered
        self.expiresInMs = expiresInMs
    }

    private enum CodingKeys: String, CodingKey {
        case id, delivered
        case expiresInMs = "expires_in_ms"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        // Only an explicit `false` means "not connected" — the web board reads it the same way.
        delivered = (try? container.decode(Bool.self, forKey: .delivered)) ?? true
        expiresInMs = decodeOptionalMillis(container, .expiresInMs)
    }
}

/// `GET <base>/commands/:id` — where a command got to, for a phone that
/// backgrounded and missed the ack.
struct CommandStatus: Codable, Equatable, Sendable {
    enum State: CommandEnum {
        case pending, claimed, done, expired
        case other(String)

        static let wireNames: [(Self, String)] = [
            (.pending, "pending"), (.claimed, "claimed"), (.done, "done"), (.expired, "expired"),
        ]

        var otherRaw: String? {
            if case .other(let raw) = self { return raw }
            return nil
        }
    }

    let id: String
    var sessionId: String
    var machineId: String
    var type: CommandType
    var state: State
    var result: CommandResult?
    var reach: CommandReach?
    var reason: CommandReason?

    init(id: String, sessionId: String, machineId: String, type: CommandType, state: State,
         result: CommandResult? = nil, reach: CommandReach? = nil, reason: CommandReason? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.machineId = machineId
        self.type = type
        self.state = state
        self.result = result
        self.reach = reach
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, state, result, reach, reason
        case sessionId = "session_id"
        case machineId = "machine_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = (try? container.decode(String.self, forKey: .sessionId)) ?? ""
        machineId = (try? container.decode(String.self, forKey: .machineId)) ?? ""
        type = CommandType(rawValue: (try? container.decode(String.self, forKey: .type)) ?? "")
        state = State(rawValue: (try? container.decode(String.self, forKey: .state)) ?? "")
        result = (try? container.decode(String.self, forKey: .result)).map(CommandResult.init(rawValue:))
        reach = (try? container.decode(String.self, forKey: .reach)).map(CommandReach.init(rawValue:))
        reason = (try? container.decode(String.self, forKey: .reason)).map(CommandReason.init(rawValue:))
    }
}

// MARK: - HistoryEvent

/// One entry in a session's timeline: what the agent switched to, and when.
struct HistoryEvent: Identifiable, Codable, Equatable, Sendable {
    /// Server-assigned, monotonically increasing per session.
    let seq: Int64
    var status: AgentStatus
    var message: String
    /// Epoch milliseconds.
    var at: Int64

    var id: Int64 { seq }

    var date: Date {
        Date(timeIntervalSince1970: Double(at) / 1000)
    }

    init(seq: Int64, status: AgentStatus, message: String, at: Int64) {
        self.seq = seq
        self.status = status
        self.message = message
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case seq, status, message, at
    }

    /// Tolerant decoding, mirroring Session: unknown statuses become .idle.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int64.self, forKey: .seq)
        let rawStatus = (try? container.decode(String.self, forKey: .status)) ?? ""
        status = AgentStatus(rawValue: rawStatus) ?? .idle
        message = (try? container.decode(String.self, forKey: .message)) ?? ""
        at = (try? container.decode(Int64.self, forKey: .at)) ?? 0
    }
}

// MARK: - Usage

/// One plan-limit window (the 5-hour session window or a weekly cap).
struct UsageWindow: Identifiable, Codable, Equatable, Sendable {
    let id: String
    var label: String
    /// Percent of the limit consumed, 0–100.
    var usedPct: Double
    /// Epoch milliseconds when the window resets; nil when unknown.
    var resetsAt: Int64?

    var resetsDate: Date? {
        resetsAt.map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }

    init(id: String, label: String, usedPct: Double, resetsAt: Int64?) {
        self.id = id
        self.label = label
        self.usedPct = usedPct
        self.resetsAt = resetsAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, usedPct, resetsAt
    }

    /// Tolerant decoding, mirroring Session: only `id` is required, the
    /// percentage is clamped, and a malformed reset time becomes nil.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        let rawLabel = (try? container.decode(String.self, forKey: .label)) ?? ""
        label = rawLabel.isEmpty ? id : rawLabel
        let rawPct = (try? container.decode(Double.self, forKey: .usedPct)) ?? 0
        usedPct = rawPct.isFinite ? min(max(rawPct, 0), 100) : 0
        if let millis = try? container.decode(Int64.self, forKey: .resetsAt), millis > 0 {
            resetsAt = millis
        } else {
            resetsAt = nil
        }
    }
}

/// Plan usage reported by one agent kind ("claude", "codex", …).
struct UsageInfo: Identifiable, Codable, Equatable, Sendable {
    let source: String
    var windows: [UsageWindow]
    var updatedAt: Int64

    var id: String { source }

    /// Human name for the source, e.g. "Claude".
    var displayName: String {
        Self.displayName(for: source)
    }

    /// Human name for a bare source id, for screens that only carry the id.
    static func displayName(for source: String) -> String {
        switch source {
        case "claude": return "Claude"
        case "codex": return "Codex"
        default: return source.capitalized
        }
    }

    init(source: String, windows: [UsageWindow], updatedAt: Int64) {
        self.source = source
        self.windows = windows
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case source, windows, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        windows = (try? container.decode([UsageWindow].self, forKey: .windows)) ?? []
        updatedAt = (try? container.decode(Int64.self, forKey: .updatedAt)) ?? 0
    }
}

// MARK: - Usage history

/// Accepts integral or floating JSON numbers — JavaScript emits both for epoch
/// milliseconds and for token counts.
private func decodeNumber<Key>(_ container: KeyedDecodingContainer<Key>, _ key: Key) -> Double? {
    guard let value = try? container.decode(Double.self, forKey: key), value.isFinite else { return nil }
    return value
}

/// Epoch milliseconds from either JSON number shape; 0 when absent or absurd.
private func decodeMillis<Key>(_ container: KeyedDecodingContainer<Key>, _ key: Key) -> Int64 {
    guard let value = decodeNumber(container, key),
          let millis = Int64(exactly: value.rounded()) else { return 0 }
    return millis
}

/// Epoch milliseconds, or nil when the key is absent, null, or not a number.
private func decodeOptionalMillis<Key>(_ container: KeyedDecodingContainer<Key>, _ key: Key) -> Int64? {
    guard let value = decodeNumber(container, key) else { return nil }
    return Int64(exactly: value.rounded())
}

/// One recorded reading of a plan-limit window. The server writes a point only
/// when the percentage *changed*, so a series is a step function — and a board
/// that has only just started watching legitimately has a single point.
struct UsageHistoryPoint: Codable, Equatable, Sendable {
    /// Epoch milliseconds.
    var at: Int64
    /// Percent of the limit consumed at that moment, 0–100.
    var usedPct: Double

    init(at: Int64, usedPct: Double) {
        self.at = at
        self.usedPct = usedPct
    }

    private enum CodingKeys: String, CodingKey {
        case at, usedPct
    }

    /// Tolerant decoding, mirroring Session: nothing is required, the
    /// percentage is clamped, and a garbled timestamp becomes 0 (dropped by
    /// UsageHistorySeries).
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        at = decodeMillis(container, .at)
        let rawPct = decodeNumber(container, .usedPct) ?? 0
        usedPct = min(max(rawPct, 0), 100)
    }
}

/// The readings recorded for one window of one agent, oldest first.
struct UsageHistorySeries: Identifiable, Codable, Equatable, Sendable {
    var source: String
    var windowId: String
    var points: [UsageHistoryPoint]

    var id: String { "\(source)/\(windowId)" }

    init(source: String, windowId: String, points: [UsageHistoryPoint]) {
        self.source = source
        self.windowId = windowId
        self.points = points
    }

    private enum CodingKeys: String, CodingKey {
        case source, windowId, points
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? container.decode(String.self, forKey: .source)) ?? ""
        windowId = (try? container.decode(String.self, forKey: .windowId)) ?? ""
        // Sampling walks the points in order and stops early, so sort here once
        // rather than trusting the wire order.
        points = ((try? container.decode([UsageHistoryPoint].self, forKey: .points)) ?? [])
            .filter { $0.at > 0 }
            .sorted { $0.at < $1.at }
    }
}

/// Absolute tokens one project spent on one UTC day (not a delta).
struct UsageProjectDay: Codable, Equatable, Sendable {
    var source: String
    var project: String
    /// UTC day, "YYYY-MM-DD".
    var day: String
    var tokens: Double

    init(source: String, project: String, day: String, tokens: Double) {
        self.source = source
        self.project = project
        self.day = day
        self.tokens = tokens
    }

    private enum CodingKeys: String, CodingKey {
        case source, project, day, tokens
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? container.decode(String.self, forKey: .source)) ?? ""
        project = (try? container.decode(String.self, forKey: .project)) ?? ""
        day = (try? container.decode(String.self, forKey: .day)) ?? ""
        tokens = max(0, decodeNumber(container, .tokens) ?? 0)
    }
}

/// `GET <board>/api/usage/history?days=30` — limit readings and per-project
/// token totals for *every* source; callers filter to the one being shown.
struct UsageHistory: Codable, Equatable, Sendable {
    var days: Int
    var history: [UsageHistorySeries]
    var projects: [UsageProjectDay]

    static let defaultDays = 30
    static let empty = UsageHistory(days: defaultDays, history: [], projects: [])

    init(days: Int, history: [UsageHistorySeries], projects: [UsageProjectDay]) {
        self.days = days
        self.history = history
        self.projects = projects
    }

    private enum CodingKeys: String, CodingKey {
        case days, history, projects
    }

    /// Tolerant decoding: an older server that answers with something else
    /// entirely leaves an empty screen rather than an error.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        days = (try? container.decode(Int.self, forKey: .days)) ?? Self.defaultDays
        history = (try? container.decode([UsageHistorySeries].self, forKey: .history)) ?? []
        projects = (try? container.decode([UsageProjectDay].self, forKey: .projects)) ?? []
    }
}

extension UsageHistory {

    /// The `days` UTC days ending today, oldest first, as "YYYY-MM-DD".
    static func dayRange(_ days: Int) -> [String] {
        let count = min(max(days, 1), 365)
        // UTC days are exactly 86400s wide, so plain epoch arithmetic is safe.
        let todayStart = Int64(Date().timeIntervalSince1970 / 86_400) * 86_400
        return (0..<count).reversed().map { dayString(todayStart - Int64($0) * 86_400) }
    }

    /// Start of a "YYYY-MM-DD" UTC day in epoch milliseconds; 0 if unparseable.
    static func dayStartMillis(_ day: String) -> Int64 {
        guard let date = dayFormatter.date(from: day) else { return 0 }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    /// Step-samples a recorded series onto a day grid: for each day the last
    /// point at or before the end of that day, and nil for the days before the
    /// series starts (the board simply didn't know the limit yet).
    static func sampleSeries(_ points: [UsageHistoryPoint], onto days: [String]) -> [Double?] {
        days.map { day in
            let end = dayStartMillis(day) + 86_400_000 - 1
            var value: Double?
            for point in points {
                if point.at <= end { value = point.usedPct } else { break }
            }
            return value
        }
    }

    private static func dayString(_ epochSeconds: Int64) -> String {
        dayFormatter.string(from: Date(timeIntervalSince1970: Double(epochSeconds)))
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

// MARK: - Board

struct Board: Codable, Equatable, Sendable {
    /// Server origin, no trailing slash (e.g. https://host or https://host:8080).
    var baseURL: URL
    /// Workspace token (`ags_...`); nil means a legacy single-tenant server.
    var token: String?

    /// `<base>/w/<token>` for multi-tenant boards, or the base itself (legacy).
    var boardURL: URL {
        guard let token else { return baseURL }
        return baseURL.appendingPathComponent("w").appendingPathComponent(token)
    }

    /// Where agents POST status updates.
    var webhookURL: URL {
        boardURL.appendingPathComponent("webhook")
    }

    var isDefaultServer: Bool {
        baseURL.scheme?.lowercased() == Self.defaultServer.scheme?.lowercased()
            && baseURL.host?.lowercased() == Self.defaultServer.host?.lowercased()
            && baseURL.port == Self.defaultServer.port
    }

    /// The public default server. Constant lives here, in one place.
    static let defaultServer = URL(string: "https://agstatus.online")!
}

// MARK: - PairCode

struct PairCode: Codable, Equatable, Sendable {
    /// Dash-grouped pairing code, e.g. "AB12-CD34".
    let code: String
    let expiresInSeconds: Int

    /// The terminal command a user runs to wire their machine to the board.
    func command(for board: Board) -> String {
        var command = "npx agstatus init --code \(code)"
        if !board.isDefaultServer {
            command += " --url \(board.baseURL.absoluteString)"
        }
        return command
    }
}
