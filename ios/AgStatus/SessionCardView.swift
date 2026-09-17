import SwiftUI

/// One agent session, readable at arm's length: big name, colored status,
/// last message, and how fresh it all is. A session that reports where it
/// runs also gets a footer with the "Bring to front" control.
struct SessionCardView: View {
    @Environment(SessionStore.self) private var store
    let session: Session

    /// An active card gone quiet for this long is probably a dead agent
    /// (killed mid-turn, crashed machine) — stop pulsing and dim it.
    static let staleAfter: TimeInterval = 10 * 60

    private var statusColor: Color { Theme.color(for: session.status) }

    var body: some View {
        // One shared clock: refreshes the relative timestamp and re-evaluates
        // staleness every 30 s.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let host = session.host {
                // The focus control is explicit — the card tap stays history —
                // so it is also offered where a long press looks for it.
                card(now: context.date)
                    .contextMenu { focusMenuItem(host) }
            } else {
                card(now: context.date)
            }
        }
    }

    private func card(now: Date) -> some View {
        let stale = session.status.isActive
            && now.timeIntervalSince(session.updatedDate) > Self.staleAfter
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                // Name first and largest: it is how you know WHICH session this
                // is, and the status only matters once you have found the right
                // card. These used to share a line and compete for width, so
                // the name was what truncated — exactly backwards.
                Text(session.name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)

                HStack(spacing: Theme.Space.xxs) {
                    Image(systemName: Theme.symbol(for: session.status))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor)
                    Text(session.status.label.uppercased())
                        .font(.caption2.weight(.semibold))
                        .kerning(0.5)
                        .foregroundStyle(statusColor)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(session.status.label)


                if !session.message.isEmpty {
                    Text(session.message)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }

                // Agent, machine, when — three different facts. The machine is
                // the one the card never showed; it was buried in the Focus
                // control's label, so two sessions of the same project on two
                // machines were indistinguishable at a glance.
                HStack(spacing: Theme.Space.xxs) {
                    Text(session.source.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .kerning(0.4)
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.cardBorder)
                        )
                    if let host = session.host {
                        Text("·").foregroundStyle(Theme.hairlineStrong)
                        Text(store.machineLabel(for: host))
                            .lineLimit(1)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    // The working directory, but ONLY when it has diverged from
                    // the card's name. The name is pinned at the session's first
                    // event while `project` follows the live directory, so these
                    // two are identical for a session that stayed put and differ
                    // precisely when one moved — which is the only time the
                    // second label is worth the width. This is also where a
                    // moved session's tokens are being attributed.
                    if !session.project.isEmpty && session.project != session.name {
                        Text("·").foregroundStyle(Theme.hairlineStrong)
                        Text("in \(session.project)")
                            .lineLimit(1)
                            .foregroundStyle(Theme.textTertiary)
                    }
                    Text("·").foregroundStyle(Theme.hairlineStrong)
                    Text(Self.relativeTime(from: session.updatedDate, to: now))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                }
                .font(.caption)
            }
            .accessibilityElement(children: .combine)
            .accessibilityActions {
                if let host = session.host, store.isMachineOnline(host.machine.id) {
                    Button("Bring to front on \(store.machineLabel(for: host))") {
                        send(.focus)
                    }
                }
            }

            // Both actions, always present and always explicit: Details opens
            // this session's history, Focus raises its window on the machine
            // running it. Divided from the body by a hairline so the card reads
            // as content-then-controls rather than one undifferentiated block.
            Divider()
                .overlay(Theme.cardBorder)
                .padding(.top, Theme.Space.sm)
                .padding(.bottom, Theme.Space.xxs)

            FocusRow(session: session, host: session.host, now: now)
        }
        .padding(Theme.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The whole surface carries the state, so the board can be sorted by
        // colour before a word is read. This replaces a 4pt coloured stripe
        // down the leading edge: that pattern is the most overused device in
        // dashboard UI and never reads as intentional, whatever colour or
        // corner radius it is given. A large tinted area also reads from much
        // further away than a 4pt sliver.
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.cardSurface(for: session.status))
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .strokeBorder(Theme.cardEdge(for: session.status))
        )
        // No glow. A lit halo is the trading-terminal tell, and it is exactly
        // wrong in a dark room at 1am — which is when this board is read.
        //
        // Only staleness dims a card now. `done` used to be dimmed too, from
        // when it meant "finished, nothing to see". It now means the agent
        // handed back and is waiting on YOU, so dimming it hid the one state
        // the board most needs to surface.
        .opacity(stale ? 0.62 : 1)
    }

    // MARK: - Focus

    @ViewBuilder
    private func focusMenuItem(_ host: Host) -> some View {
        Button {
            send(.focus)
        } label: {
            Label("Bring to front on \(store.machineLabel(for: host))",
                  systemImage: "macwindow.on.rectangle")
        }
        .disabled(!store.isMachineOnline(host.machine.id))
    }

    private func send(_ type: CommandType) {
        Task { await store.sendCommand(type, for: session) }
    }

    // MARK: - Status badge

    @ViewBuilder
    // The pulsing badge that used to live here is gone. It looped forever on
    // every active card, which is ambient animation: it reported nothing, it
    // never stopped, and on a board left open all day it cost battery to say
    // the same thing continuously. Motion on this board now means something
    // changed. The state is carried by the icon, the word and the card's own
    // tint instead.

    // MARK: - Time

    static func relativeTime(from date: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<45:
            return "just now"
        case ..<3600:
            return "\(max(1, seconds / 60))m ago"
        case ..<86_400:
            return "\(seconds / 3600)h ago"
        default:
            return "\(seconds / 86_400)d ago"
        }
    }
}

