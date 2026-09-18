import SwiftUI

/// One agent session, readable at arm's length: big name, colored status,
/// last message, and how fresh it all is. A session that reports where it
/// runs also gets a footer with the "Bring to front" control.
struct SessionCardView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.openSession) private var openSession
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
            // Content on the left, a rail on the right carrying the status and
            // the card's one control.
            //
            // The rail is the SHORTER column — badge plus a 44pt button is
            // ~66pt against ~94pt of name, message and metadata — so it never
            // sets the card's height. What it buys is the meta line, which used
            // to stand 44pt tall for no reason except that the button sat in
            // it; with the button gone that row collapses to its ~18pt of text.
            // Roughly 26pt off every card, a fifth of its height.
            //
            // The rail sits OUTSIDE the content's tap gesture on purpose. The
            // gesture covers the column it belongs to and nothing else, so it
            // cannot reach across and swallow the button's tap the way the old
            // full-card NavigationLink overlay did.
            HStack(alignment: .top, spacing: Theme.Space.sm) {
                content(now: now)
                rail
            }

            // The outcome line: "Brought to front", or why the control is
            // disabled. Full width underneath rather than in the rail, because
            // it is prose — it changes length and would either squeeze the rail
            // or wrap to four words a line inside it. It takes no height when
            // there is nothing to say.
            FocusStatusLine(session: session, host: session.host, now: now)
        }
        .padding(.horizontal, Theme.Space.sm)
        .padding(.vertical, Theme.Space.xs)
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

    /// Name, message and metadata — everything the card says, and the only part
    /// the whole-card tap belongs to.
    private func content(now: Date) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            // The name owns the top line by itself now. It used to share the
            // row with the status badge, pushing it right with a layout
            // priority so a long name would not be the thing that truncates —
            // the name is how you know WHICH card this is. With the badge in
            // the rail that contest is gone: the name simply gets the width.
            Text(session.name)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)

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
                HStack(spacing: 3) {
                    Image(systemName: Theme.agentSymbol(for: session.source))
                        .font(.system(size: 8, weight: .bold))
                    Text(session.source.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .kerning(0.4)
                }
                .foregroundStyle(Theme.textTertiary)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.cardBorder)
                )
                // Never truncates. It is one short word in a box, and with the
                // rail taking width off this line SwiftUI began shrinking the
                // leftmost item first — the badge came out as "CLA…" inside a
                // border, which reads as a bug. A fixed token should hold its
                // size and let the variable-length text beside it give way.
                .fixedSize()
                // The two optional facts — machine and directory — as ONE
                // cascade rather than two independent decisions.
                //
                // They were separate: the machine pinned with `.fixedSize()`
                // and the directory wrapped in its own ViewThatFits. Neither
                // could see the other, and between them, the badge and the
                // timestamp, every item on the row had become unshrinkable. A
                // row that cannot shrink does not truncate — it overflows, and
                // the card went past the edge of the screen.
                //
                // One cascade always has a fitting option, and its order is the
                // priority, stated once: the directory is expendable (it only
                // appears when a session moved, and the name still tells you
                // which card this is), the machine is not (two sessions of the
                // same project on two machines are otherwise identical here).
                ViewThatFits(in: .horizontal) {
                    metaFacts(includeProject: true)
                    metaFacts(includeProject: false)
                    EmptyView()
                }
                Text("·").foregroundStyle(Theme.hairlineStrong)
                Text(Self.relativeTime(from: session.updatedDate, to: now))
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    // "just now" / "12m ago" — short, and a truncated time is
                    // worse than no time. It holds its width like the badge.
                    .fixedSize()
                // What this session has spent, and ONLY when the board has a
                // figure for it. An absent total means unknown — reporting off,
                // an agent that doesn't report, or nothing heard yet — so there
                // is no number, no dash and no placeholder, and a card without
                // one looks exactly as it did before this line existed.
                //
                // It rides the meta line instead of taking a row of its own.
                // The cards have been shortened twice on the owner's ask, and a
                // figure that is read on the lean-in has not earned 18pt off
                // the height of every card on the board.
                //
                // Tertiary, like the rest of this line. Colour here means
                // state; a token count is not one, and tinting it would put a
                // second loud element on a card whose whole job is to have
                // exactly one.
                if let tokensLabel = session.tokensLabel {
                    Text("·").foregroundStyle(Theme.hairlineStrong)
                    Text(tokensLabel)
                        // Tabular figures: this ticks in place as the hook
                        // reports, and proportional digits would make the whole
                        // line twitch sideways each time.
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                        // Last on the line, after the time. A total first
                        // arrives on the hook's 15-minute throttle — minutes
                        // after the card itself — and appending it leaves
                        // everything already on the line where the eye left it.
                        //
                        // Fixed width for the badge's reason: "1.2…" reads as a
                        // bug. When the line is tight it is the project label,
                        // marked above as the one to give way, that yields.
                        .fixedSize()
                        // Combined into the card's one accessibility element,
                        // where a bare "1.4M" would be read as a quantity of
                        // nothing in particular.
                        .accessibilityLabel("\(tokensLabel) tokens")
                }
                Spacer(minLength: 0)
            }
            .font(.caption)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The tap covers this column and nothing else. It used to sit on a
        // subtree that spanned the full card, which is how it ended up
        // swallowing taps meant for the control. Opening history is the
        // harmless thing to do with a card; raising a window on another
        // machine is not, so only the harmless one is a whole-column gesture.
        .contentShape(Rectangle())
        .onTapGesture { openSession(session.id) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens this session's history")
        .accessibilityActions {
            if let host = session.host, store.isMachineOnline(host.machine.id) {
                Button("Bring to front on \(store.machineLabel(for: host))") {
                    send(.focus)
                }
            }
        }
    }

    /// The optional middle of the meta line: the machine this session runs on,
    /// and the working directory when it has diverged from the card's name.
    ///
    /// `includeProject` is the lever the caller's cascade pulls. The directory
    /// only appears when a session has moved — the name is pinned at the
    /// session's first event while `project` follows the live directory, so the
    /// two are identical for a session that stayed put and differ precisely
    /// when one moved. That is also where a moved session's tokens are being
    /// attributed, which is the reason it is worth any width at all.
    ///
    /// `.fixedSize()` here is what lets ViewThatFits measure a candidate at its
    /// full width; it binds this row only, not the line it sits in.
    @ViewBuilder
    private func metaFacts(includeProject: Bool) -> some View {
        HStack(spacing: Theme.Space.xxs) {
            if let host = session.host {
                Text("·").foregroundStyle(Theme.hairlineStrong)
                Text(store.machineLabel(for: host))
                    .lineLimit(1)
                    .foregroundStyle(Theme.textTertiary)
            }
            if includeProject && !session.project.isEmpty && session.project != session.name {
                Text("·").foregroundStyle(Theme.hairlineStrong)
                Text("in \(session.project)")
                    .lineLimit(1)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .fixedSize()
    }

    /// The right rail: what state this session is in, and the one thing you
    /// can do about it.
    ///
    /// Status on top because it is what you read; the control beneath it
    /// because it is what you do about what you read. Both trailing-aligned, so
    /// the rail keeps a clean edge whatever the length of the status word.
    private var rail: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.xs) {
            HStack(spacing: 3) {
                Image(systemName: Theme.symbol(for: session.status))
                    .font(.caption2.weight(.semibold))
                Text(session.status.label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .kerning(0.5)
            }
            .foregroundStyle(statusColor)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(session.status.label)

            if session.host != nil {
                FocusControl(session: session)
            }
        }
        // The rail takes exactly the width it needs and hands the rest to the
        // content column. Letting it flex would take width from the name and
        // the message, which are the two things the card exists to show.
        //
        // The priority is not decoration. The content column carries
        // `maxWidth: .infinity`, and an HStack serves that greedily — it
        // offered the rail what was left, which was too little for the word
        // "Focus", and the button came out as a bare glyph. Sizing the rail
        // first and giving the remainder to the content is the correct order
        // here anyway: the rail's width is fixed by its longest status word,
        // while the content is the part that should absorb whatever is left.
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
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

// MARK: - Focus

/// The card's one control, living in the rail beneath the status badge.
///
/// Split out of the old FocusRow, a full-width footer behind a divider: cards
/// WITH a control stood visibly taller than cards without one, which made the
/// board look ragged. In the rail it costs no height at all, because the rail
/// is the shorter of the card's two columns and the content sets the height.
///
/// "Focus" rather than "Bring to front". The long label is the better sentence
/// but it is ~155pt wide, and in a rail that width comes straight out of the
/// name and the message — the two things you actually read. The verb alone
/// carries it, and the full phrasing survives in the accessibility label and
/// the context menu, where width is free.
private struct FocusControl: View {
    @Environment(SessionStore.self) private var store
    let session: Session

    private var host: Host? { session.host }
    private var online: Bool { host.map { store.isMachineOnline($0.machine.id) } ?? false }
    private var state: SessionStore.FocusState? { store.focus[session.id] }

    var body: some View {
        // Stacked, not side by side. The rail is one button wide; Resume
        // sitting next to Focus would double that width and take it from the
        // name. Resume is also the rare one — it is only offered once a
        // session has ended — so it goes above, out of the thumb's path.
        VStack(alignment: .trailing, spacing: Theme.Space.xxs) {
            // Both spelled out as an icon beside a Text rather than as a
            // `Label`. In a rail sized by its own content, SwiftUI resolved the
            // Label to its icon alone and the word silently vanished — the
            // button rendered as an unlabelled glyph. An HStack cannot be
            // re-styled away by the environment.
            if state?.resumeOffered == true {
                Button { send(.resume) } label: {
                    HStack(spacing: Theme.Space.xxs) {
                        Image(systemName: "play.circle.fill")
                        Text("Resume")
                    }
                }
                .buttonStyle(FocusButtonStyle())
                .disabled(!online)
            }
            Button { send(.focus) } label: {
                HStack(spacing: Theme.Space.xxs) {
                    Image(systemName: "macwindow.on.rectangle")
                    Text("Focus")
                }
            }
            .buttonStyle(FocusButtonStyle())
            .disabled(!online)
            .accessibilityLabel(
                online && host != nil
                    ? "Bring to front on \(store.machineLabel(for: host!))"
                    : "Bring to front"
            )
        }
        .fixedSize()
    }

    private func send(_ type: CommandType) {
        Task { await store.sendCommand(type, for: session) }
    }
}

/// What the last tap came back with, or why the control is disabled.
///
/// Its own line because it is prose, it changes length, and it is the one part
/// of the card a screen reader should announce as it updates.
private struct FocusStatusLine: View {
    @Environment(SessionStore.self) private var store
    let session: Session
    let host: Host?
    let now: Date

    private var name: String { host.map { store.machineLabel(for: $0) } ?? "" }
    private var online: Bool { host.map { store.isMachineOnline($0.machine.id) } ?? false }
    private var state: SessionStore.FocusState? { store.focus[session.id] }

    /// Why the control is disabled. A machine the board has never seen gets the
    /// hint about the listener; one it has seen says when it left.
    private var offlineNote: String? {
        guard let host, !online else { return nil }
        guard let machine = store.machines[host.machine.id] else {
            return "\(name) is offline — needs the AgStatus listener on that machine"
        }
        guard let lastSeen = machine.lastSeenDate else { return "\(name) is offline" }
        return "\(name) is offline (\(SessionCardView.relativeTime(from: lastSeen, to: now)))"
    }

    /// How long this session waited, once it has stopped waiting.
    private var beat: SessionStore.WaitBeat? { store.beats[session.id] }

    var body: some View {
        Group {
            if let state {
                Text(state.text).foregroundStyle(color(for: state.kind))
                    .accessibilityAddTraits(.updatesFrequently)
            } else if let offlineNote {
                Text(offlineNote).foregroundStyle(Theme.textTertiary)
            } else if let beat {
                // Last in the order on purpose. A tap you are waiting on and a
                // machine that has gone offline are both things you might act
                // on; this is a fact about something already over, so it yields
                // to either. It is also the quietest thing this line can say —
                // tertiary, caption, no colour of its own. With beats lasting
                // until a card next changes, and `done` being the commonest
                // state, anything louder would be permanent furniture.
                Text(beatLabel(beat)).foregroundStyle(Theme.textTertiary)
            }
        }
        .font(.caption)
        .padding(.top, Theme.Space.xxs)
        .animation(.snappy, value: state)
        .animation(.snappy, value: beat)
        .accessibilityElement(children: .combine)
    }

    /// `blocked` was waiting on a decision; `done` was not waiting at all — it
    /// finished and sat there. "Waited" would be wrong for the second, and the
    /// card's own status has already moved on by the time this appears, so the
    /// sentence has to carry its own context.
    private func beatLabel(_ beat: SessionStore.WaitBeat) -> String {
        switch beat.from {
        case .blocked: "Waited \(duration(beat.waited))"
        default: "Unseen for \(duration(beat.waited))"
        }
    }

    /// "2h 14m", "18m". Coarse on purpose: a wait reported to the second reads
    /// as precision nobody asked for, and this is a closing note, not a metric.
    private func duration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        if hours >= 1 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(1, minutes))m"
    }

    private func color(for kind: SessionStore.FocusState.Kind) -> Color {
        switch kind {
        case .pending: Theme.textSecondary
        case .ok: Theme.color(for: .done)
        case .fail: Theme.color(for: .blocked)
        }
    }
}

