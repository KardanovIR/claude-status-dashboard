import SwiftUI
import UIKit

/// Board details, display options, demo mode, and the dangerous stuff.
struct SettingsView: View {
    @Environment(SessionStore.self) private var store
    @Environment(NotificationManager.self) private var notifications
    @Environment(\.dismiss) private var dismiss
    @AppStorage("keepAwake") private var keepAwake = false

    @State private var confirmDisconnect = false
    @State private var confirmDelete = false
    @State private var isDeleting = false
    @State private var deleteErrorText: String?
    @State private var showDeleteError = false
    @State private var copiedWebhook = false

    var body: some View {
        NavigationStack {
            Form {
                boardSection
                notificationsSection
                displaySection
                demoSection
                dangerSection
                aboutSection
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .tint(Theme.color(for: .planning))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Disconnect this device?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    store.disconnectBoard()
                    dismiss()
                }
            } message: {
                Text("The board stays on the server — you can reconnect anytime by scanning its QR code again.")
            }
            .confirmationDialog(
                "Delete this board for everyone?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete board", role: .destructive) {
                    deleteBoard()
                }
            } message: {
                Text("This removes the board and all its history from the server. There's no undo.")
            }
            .alert("Couldn't delete the board", isPresented: $showDeleteError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteErrorText ?? "Something went wrong. Please try again.")
            }
        }
        .presentationDragIndicator(.visible)
    }

    // MARK: - Sections

    @ViewBuilder
    private var boardSection: some View {
        if let board = store.board {
            Section("Board") {
                LabeledContent("Server", value: board.baseURL.host() ?? board.baseURL.absoluteString)

                Link(destination: board.boardURL) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Dashboard")
                                .foregroundStyle(Theme.textPrimary)
                            Text(board.boardURL.absoluteString)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .accessibilityLabel("Open dashboard in Safari")

                Button {
                    copyWebhook(board.webhookURL)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Webhook")
                                .foregroundStyle(Theme.textPrimary)
                            Text(board.webhookURL.absoluteString)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Image(systemName: copiedWebhook ? "checkmark" : "doc.on.doc")
                            .font(.caption)
                            .foregroundStyle(
                                copiedWebhook ? Theme.color(for: .done) : Theme.textSecondary
                            )
                    }
                }
                .accessibilityLabel("Copy webhook URL")
            }
            .listRowBackground(Theme.card)
        }
    }

    @ViewBuilder
    private var notificationsSection: some View {
        if let board = store.board, board.token != nil {
            Section {
                Toggle("When an agent is blocked", isOn: blockedToggle(for: board))
                    .disabled(!togglesEnabled || notifications.state == .requesting)
                Toggle("When an agent finishes", isOn: doneToggle(for: board))
                    .disabled(!togglesEnabled || notifications.state != .on)
                if notifications.state == .denied {
                    Button("Open Settings") { openNotificationSettings() }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text(notificationsFooter)
            }
            .listRowBackground(Theme.card)
            .task { await notifications.probeServerSupport(for: board) }
        }
    }

    private var displaySection: some View {
        Section {
            Toggle("Keep screen awake", isOn: $keepAwake)
        } header: {
            Text("Display")
        } footer: {
            Text("Handy when the board lives on a desk or shelf.")
        }
        .listRowBackground(Theme.card)
    }

    private var demoSection: some View {
        Section {
            if store.isDemo {
                Button("Stop demo") {
                    store.stopDemo()
                }
            } else {
                Button("Start demo") {
                    store.startDemo()
                    dismiss()
                }
            }
        } header: {
            Text("Demo")
        } footer: {
            Text("Fills the board with sample agents so you can see how it feels.")
        }
        .listRowBackground(Theme.card)
    }

    @ViewBuilder
    private var dangerSection: some View {
        if store.board != nil {
            Section("Danger zone") {
                Button("Disconnect this device", role: .destructive) {
                    confirmDisconnect = true
                }
                .disabled(isDeleting)

                if store.board?.token != nil {
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        HStack {
                            Text("Delete board and all its data")
                            if isDeleting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isDeleting)
                }
            }
            .listRowBackground(Theme.card)
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version", value: appVersion)
            Link(
                "Privacy policy",
                destination: URL(string: "https://github.com/KardanovIR/claude-status-dashboard/blob/master/docs/privacy.md")!
            )
            Link(
                "Source code",
                destination: URL(string: "https://github.com/KardanovIR/claude-status-dashboard")!
            )
        }
        .listRowBackground(Theme.card)
    }

    // MARK: - Notification helpers

    /// Both toggles stay dead when the server can't push or the environment
    /// can't. Denied stays togglable: flipping it re-checks with iOS, which
    /// answers instantly once the user granted permission in Settings.
    private var togglesEnabled: Bool {
        notifications.serverPushAvailable != false
            && notifications.state != .unsupported
    }

    private var notificationsFooter: String {
        if notifications.serverPushAvailable == false {
            return "This server doesn't send push notifications."
        }
        switch notifications.state {
        case .denied:
            return "Notifications are turned off for AgStatus in iOS Settings."
        case .unsupported:
            return "Push isn't available in this environment."
        default:
            return "Get pinged the moment an agent is waiting on you."
        }
    }

    private func blockedToggle(for board: Board) -> Binding<Bool> {
        Binding(
            get: { notifications.state == .on || notifications.state == .requesting },
            set: { enabled in
                Task {
                    if enabled {
                        await notifications.enable(for: board)
                    } else {
                        await notifications.disable(for: board)
                    }
                }
            }
        )
    }

    private func doneToggle(for board: Board) -> Binding<Bool> {
        Binding(
            get: { notifications.notifyDone },
            set: { value in
                notifications.notifyDone = value
                Task { await notifications.updateFlags(for: board) }
            }
        )
    }

    private func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - Actions

    private func copyWebhook(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation { copiedWebhook = true }
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            withAnimation { copiedWebhook = false }
        }
    }

    private func deleteBoard() {
        guard !isDeleting else { return }
        isDeleting = true
        Task {
            do {
                try await store.deleteBoardEverywhere()
                dismiss()
            } catch {
                deleteErrorText = error.localizedDescription
                showDeleteError = true
            }
            isDeleting = false
        }
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }
}
