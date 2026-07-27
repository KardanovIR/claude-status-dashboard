//
//  API.swift
//  AgStatus
//
//  REST client for the status server: config probing, workspace creation,
//  session listing, dismissal, board deletion, pairing codes, push device
//  registration, and board-URL parsing. One shared URLSession with a 10s
//  request timeout.
//

import Foundation

// MARK: - APIError

enum APIError: LocalizedError, Equatable {
    case unreachable            // network failure / timeout
    case boardNotFound          // 404 unknown workspace
    case rateLimited            // 429
    case atCapacity             // 503
    case legacyServer           // pairing requested on a legacy server
    case insecureRemote         // http:// to a remote host — ATS will block it
    case badResponse(Int)

    var errorDescription: String? {
        switch self {
        case .unreachable:
            return "Can't reach the server. Check your connection and try again."
        case .insecureRemote:
            return "Remote servers need HTTPS. Plain http:// only works on your local network (localhost, IP addresses, or .local names)."
        case .boardNotFound:
            return "This board no longer exists."
        case .rateLimited:
            return "Too many requests. Wait a moment and try again."
        case .atCapacity:
            return "The server is at capacity right now. Try again later."
        case .legacyServer:
            return "This server doesn't support pairing codes."
        case .badResponse(let code):
            return "Unexpected server response (\(code))."
        }
    }
}

// MARK: - ServerMode

enum ServerMode: String, Sendable {
    case multi, legacy
}

// MARK: - AgStatusAPI

enum AgStatusAPI {

    // MARK: Public surface

    /// Probes `<base>/api/config`. Unknown/missing modes are treated as legacy.
    static func serverMode(of base: URL) async throws -> ServerMode {
        let origin = normalizedOrigin(base) ?? base
        let url = origin.appendingPathComponent("api").appendingPathComponent("config")
        let data = try await send("GET", url)
        let config = try decode(ConfigResponse.self, from: data)
        return ServerMode(rawValue: config.mode ?? "") ?? .legacy
    }

    /// Creates a fresh workspace on a multi-tenant server. The board URL is
    /// built from the base actually used, not the server-reported dashboardUrl.
    static func createBoard(on base: URL) async throws -> Board {
        let origin = normalizedOrigin(base) ?? base
        let url = origin.appendingPathComponent("api").appendingPathComponent("workspaces")
        let data = try await send("POST", url)
        let created = try decode(WorkspaceResponse.self, from: data)
        return Board(baseURL: origin, token: created.token)
    }

    /// Parses a board URL as scanned/pasted by the user.
    /// Accepts `https://host/w/ags_<32 chars>` (with or without a trailing
    /// slash or `/webhook` suffix) and plain origins (legacy, token nil).
    /// Rejects non-http(s) URLs and any other path.
    static func parseBoardURL(_ url: URL) -> Board? {
        guard let origin = normalizedOrigin(url) else { return nil }

        var path = url.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/webhook") { path.removeLast("/webhook".count) }
        while path.hasSuffix("/") { path.removeLast() }

        if path.isEmpty {
            return Board(baseURL: origin, token: nil)
        }

        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 2, parts[0] == "w", isValidToken(parts[1]) else {
            return nil
        }
        return Board(baseURL: origin, token: parts[1])
    }

    /// Cheap liveness check: GETs the session list and discards it.
    static func validate(_ board: Board) async throws {
        _ = try await sessions(for: board)
    }

    static func sessions(for board: Board) async throws -> [Session] {
        let url = board.boardURL.appendingPathComponent("api").appendingPathComponent("sessions")
        let data = try await send("GET", url)
        return try decode([Session].self, from: data)
    }

    /// Plan usage limits reported by the board's agents. Older servers have
    /// no /api/usage — treat their 404/HTML responses as "no usage data".
    static func usage(for board: Board) async throws -> [UsageInfo] {
        let url = board.boardURL.appendingPathComponent("api").appendingPathComponent("usage")
        let data = try await send("GET", url)
        return (try? decode([UsageInfo].self, from: data)) ?? []
    }

    /// A session's timeline, newest first. Older servers without the
    /// endpoint just yield an empty history.
    static func history(of sessionId: String, for board: Board) async throws -> [HistoryEvent] {
        let url = board.boardURL
            .appendingPathComponent("api")
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("history")
        let data = try await send("GET", url)
        return (try? decode([HistoryEvent].self, from: data)) ?? []
    }

    static func deleteSession(_ id: String, from board: Board) async throws {
        let url = board.boardURL.appendingPathComponent("sessions").appendingPathComponent(id)
        _ = try await send("DELETE", url)
    }