/// It used to be bare text with an icon and no surface, which read as a label
/// someone had forgotten to style rather than something to press. Now that
/// Details has moved to the card tap, a card carries this one control — two
/// only in the moment a resume is on offer — so it can afford a real
/// affordance: its own raised surface, a hairline, and a tinted glyph.
///
/// Still neutral rather than accented. A control is not a state, and the accent
/// on this board means "ready for you" — spending it on a button that is
/// present on every card would make the one colour that matters ordinary.
///
/// 44pt because it is tapped one-handed, often while walking away from the
/// desk, and because the action reaches across to another machine and moves a
/// window: a mis-tap is not free.
private struct FocusButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(isEnabled ? Theme.textPrimary : Theme.textTertiary)
            // 12 rather than 16: every point of the rail's width is a point
            // taken off the name and the message beside it. The 44pt height is
            // what makes this a comfortable target, not the side padding.
            .padding(.horizontal, Theme.Space.sm)
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(configuration.isPressed ? Theme.cardBorder : Theme.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// How a card asks the board to open a session's detail.
///
/// A closure rather than a NavigationLink: a link inside a List draws its own
/// disclosure chevron and tints with the app accent, and it has to cover the
/// whole row — which is how it ended up swallowing taps meant for the control.
private struct OpenSessionKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}

extension EnvironmentValues {
    var openSession: (String) -> Void {
        get { self[OpenSessionKey.self] }
        set { self[OpenSessionKey.self] = newValue }
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
