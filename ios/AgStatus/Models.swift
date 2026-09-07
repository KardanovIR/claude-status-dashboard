//
//  Models.swift
//  AgStatus
//
//  Core value types shared across the app: agent status, session,
//  board (server + workspace token) and pairing codes.
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
         updatedAt: Int64) {
        self.id = id
        self.name = name
        self.status = status
        self.message = message
        self.project = project
        self.source = source
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, status, message, project, source, createdAt, updatedAt
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
