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
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
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
            // A second destination, on its own value type so it can't collide
            // with the session-id (String) destination inside the list.
            .navigationDestination(for: UsageDetailRoute.self) { route in
                UsageDetailView(source: route.source)
            }
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
                    // The demo badge says where you are; this says how you leave.
                    if store.isDemo {
                        Button("Exit Demo") {
                            store.stopDemo()
                        }
                        .font(.subheadline.weight(.semibold))
                        .tint(Theme.textSecondary)
                    }
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
            .task { await openHistoryForScreenshots() }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task(id: store.board) {
                if let board = store.board, board.token != nil, !pushTipShown {
                    await notifications.probeServerSupport(for: board)
                }
            }
        }
    }

    /// Debug-only deep links so screenshot automation can reach the pushed
    /// screens, which have no launch argument and cannot be tapped by simctl.
    /// AGSTATUS_OPEN_HISTORY=1 opens the first session's timeline;
    /// AGSTATUS_OPEN_USAGE=<source> opens that agent's usage history.
    private func openHistoryForScreenshots() async {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if let source = environment["AGSTATUS_OPEN_USAGE"], !source.isEmpty {
            // Demo usage is seeded synchronously; a real board's arrives over SSE.
            for _ in 0..<40 {
                if !store.usage.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if path.isEmpty {
                path.append(UsageDetailRoute(source: source))
            }
            return
        }
        guard environment["AGSTATUS_OPEN_HISTORY"] == "1" else { return }
        // Demo sessions are seeded synchronously; a real board arrives over SSE.
        for _ in 0..<40 {
            if !store.sessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let first = store.sessions.first, path.isEmpty {
            path.append(first.id)
        }
        #endif
    }

    // MARK: - Usage visibility

    /// Only limits of agents that actually have sessions on the board — a
    /// Claude-only evening doesn't need Codex bars. With no sessions there is
    /// nothing to disambiguate, and your limits still matter between runs, so
    /// everything is shown rather than nothing.
    private var visibleUsage: [UsageInfo] {
        let active = Set(store.sessions.map(\.source))
        guard !active.isEmpty else { return store.usage }
        return store.usage.filter { active.contains($0.source) }
    }

    // MARK: - Session list

    private var sessionList: some View {
        List {
            ForEach(store.sessions) { session in
                SessionCardView(session: session)
                    // No invisible full-card NavigationLink any more. It was
                    // an overlay across the whole card, which meant it sat on
                    // top of the Focus and Resume controls and could swallow
                    // the tap meant for them — a card that opens history when
                    // you asked it to raise a window. The card now carries an
                    // explicit Details button instead, which is also what makes
                    // both of its actions discoverable.
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
        .environment(\.openSession) { path.append($0) }
        .navigationDestination(for: String.self) { sessionId in
            SessionHistoryView(sessionId: sessionId)
        }
        .refreshable { await store.refresh() }
        // Keyed on the ORDER of cards, not their contents. Animating on
        // `store.sessions` crossfaded every card whenever any field changed, so
        // a session whose message updated drew the old and new text on top of
        // each other for the length of the transition — it read as a rendering
        // bug, which is what it was. Motion on this board should mean a card
        // arrived, left or moved; a message changing in place is not news.
        .animation(.snappy, value: store.sessions.map(\.id))
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
                .foregroundStyle(Theme.accent)
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
            .foregroundStyle(Theme.accent)
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
                    .tint(Theme.accent)
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
            .tint(Theme.accent)
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

    /// Says where you are, quietly.
    ///
    /// It used to be drawn in `coding` blue while the control beside it took
    /// the accent green — two different colours in one toolbar, neither of them
    /// meaning anything. It is a label, not a state and not an action, so it
    /// takes text colours: the chrome should say what it is without competing
    /// with the cards, which are the only things on this screen carrying colour
    /// that means something.
    private var demoBadge: some View {
        Text("DEMO")
            .font(.caption2.weight(.bold))
            .kerning(1)
            .fixedSize()
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(Capsule().strokeBorder(Theme.cardBorder))
            .accessibilityLabel("Demo mode")
    }
}

// MARK: - Usage bars

/// Plan-limit bars pinned above the board, grouped into one block per agent
/// (current 5-hour session, weekly caps, per-model caps).
struct UsageBarsView: View {
    let usage: [UsageInfo]

    /// Redraws every minute so the "resets in …" countdowns stay honest.
    private static let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    @State private var now = Date()
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// Up to three blocks abreast, two at a compact width, wrapping to further
    /// rows. Never more columns than blocks, so a lone agent spans the width.
    private var columnCount: Int {
        let maxColumns = horizontalSizeClass == .compact ? 2 : 3
        return max(1, min(usage.count, maxColumns))
    }

    /// Sharing a compact width leaves each block too narrow for a one-line
    /// row; those blocks stack the label above the value instead.
    private var narrowBlocks: Bool {
        horizontalSizeClass == .compact && columnCount > 1
    }

    var body: some View {
        LazyVGrid(
            columns: Array(
                repeating: GridItem(.flexible(), spacing: 10, alignment: .top),
                count: columnCount
            ),
            spacing: 10
        ) {
            ForEach(usage) { info in
                // The whole block opens that agent's last 30 days; the block
                // itself is unchanged.
                NavigationLink(value: UsageDetailRoute(source: info.source)) {
                    UsageSourceBlock(info: info, now: now, narrow: narrowBlocks)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the last 30 days")
            }
        }
        .onReceive(Self.clock) { now = $0 }
    }
}

/// One agent's limits: its name over its own bars, in its own card. The header
/// carries the agent name so the rows inside don't repeat it.
private struct UsageSourceBlock: View {
    let info: UsageInfo
    let now: Date
    let narrow: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(info.displayName)
                .font(.system(.caption2, design: .rounded).weight(.bold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            ForEach(info.windows) { window in
                UsageBarRow(sourceName: info.displayName, window: window, now: now, narrow: narrow)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
    }
}

private struct UsageBarRow: View {
    let sourceName: String
    let window: UsageWindow
    let now: Date
    var narrow = false

    private var fraction: Double {
        min(max(window.usedPct / 100, 0), 1)
    }

    /// Green, amber, red as the window fills — see Theme.limitColor.
    ///
    /// An earlier pass made this neutral-until-85% on the argument that colour
    /// on this board means state. That was the wrong call: the entire point of
    /// a limit bar is to be caught before it lands, and a grey bar at 62% tells
    /// you nothing you would act on. The middle band is amber rather than the
    /// `testing` teal it used to borrow, so the meter reads as its own scale
    /// instead of wearing a status colour.
    private var barColor: Color { Theme.limitColor(window.usedPct) }

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

    private var label: some View {
        Text(window.label)
            .font(.system(.caption2, design: .rounded).weight(.semibold))
            .kerning(0.4)
            .textCase(.uppercase)
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
    }

    private var value: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(pctText)
                .font(.system(.caption, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
            if let resetText {
                Text("· \(resetText)")
                    .font(.system(.caption2, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    // Truncating this to a bare "·" helps nobody: drop it whole.
                    .layoutPriority(narrow ? 0 : -1)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if narrow {
                // Each half of a phone screen fits the label OR the value, not
                // both, so give each its own line.
                label
                value
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    label
                    Spacer(minLength: 8)
                    value
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
