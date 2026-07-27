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
