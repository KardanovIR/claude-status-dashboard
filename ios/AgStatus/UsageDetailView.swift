//
//  UsageDetailView.swift
//  AgStatus
//
//  One agent's last 30 days: the tokens it spent each day (bars) with the
//  plan-limit readings recorded over them (lines), and where those tokens
//  went. Two different units share one time axis on purpose — the bars come
//  from the agent's own local logs, the lines are the account-wide plan limit
//  the board has been watching — so the screen says so at the bottom.
//
//  The chart is drawn by hand in a Canvas: the Charts framework would raise
//  the deployment target for one screen.
//

import SwiftUI

// MARK: - Route

/// Navigation value for this screen. Its own type keeps the destination
/// distinct from the board's plain-String session-id destination.
struct UsageDetailRoute: Hashable {
    let source: String
}

// MARK: - Screen

struct UsageDetailView: View {
    @Environment(SessionStore.self) private var store
    let source: String

    @State private var detail = UsageDetailData(history: .empty, source: "")
    @State private var loaded = false

    private var name: String {
        UsageInfo.displayName(for: source)
    }

    var body: some View {
        Group {
            if loaded {
                content
            } else {
                loadingState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("\(name) · last \(detail.days.count) days")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                tokensCard
                projectsCard
                note
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { await load() }
    }

    private var loadingState: some View {
        ProgressView()
            .controlSize(.large)
            .tint(Theme.textSecondary)
    }

    /// Demo mode never touches the network. A real board may be talking to a
    /// server old enough to have no history endpoint at all: that 404 (like any
    /// other failure) leaves an empty screen rather than an error.
    private func load() async {
        if store.isDemo {
            detail = UsageDetailData(history: DemoData.usageHistory(), source: source)
            loaded = true
            return
        }
        guard let board = store.board else {
            loaded = true
            return
        }
        let fetched = (try? await AgStatusAPI.usageHistory(days: UsageHistory.defaultDays,
                                                           for: board)) ?? .empty
        detail = UsageDetailData(history: fetched, source: source)
        loaded = true
    }

    // MARK: Tokens per day

    private var tokensCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    tokensHeader
                    Spacer(minLength: 10)
                    legend
                }
                VStack(alignment: .leading, spacing: 6) {
                    tokensHeader
                    legend
                }
            }
            UsageChart(detail: detail, name: name)
        }
        .usageCard()
    }

    private var tokensHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text("Tokens per day")
                .font(.system(.caption2, design: .rounded).weight(.bold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textSecondary)
            Text(" · \(UsageDetailData.fmtTokens(detail.totalTokens)) total")
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(Theme.textTertiary)
        }
        .lineLimit(1)
    }

    @ViewBuilder
    private var legend: some View {
        if detail.series.isEmpty {
            Text("limit history starts once reported")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
        } else {
            HStack(spacing: 12) {
                ForEach(detail.series) { series in
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .fill(Theme.seriesColor(series.colorIndex))
                            .frame(width: 10, height: 2)
                        Text(series.windowId)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    // MARK: Where the tokens went

    private var projectsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Where the tokens went")
                .font(.system(.caption2, design: .rounded).weight(.bold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textSecondary)

            if detail.projects.isEmpty {
                Text("No per-project token data reported yet.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(detail.projects) { project in
                    projectRow(project)
                }
            }
        }
        .usageCard()
    }

    private func projectRow(_ project: UsageDetailData.Project) -> some View {
        let share = detail.topProjectTokens > 0 ? project.tokens / detail.topProjectTokens : 0
        let percent = detail.totalTokens > 0
            ? Int((project.tokens / detail.totalTokens * 100).rounded())
            : 0
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(project.name)
                    .font(.system(.subheadline, design: .rounded))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(UsageDetailData.fmtTokens(project.tokens))
                        .font(.system(.caption, design: .rounded).weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textPrimary)
                    Text("\(percent)%")
                        .font(.system(.caption, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textTertiary)
                }
                .fixedSize()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.06))
                    Capsule()
                        .fill(
                            LinearGradient(colors: [Theme.color(for: .planning), Theme.accentLight],
                                           startPoint: .leading,
                                           endPoint: .trailing)
                        )
                        // A hairline keeps the smallest project visible.
                        .frame(width: share > 0 ? max(geo.size.width * share, 4) : 0)
                }
            }
            .frame(height: 6)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(project.name): \(UsageDetailData.fmtTokens(project.tokens)) tokens, \(percent) percent"
        )
    }

    // MARK: Note

    private var note: some View {
        Text("Bars are tokens your agent spent, read from its own local logs. "
             + "Lines are the account-wide plan limit, recorded from when this board "
             + "first saw it. They track each other but are not the same measure.")
            .font(.caption2)
            .foregroundStyle(Theme.textTertiary)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 2)
    }
}