// MARK: - FocusRow

/// The footer of a card that reports where it runs: the explicit "Bring to
/// front" control, why it is off (visible — a touch screen has no tooltip),
/// and what the last tap came back with. Never the card's own tap, which
/// stays history (docs/design/focus-protocol.md §7).
private struct FocusRow: View {
    @Environment(SessionStore.self) private var store
    let session: Session
    /// Optional: a session whose machine never opted into Focus still gets a
    /// Details button, so every card has the same controls in the same place.
    let host: Host?
    let now: Date

    private var name: String { host.map { store.machineLabel(for: $0) } ?? "" }
    private var online: Bool { host.map { store.isMachineOnline($0.machine.id) } ?? false }
    private var state: SessionStore.FocusState? { store.focus[session.id] }

    /// Why the control is disabled. A machine the board has never seen gets
    /// the hint about the listener; one it has seen says when it left.
    private var offlineNote: String? {
        guard let host else { return nil }
        guard !online else { return nil }
        guard let machine = store.machines[host.machine.id] else {
            return "\(name) is offline — needs the AgStatus listener on that machine"
        }
        guard let lastSeen = machine.lastSeenDate else { return "\(name) is offline" }
        return "\(name) is offline (\(SessionCardView.relativeTime(from: lastSeen, to: now)))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Side by side when the labels fit, stacked when a long machine
            // name plus "Resume" would overflow a phone-width card.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }

            if let state {
                Text(state.text)
                    .font(.caption)
                    .foregroundStyle(color(for: state.kind))
                    .accessibilityAddTraits(.updatesFrequently)
            } else if let offlineNote {
                Text(offlineNote)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .animation(.snappy, value: state)
        // What the web board's live region does: say each change out loud.
        .onChange(of: state?.text) { _, text in
            if let text, !text.isEmpty {
                AccessibilityNotification.Announcement(text).post()
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        NavigationLink(value: session.id) {
            Label("Details", systemImage: "eye")
        }
        .buttonStyle(FocusButtonStyle())

        if host != nil {
            // Just "Focus": the machine's name now sits in the card's meta
            // line, so repeating it here was the same word twice on one card —
            // and it made the label too long to fit beside Details.
            Button {
                send(.focus)
            } label: {
                Label("Focus", systemImage: "dot.viewfinder")
            }
            .buttonStyle(FocusButtonStyle())
            .disabled(!online)
            .accessibilityLabel(online ? "Bring to front on \(name)" : "Focus")
            .accessibilityHint(offlineNote ?? "")
        }

        // Only after the listener answered "not running".
        if state?.resumeOffered == true {
            Button {
                send(.resume)
            } label: {
                Label("Resume", systemImage: "play.fill")
            }
            .buttonStyle(FocusButtonStyle())
            .disabled(!online)
        }
    }

    private func send(_ type: CommandType) {
        Task { await store.sendCommand(type, for: session) }
    }

    private func color(for kind: SessionStore.FocusState.Kind) -> Color {
        switch kind {
        case .pending: Theme.textSecondary
        case .ok: Theme.color(for: .done)
        case .fail: Theme.color(for: .blocked)
        }
    }
}

/// A small capsule in the card's own idiom; greyed, not hidden, when the
/// machine is offline so the reason underneath still makes sense.
/// A card control.
///
/// Deliberately neutral. These used to be drawn in `planning` blue — a STATE
/// colour on a control — which put a second, unrelated meaning into the one
/// channel this board reserves for "what is this session doing". A control is
/// not a state, so it takes text colours and earns its emphasis from the
/// surface it sits on.
///
/// 44pt minimum height because these are tapped one-handed, often while
/// walking away from the desk — Apple's minimum target, and the same floor the
/// web board uses on a phone.
private struct FocusButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
            .foregroundStyle(isEnabled ? Theme.textSecondary : Theme.textTertiary)
            .padding(.horizontal, Theme.Space.sm)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(configuration.isPressed ? Theme.raised : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .opacity(isEnabled ? 1 : 0.55)
    }
}

// MARK: - SessionHistoryView

/// The timeline of one agent session: every status/message transition with
/// its timestamp, newest first, in the board's color scheme.
struct SessionHistoryView: View {
    @Environment(SessionStore.self) private var store
    let sessionId: String

    @State private var events: [HistoryEvent] = []
    @State private var loaded = false

    /// The live session, if it is still on the board.
    private var session: Session? {
        store.sessions.first { $0.id == sessionId }
    }

    var body: some View {
        Group {
            if events.isEmpty && loaded {
                emptyState
            } else {
                timeline
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(session?.name ?? sessionId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
        // Live: any update to this session (new SSE event) refreshes the list.
        .onChange(of: session?.updatedAt) {
            Task { await load() }
        }
        .refreshable { await load() }
    }

    private func load() async {
        if store.isDemo {
            if let session {
                events = DemoData.history(for: session)
            }
            loaded = true
            return
        }
        guard let board = store.board else {
            loaded = true
            return
        }
        if let fetched = try? await AgStatusAPI.history(of: sessionId, for: board) {
            events = fetched
        }
        loaded = true
    }

    // MARK: Timeline

    private var timeline: some View {
        List {
            if let session {
                headerRow(session)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16))
            }
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                HistoryRow(
                    event: event,
                    isFirst: index == 0,
                    isLast: index == events.count - 1
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .animation(.snappy, value: events)
    }

    private func headerRow(_ session: Session) -> some View {
        HStack(spacing: 10) {
            if !session.project.isEmpty {
                Text(session.project)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Theme.cardBorder))
            }
            Spacer()
            Text(session.status.label)
                .font(.system(.caption, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.color(for: session.status))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(Theme.color(for: session.status).opacity(0.16)))
                .overlay(Capsule().strokeBorder(Theme.color(for: session.status).opacity(0.35)))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
            Text("No history yet")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Events appear here as the agent works.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(32)
    }
}

// MARK: - HistoryRow

private struct HistoryRow: View {
    let event: HistoryEvent
    let isFirst: Bool
    let isLast: Bool

    private var color: Color { Theme.color(for: event.status) }

    /// "18:42" for today, "Jul 26, 18:42" otherwise.
    private var timeText: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(event.date) {
            return event.date.formatted(date: .omitted, time: .shortened)
        }
        return event.date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Timeline gutter: colored dot on a continuous line.
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : Theme.cardBorder)
                    .frame(width: 2, height: 10)
                Circle()
                    .fill(color)
                    .frame(width: 9, height: 9)
                    .shadow(color: color.opacity(isFirst ? 0.6 : 0), radius: 3)
                Rectangle()
                    .fill(isLast ? Color.clear : Theme.cardBorder)
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 12)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(event.status.label)
                        .font(.system(.subheadline, design: .rounded).weight(.semibold))
                        .foregroundStyle(color)
                    Spacer(minLength: 8)
                    Text(timeText)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.textSecondary)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(SessionCardView.relativeTime(from: event.date, to: context.date))
                            .font(.caption2)
                            .foregroundStyle(Theme.textSecondary.opacity(0.6))
                    }
                }
                if !event.message.isEmpty {
                    Text(event.message)
                        .font(.subheadline)
                        .foregroundStyle(isFirst ? Theme.textPrimary : Theme.textSecondary)
                        .lineLimit(3)
                }
            }
            .padding(.vertical, 10)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(event.status.label), \(event.message), \(timeText)")
    }
}
