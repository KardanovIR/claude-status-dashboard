//
//  SSEClient.swift
//  AgStatus
//
//  Server-Sent Events client for `<board>/events`. Streams bytes via
//  URLSession, parses SSE frames incrementally (event:/data: lines
//  terminated by a blank line, ':' comment lines ignored) and yields
//  typed events. The store owns reconnect/backoff.
//

import Foundation

// MARK: - SSEEvent

enum SSEEvent: Sendable {
    case snapshot([Session])
    case upsert(Session)
    case remove(id: String)
}

// MARK: - SSEClient

final class SSEClient: Sendable {

    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        // The server sends a keepalive comment every 25s, so a healthy
        // stream never gets close to this request timeout.
        configuration.timeoutIntervalForRequest = 75
        // The stream itself is expected to stay open indefinitely.
        configuration.timeoutIntervalForResource = 365 * 24 * 3600
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    /// Connects to `<board>/events` and yields parsed events until the
    /// connection drops (stream finishes) or fails (stream throws:
    /// 404 → APIError.boardNotFound, 429 → .rateLimited, network → .unreachable).
    func events(for board: Board) -> AsyncThrowingStream<SSEEvent, Error> {
        let session = self.session
        let url = board.boardURL.appendingPathComponent("events")

        return AsyncThrowingStream { continuation in
            let task = Task {
                var request = URLRequest(url: url)
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.cachePolicy = .reloadIgnoringLocalCacheData

                do {
                    try AgStatusAPI.checkTransportSecurity(url)
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw APIError.unreachable
                    }
                    // Check status BEFORE consuming the stream.
                    switch http.statusCode {
                    case 200: break
                    case 404: throw APIError.boardNotFound
                    case 429: throw APIError.rateLimited
                    case 503: throw APIError.atCapacity
                    default: throw APIError.badResponse(http.statusCode)
                    }

                    // Parse raw bytes on newline boundaries. (AsyncLineSequence
                    // is avoided on purpose: it can skip the blank lines that
                    // delimit SSE frames.)
                    var parser = SSEParser()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if let event = parser.consume(byte) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch let error as APIError {
                    continuation.finish(throwing: error)
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: APIError.unreachable)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

// MARK: - SSEParser

/// Incremental SSE wire-format parser. Feed it bytes; it returns a decoded
/// event whenever a complete frame (terminated by a blank line) arrives.
private struct SSEParser {
    private var lineBuffer: [UInt8] = []
    private var eventName: String?
    private var dataLines: [String] = []

    mutating func consume(_ byte: UInt8) -> SSEEvent? {
        guard byte == 0x0A else { // \n
            lineBuffer.append(byte)
            return nil
        }
        if lineBuffer.last == 0x0D { // strip trailing \r
            lineBuffer.removeLast()
        }
        let line = String(decoding: lineBuffer, as: UTF8.self)
        lineBuffer.removeAll(keepingCapacity: true)
        return process(line)
    }

    private mutating func process(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            return flush()
        }
        if line.hasPrefix(":") { // comment / keepalive
            return nil
        }

        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { // spec: strip a single leading space
                value = value.dropFirst()
            }
        } else {
            field = line[...]
            value = ""
        }

        switch field {
        case "event":
            eventName = String(value)
        case "data":
            dataLines.append(String(value))
        default:
            break // id:, retry:, unknown fields — ignored
        }
        return nil
    }

    /// Builds an event from the accumulated frame, if any. Multi-line data
    /// is joined with "\n" per the SSE spec. Undecodable frames are dropped.
    private mutating func flush() -> SSEEvent? {
        defer {
            eventName = nil
            dataLines.removeAll(keepingCapacity: true)
        }
        guard !dataLines.isEmpty else { return nil }

        let payload = Data(dataLines.joined(separator: "\n").utf8)
        let decoder = JSONDecoder()

        switch eventName ?? "message" {
        case "snapshot":
            guard let sessions = try? decoder.decode([Session].self, from: payload) else { return nil }
            return .snapshot(sessions)
        case "session":
            guard let session = try? decoder.decode(Session.self, from: payload) else { return nil }
            return .upsert(session)
        case "remove":
            guard let removal = try? decoder.decode(RemovePayload.self, from: payload) else { return nil }
            return .remove(id: removal.id)
        default:
            return nil
        }
    }

    private struct RemovePayload: Decodable {
        let id: String
    }
}