// MARK: - Chart

/// Bars (tokens, left axis) with the limit lines over them (percent, right
/// axis). Everything is laid out from the plot rectangle, so it scales from an
/// iPhone SE to an iPad without a second set of numbers.
private struct UsageChart: View {
    let detail: UsageDetailData
    let name: String

    private let inset = (leading: 44.0, trailing: 40.0, top: 14.0, bottom: 26.0)
    private static let gridPercents = [0, 25, 50, 75, 100]

    var body: some View {
        Canvas { context, size in
            draw(&context, size: size)
        }
        .frame(height: 190)
        .accessibilityElement()
        .accessibilityLabel(
            "\(name) tokens per day and plan limit over the last \(detail.days.count) days. "
            + "\(UsageDetailData.fmtTokens(detail.totalTokens)) tokens in total, "
            + "busiest day \(UsageDetailData.fmtTokens(detail.maxTokens))."
        )
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize) {
        let plotWidth = size.width - inset.leading - inset.trailing
        let plotHeight = size.height - inset.top - inset.bottom
        let count = detail.days.count
        guard plotWidth > 1, plotHeight > 1, count > 0 else { return }

        let bottom = inset.top + plotHeight
        func x(_ index: Int) -> CGFloat {
            count == 1
                ? inset.leading + plotWidth / 2
                : inset.leading + plotWidth * CGFloat(index) / CGFloat(count - 1)
        }
        func y(percent: Double) -> CGFloat {
            bottom - plotHeight * min(max(percent, 0), 100) / 100
        }

        // Grid and the right-hand percentage axis.
        for percent in Self.gridPercents {
            let lineY = y(percent: Double(percent))
            var line = Path()
            line.move(to: CGPoint(x: inset.leading, y: lineY))
            line.addLine(to: CGPoint(x: size.width - inset.trailing, y: lineY))
            context.stroke(line, with: .color(Theme.cardBorder), lineWidth: 1)
            context.draw(axisText("\(percent)%"),
                         at: CGPoint(x: size.width - inset.trailing + 6, y: lineY),
                         anchor: .leading)
        }

        // Left-hand token axis: the busiest day at the top, zero at the bottom.
        context.draw(axisText(UsageDetailData.fmtTokens(detail.maxTokens)),
                     at: CGPoint(x: inset.leading - 8, y: inset.top),
                     anchor: .trailing)
        context.draw(axisText("0"),
                     at: CGPoint(x: inset.leading - 8, y: bottom),
                     anchor: .trailing)

        // Bars: tokens for the day, scaled to the busiest one.
        let barWidth = max(2, (plotWidth / CGFloat(count)) * 0.62)
        let barColor = Theme.color(for: .done).opacity(0.5)
        for (index, tokens) in detail.tokensPerDay.enumerated() where tokens > 0 {
            let height = plotHeight * CGFloat(tokens / detail.maxTokens)
            let rect = CGRect(x: x(index) - barWidth / 2,
                              y: bottom - height,
                              width: barWidth,
                              height: max(height, 1))
            context.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(barColor))
        }

        // Lines: one per limit window, over the bars.
        for series in detail.series {
            let color = Theme.seriesColor(series.colorIndex)
            var path = Path()
            var drawn = 0
            var lastPoint = CGPoint.zero
            for (index, value) in series.values.enumerated() {
                guard let value else { continue }
                let point = CGPoint(x: x(index), y: y(percent: value))
                if drawn == 0 { path.move(to: point) } else { path.addLine(to: point) }
                drawn += 1
                lastPoint = point
            }
            if drawn == 1 {
                // A board that only just started recording has a single
                // reading, and a one-point path draws nothing: mark it.
                let dot = CGRect(x: lastPoint.x - 2.5, y: lastPoint.y - 2.5, width: 5, height: 5)
                context.fill(Path(ellipseIn: dot), with: .color(color))
            } else if drawn > 1 {
                context.stroke(path,
                               with: .color(color),
                               style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
            }
        }

        // Date ticks every seventh day, plus the last day when it has room.
        let last = count - 1
        for (index, day) in detail.days.enumerated()
        where index % 7 == 0 || (index == last && last % 7 > 2) {
            context.draw(axisText(UsageDetailData.dayLabel(day)),
                         at: CGPoint(x: x(index), y: size.height - 8),
                         anchor: .center)
        }
    }

