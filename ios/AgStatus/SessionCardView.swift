import SwiftUI

/// One agent session, readable at arm's length: big name, colored status,
/// last message, and how fresh it all is.
struct SessionCardView: View {
    let session: Session

    private var statusColor: Color { Theme.color(for: session.status) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(session.name)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                statusBadge
            }

            if !session.project.isEmpty && session.project != session.name {
                Text(session.project)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Theme.cardBorder))
            }

            if !session.message.isEmpty {
                Text(session.message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }

            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(Self.relativeTime(from: session.updatedDate, to: context.date))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.textSecondary.opacity(0.75))
            }
        }
        .padding(.leading, 18)
        .padding([.top, .bottom, .trailing], 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    session.status == .blocked
                        ? statusColor.opacity(0.45)
                        : Theme.cardBorder
                )
        )
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(
                topLeadingRadius: 16,
                bottomLeadingRadius: 16,
                style: .continuous
            )
            .fill(statusColor)
            .frame(width: 4)
        }
        .shadow(
            color: session.status == .blocked ? statusColor.opacity(0.4) : .clear,
            radius: 12
        )
        .opacity(session.status == .done ? 0.55 : 1)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Status badge

    @ViewBuilder
    private var statusBadge: some View {
        if session.status.isActive {
            badgeContent
                .phaseAnimator([1.0, 0.45]) { view, phase in
                    view.opacity(phase)
                } animation: { _ in
                    .easeInOut(duration: 1.1)
                }
        } else {
            badgeContent
        }
    }

    private var badgeContent: some View {
        Text(session.status.label)
            .font(.system(.caption, design: .rounded).weight(.semibold))
            .foregroundStyle(statusColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(statusColor.opacity(0.16)))
            .overlay(Capsule().strokeBorder(statusColor.opacity(0.35)))
    }

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
