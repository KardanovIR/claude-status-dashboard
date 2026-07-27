import SwiftUI
import UIKit

/// The live board: one glanceable card per agent session.
struct BoardView: View {
    @Environment(SessionStore.self) private var store
    @Environment(NotificationManager.self) private var notifications
    @AppStorage("pushTipShown") private var pushTipShown = false

    @State private var showPairSheet = false
    @State private var showSettings = false
    @State private var copiedWebhook = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !visibleUsage.isEmpty && store.connection != .boardGone {
                    UsageBarsView(usage: visibleUsage)
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                Group {
                    if store.connection == .boardGone {
                        boardGoneView
                    } else if store.sessions.isEmpty {
                        // "No agents yet" is only true when we're actually live —
                        // while (re)connecting, an empty list just means "unknown".
                        if store.isDemo || store.connection == .live {
                            emptyState
                        } else {
                            connectingState
                        }
                    } else {
                        sessionList
                    }
                }
            }
            .animation(.snappy, value: visibleUsage)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("AgStatus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("AgStatus")
                        .font(.system(.headline, design: .rounded).weight(.bold))
                        .foregroundStyle(Theme.textPrimary)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if store.isDemo {
                        demoBadge
                    } else {
                        connectionDot
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if store.board?.token != nil && store.connection != .boardGone {
                        Button {
                            showPairSheet = true
                        } label: {
                            Image(systemName: "laptopcomputer.and.arrow.down")
                        }
                        .accessibilityLabel("Pair your computer")
                    }
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task(id: store.board) {
                if let board = store.board, board.token != nil, !pushTipShown {
                    await notifications.probeServerSupport(for: board)
                }
            }
        }
    }

    // MARK: - Usage visibility

    /// Only limits of agents that actually have sessions on the board — a
    /// Claude-only evening doesn't need Codex bars.
    private var visibleUsage: [UsageInfo] {
        let active = Set(store.sessions.map(\.source))
        return store.usage.filter { active.contains($0.source) }
    }

    // MARK: - Session list

    private var sessionList: some View {
        List {
            ForEach(store.sessions) { session in
                SessionCardView(session: session)
                    // Invisible link keeps the card design chevron-free while
                    // making the whole card open the session's history.
                    .overlay {
                        NavigationLink(value: session.id) { EmptyView() }
                            .opacity(0)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            Task { await store.dismiss(session) }
                        } label: {
                            Label("Dismiss", systemImage: "xmark.circle.fill")
                        }
                        .tint(Theme.color(for: .blocked))
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .navigationDestination(for: String.self) { sessionId in
            SessionHistoryView(sessionId: sessionId)
        }
        .refreshable { await store.refresh() }
        .animation(.snappy, value: store.sessions)
        .safeAreaInset(edge: .bottom) {
            if showsPushTip {
                pushTip
            }
        }
    }

    // MARK: - Push tip

    /// One-time nudge: the board is live, the server can push, and the user
    /// hasn't opted in (or dismissed the tip) yet.
    private var showsPushTip: Bool {
        !pushTipShown
            && !store.isDemo
            && store.connection == .live
            && !store.sessions.isEmpty
            && notifications.state == .off
            && notifications.serverPushAvailable == true
            && store.board?.token != nil
    }

    private var pushTip: some View {
        HStack(spacing: 10) {
            Image(systemName: "bell.badge")
                .font(.subheadline)
                .foregroundStyle(Theme.color(for: .planning))
                .accessibilityHidden(true)
            Text("Get a ping when an agent needs you")
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Enable") {
                withAnimation { pushTipShown = true }
                if let board = store.board {
                    Task { await notifications.enable(for: board) }
                }
            }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.color(for: .planning))
            Button {
                withAnimation { pushTipShown = true }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notification tip")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.cardBorder)
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityHidden(true)
                Text("No agents yet")
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("Pair your computer and your coding agents will show up here the moment they report in.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)

                if store.board?.token != nil {
                    Button {
                        showPairSheet = true
                    } label: {
                        Label("Pair your computer", systemImage: "laptopcomputer.and.arrow.down")
                            .font(.headline)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.color(for: .planning))
                    .padding(.top, 4)
                }

                if let board = store.board {
                    VStack(spacing: 8) {
                        Text("Or send updates straight to the webhook:")
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                        webhookRow(board.webhookURL)
                    }
                    .padding(.top, 16)
                }
            }
            .padding(24)
            .padding(.top, 64)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
    }

    private func webhookRow(_ url: URL) -> some View {
        Button {
            UIPasteboard.general.string = url.absoluteString
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withAnimation { copiedWebhook = true }
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation { copiedWebhook = false }
            }
        } label: {
            HStack(spacing: 8) {
                Text(url.absoluteString)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: copiedWebhook ? "checkmark" : "doc.on.doc")
                    .font(.footnote)
                    .foregroundStyle(copiedWebhook ? Theme.color(for: .done) : Theme.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy webhook URL")
    }

    // MARK: - Connecting

    private var connectingState: some View {
        ScrollView {
            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.textSecondary)
                Text("Connecting to your board…")
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                Text("Pull down to retry.")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary.opacity(0.7))
            }
            .padding(.top, 160)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await store.refresh() }
    }