    /// Deletes the whole board on the server (privacy reset).
    static func deleteBoard(_ board: Board) async throws {
        _ = try await send("DELETE", board.boardURL)
    }

    static func createPairCode(for board: Board) async throws -> PairCode {
        guard board.token != nil else { throw APIError.legacyServer }
        let url = board.boardURL.appendingPathComponent("pair")
        let data = try await send("POST", url)
        return try decode(PairCode.self, from: data)
    }

    /// Registers this device for pushes. Re-POSTing the same token is an
    /// upsert on the server, so this also updates the notify-done flag.
    static func registerDevice(_ deviceToken: String, notifyDone: Bool, for board: Board) async throws {
        guard board.token != nil else { throw APIError.legacyServer }
        let url = board.boardURL.appendingPathComponent("devices")
        let body = try JSONEncoder().encode(
            DeviceRegistration(deviceToken: deviceToken, platform: "ios", notifyDone: notifyDone)
        )
        _ = try await send("POST", url, body: body)
    }

    /// Removes this device's push registration from the board.
    static func unregisterDevice(_ deviceToken: String, for board: Board) async throws {
        guard board.token != nil else { throw APIError.legacyServer }
        let url = board.boardURL
            .appendingPathComponent("devices")
            .appendingPathComponent(deviceToken)
        _ = try await send("DELETE", url)
    }

    /// Whether the server advertises APNs push support. Nil means the probe
    /// couldn't reach the server (unknown — worth retrying later); false only
    /// when the server responded without claiming push support.
    static func serverSupportsPush(_ base: URL) async -> Bool? {
        let origin = normalizedOrigin(base) ?? base
        let url = origin.appendingPathComponent("api").appendingPathComponent("config")
        do {
            let data = try await send("GET", url)
            let config = try? decode(ConfigResponse.self, from: data)
            return config?.push ?? false
        } catch let error as APIError where error == .unreachable {
            return nil
        } catch {
            return false
        }
    }

    // MARK: Shared session

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 30
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    // MARK: Helpers

    /// ATS blocks cleartext HTTP to qualified remote hosts. Fail those with a
    /// specific, actionable message instead of a misleading "unreachable".
    /// (Loopback, IP literals, single-label names, and *.local are permitted
    /// by NSAllowsLocalNetworking, so plain-HTTP self-hosting on a LAN works.)
    static func checkTransportSecurity(_ url: URL) throws {
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return }
        let isIPv4 = host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
        let isIPv6 = host.contains(":")
        let isLocalName = !host.contains(".") || host.hasSuffix(".local")
        if !(isIPv4 || isIPv6 || isLocalName) {
            throw APIError.insecureRemote
        }
    }

    /// Performs a request and maps HTTP codes to APIError
    /// (404 → boardNotFound, 429 → rateLimited, 503 → atCapacity).
    /// A non-nil body is sent as JSON with the matching Content-Type.
    private static func send(_ method: String, _ url: URL, body: Data? = nil) async throws -> Data {
        try checkTransportSecurity(url)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.unreachable
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unreachable
        }
        switch http.statusCode {
        case 200..<300: return data
        case 404: throw APIError.boardNotFound
        case 429: throw APIError.rateLimited
        case 503: throw APIError.atCapacity
        default: throw APIError.badResponse(http.statusCode)
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.badResponse(200)
        }
    }

    /// Strips path/query/fragment, keeping scheme://host[:port]. Nil for
    /// anything that isn't http(s) with a host.
    private static func normalizedOrigin(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else {
            return nil
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url
    }

    /// Tokens match ^ags_[A-Za-z0-9_-]{32}$.
    private static func isValidToken(_ token: String) -> Bool {
        guard token.hasPrefix("ags_") else { return false }
        let body = token.dropFirst(4)
        guard body.count == 32 else { return false }
        return body.allSatisfy { character in
            character.isASCII
                && (character.isLetter || character.isNumber
                    || character == "_" || character == "-")
        }
    }
}

// MARK: - Wire payloads

private struct ConfigResponse: Decodable {
    let mode: String?
    let push: Bool?
}

private struct WorkspaceResponse: Decodable {
    let token: String
}

private struct DeviceRegistration: Encodable {
    let deviceToken: String
    let platform: String
    let notifyDone: Bool

    private enum CodingKeys: String, CodingKey {
        case deviceToken = "device_token"
        case platform
        case notifyDone = "notify_done"
    }
}
