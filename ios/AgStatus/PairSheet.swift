import SwiftUI
import UIKit

/// Shows a fresh pairing code, its countdown, and the one command to run.
struct PairSheet: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Phase {
        case loading
        case ready(PairCode, expiresAt: Date)
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    loadingView
                case .ready(let code, let expiresAt):
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        codeContent(code: code, expiresAt: expiresAt, now: context.date)
                    }
                case .failed(let message):
                    failedView(message)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Pair your computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .task { await fetchCode() }
    }

    // MARK: - Phases

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Getting a fresh code…")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    @ViewBuilder
    private func codeContent(code: PairCode, expiresAt: Date, now: Date) -> some View {
        let remaining = Int(expiresAt.timeIntervalSince(now).rounded(.down))
        if remaining > 0 {
            activeCodeView(code: code, remaining: remaining)
        } else {
            expiredView
        }
    }

    private func activeCodeView(code: PairCode, remaining: Int) -> some View {
        ScrollView {
            VStack(spacing: 22) {
                Text(code.code)
                    .font(.system(size: 52, weight: .bold, design: .monospaced))
                    .kerning(2)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                    .padding(.top, 20)
                    .accessibilityLabel("Pairing code \(code.code)")

                Label("Expires in \(Self.timeString(remaining))", systemImage: "clock")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(
                        remaining < 60 ? Theme.color(for: .testing) : Theme.textSecondary
                    )

                if let board = store.board {
                    let command = code.command(for: board)

                    Text(command)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Theme.card)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Theme.cardBorder)
                        )

                    Button {
                        copyCommand(command)
                    } label: {
                        Label(
                            copied ? "Copied" : "Copy command",
                            systemImage: copied ? "checkmark" : "doc.on.doc"
                        )
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(copied ? Theme.color(for: .done) : Theme.color(for: .planning))
                }

                Text("Run this in your terminal — it wires Claude Code hooks to this board.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private var expiredView: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.xmark")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
            Text("Code expired")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Codes only live for a few minutes. Grab a new one.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                Task { await fetchCode(forceNew: true) }
            } label: {
                Label("New code", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.color(for: .planning))
        }
        .padding(32)
    }

    private func failedView(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundStyle(Theme.color(for: .testing))
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                Task { await fetchCode() }
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.color(for: .planning))
        }
        .padding(32)
    }

    // MARK: - Actions

    @MainActor
    private func fetchCode(forceNew: Bool = false) async {
        phase = .loading
        copied = false
        do {
            let code = try await store.pairCode(forceNew: forceNew)
            phase = .ready(
                code,
                expiresAt: Date().addingTimeInterval(TimeInterval(code.expiresInSeconds))
            )
        } catch APIError.rateLimited {
            phase = .failed("A few codes are already out for this board. Wait a minute for one to expire, then try again.")
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func copyCommand(_ command: String) {
        UIPasteboard.general.string = command
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation { copied = true }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation { copied = false }
        }
    }

    private static func timeString(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