    // MARK: - Board gone

    private var boardGoneView: some View {
        VStack(spacing: 16) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 44))
                .foregroundStyle(Theme.color(for: .blocked))
                .accessibilityHidden(true)
            Text("This board no longer exists")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("It was probably deleted. Your device is fine — just set up a new one.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                store.disconnectBoard()
            } label: {
                Text("Start over")
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.color(for: .planning))
            .padding(.top, 4)
        }
        .padding(32)
    }

    // MARK: - Toolbar bits

    private var connectionDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 9, height: 9)
            .shadow(color: dotColor.opacity(0.6), radius: 3)
            .accessibilityLabel(dotDescription)
    }

    private var dotColor: Color {
        switch store.connection {
        case .live:
            Theme.color(for: .done)
        case .connecting, .reconnecting:
            Theme.color(for: .testing)
        case .boardGone:
            Theme.color(for: .blocked)
        case .idle, .demo:
            Theme.color(for: .idle)
        }
    }

    private var dotDescription: String {
        switch store.connection {
        case .live: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .boardGone: "Board not found"
        case .idle: "Not connected"
        case .demo: "Demo"
        }
    }

    private var demoBadge: some View {
        Text("DEMO")
            .font(.system(.caption2, design: .rounded).weight(.bold))
            .kerning(1)
            .fixedSize()
            .foregroundStyle(Theme.color(for: .coding))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Theme.color(for: .coding).opacity(0.15)))
            .overlay(Capsule().strokeBorder(Theme.color(for: .coding).opacity(0.35)))
            .accessibilityLabel("Demo mode")
    }
}

// MARK: - Usage bars

/// Full-width plan-limit bars pinned above the board: one row per reported
/// window (current 5-hour session, weekly caps, …).
struct UsageBarsView: View {
    let usage: [UsageInfo]

    /// Redraws every minute so the "resets in …" countdowns stay honest.
    private static let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    @State private var now = Date()

    var body: some View {
        VStack(spacing: 12) {
            ForEach(usage) { info in
                ForEach(info.windows) { window in
                    UsageBarRow(sourceName: info.displayName, window: window, now: now)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.cardBorder)
        )
        .onReceive(Self.clock) { now = $0 }
    }
}

private struct UsageBarRow: View {
    let sourceName: String
    let window: UsageWindow
    let now: Date

    private var fraction: Double {
        min(max(window.usedPct / 100, 0), 1)
    }

    private var barColor: Color {
        if window.usedPct >= 85 { return Theme.color(for: .blocked) }
        if window.usedPct >= 60 { return Theme.color(for: .testing) }
        return Theme.color(for: .done)
    }

    private var pctText: String {
        "\(Int(window.usedPct.rounded()))%"
    }

    /// "resets in 2h 15m" — nil once the reset time is unknown or passed.
    private var resetText: String? {
        guard let date = window.resetsDate else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        guard seconds > 60 else { return seconds > 0 ? "resets soon" : nil }
        // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
        let totalMinutes = (seconds + 30) / 60
        if totalMinutes < 60 { return "resets in \(totalMinutes)m" }
        let totalHours = totalMinutes / 60
        if totalHours < 24 {
            let minutes = totalMinutes % 60
            return minutes > 0 ? "resets in \(totalHours)h \(minutes)m" : "resets in \(totalHours)h"
        }
        let days = totalHours / 24
        let hours = totalHours % 24
        return hours > 0 ? "resets in \(days)d \(hours)h" : "resets in \(days)d"
    }

    var body: some View {
        VStack(spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(sourceName) · \(window.label)")
                    .font(.system(.caption2, design: .rounded).weight(.semibold))
                    .kerning(0.4)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(pctText)
                    .font(.system(.caption, design: .rounded).weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textPrimary)
                if let resetText {
                    Text("· \(resetText)")
                        .font(.system(.caption2, design: .rounded))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .layoutPriority(-1)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.06))
                    Capsule()
                        .fill(barColor)
                        // A hairline of progress stays visible even at ~0%.
                        .frame(width: fraction > 0 ? max(geo.size.width * fraction, 4) : 0)
                        .animation(.snappy, value: fraction)
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(sourceName) \(window.label): \(pctText) used\(resetText.map { ", \($0)" } ?? "")"
        )
    }
}