    private func axisText(_ string: String) -> Text {
        Text(string)
            .font(.system(size: 9, design: .rounded))
            .foregroundStyle(Theme.textTertiary)
    }
}

// MARK: - Derived data

/// Everything the screen draws, worked out once per load: the day grid, the
/// tokens on each of those days, each limit window sampled onto the same grid,
/// and the per-project totals beside it.
struct UsageDetailData {

    struct Series: Identifiable {
        let windowId: String
        /// One value per day; nil for days before the series started.
        let values: [Double?]
        let colorIndex: Int

        var id: String { "\(colorIndex)/\(windowId)" }
    }

    struct Project: Identifiable {
        let name: String
        let tokens: Double

        var id: String { name }
    }

    /// UTC days, oldest first, "YYYY-MM-DD".
    let days: [String]
    let tokensPerDay: [Double]
    let series: [Series]
    let projects: [Project]
    /// Never zero, so bar heights are always divisible.
    let maxTokens: Double
    let totalTokens: Double
    let topProjectTokens: Double

    init(history: UsageHistory, source: String) {
        let days = UsageHistory.dayRange(history.days)
        var indexOfDay: [String: Int] = [:]
        for (index, day) in days.enumerated() { indexOfDay[day] = index }

        var tokensPerDay = [Double](repeating: 0, count: days.count)
        var totalsByProject: [String: Double] = [:]
        var projectOrder: [String] = []
        for row in history.projects where row.source == source {
            if let index = indexOfDay[row.day] { tokensPerDay[index] += row.tokens }
            if totalsByProject[row.project] == nil { projectOrder.append(row.project) }
            totalsByProject[row.project, default: 0] += row.tokens
        }

        let ranks = Dictionary(uniqueKeysWithValues: projectOrder.enumerated().map { ($1, $0) })
        let projects = totalsByProject
            .map { Project(name: $0.key, tokens: $0.value) }
            // Biggest spender first; first seen wins a tie, so the order is
            // stable across refreshes (Swift's sort is not).
            .sorted { ($0.tokens, ranks[$1.name] ?? 0) > ($1.tokens, ranks[$0.name] ?? 0) }

        self.days = days
        self.tokensPerDay = tokensPerDay
        self.series = history.history
            .filter { $0.source == source }
            .enumerated()
            .map { index, series in
                Series(windowId: series.windowId,
                       values: UsageHistory.sampleSeries(series.points, onto: days),
                       colorIndex: index)
            }
        self.projects = projects
        self.maxTokens = max(1, tokensPerDay.max() ?? 1)
        self.totalTokens = tokensPerDay.reduce(0, +)
        self.topProjectTokens = projects.first?.tokens ?? 0
    }

    /// "1.2B", "3.4M", "12K", "907" — the web dashboard's fmtTokens.
    static func fmtTokens(_ tokens: Double) -> String {
        guard tokens.isFinite else { return "0" }
        if tokens >= 1e9 { return String(format: "%.1fB", tokens / 1e9) }
        if tokens >= 1e6 { return String(format: "%.1fM", tokens / 1e6) }
        if tokens >= 1e3 { return "\(Int((tokens / 1e3).rounded()))K" }
        return "\(Int(tokens.rounded()))"
    }

    /// "9 Aug" — a UTC day in the reader's own short date order, mirroring the
    /// web's toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).
    static func dayLabel(_ day: String) -> String {
        let millis = UsageHistory.dayStartMillis(day)
        guard millis > 0 else { return day }
        return dayLabelFormatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    private static let dayLabelFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()
}

// MARK: - Card chrome

private extension View {
    /// The board's card treatment, so this screen matches the usage block it
    /// was opened from.
    func usageCard() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
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
