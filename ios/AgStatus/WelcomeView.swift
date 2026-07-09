import SwiftUI
import UIKit

/// First-run screen: create a board, scan a setup QR, or paste a board URL.
struct WelcomeView: View {
    @Environment(SessionStore.self) private var store

    @State private var isCreating = false
    @State private var errorText: String?
    @State private var showScanner = false
    @State private var showURLEntry = false
    @State private var showServerField = false
    @State private var serverText = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                header
                    .padding(.top, 48)
                actions
                selfHosting
                demoButton
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .scrollBounceBehavior(.basedOnSize)
        .fullScreenCover(isPresented: $showScanner) { ScannerView() }
        .sheet(isPresented: $showURLEntry) { BoardURLEntrySheet() }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Theme.card)
                    .frame(width: 84, height: 84)
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(Theme.cardBorder)
                    )
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(Theme.color(for: .coding))
            }
            .accessibilityHidden(true)
            Text("AgStatus")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.textPrimary)
            Text("Live status board for your coding agents")
                .font(.body)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button(action: createBoard) {
                HStack(spacing: 10) {
                    if isCreating {
                        ProgressView()
                            .tint(.white)
                    }
                    Text(isCreating ? "Creating…" : "Create a status board")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.color(for: .planning))
            .disabled(isCreating)

            Button {
                errorText = nil
                showScanner = true
            } label: {
                Label("Scan setup QR code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.bordered)
            .tint(Theme.textPrimary)

            Button {
                errorText = nil
                showURLEntry = true
            } label: {
                Label("Enter board URL", systemImage: "link")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.bordered)
            .tint(Theme.textPrimary)

            if let errorText {
                Text(errorText)
                    .font(.footnote)
                    .foregroundStyle(Theme.color(for: .blocked))
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
        }
    }

    private var selfHosting: some View {
        VStack(spacing: 10) {
            Button {
                withAnimation(.snappy) { showServerField.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Text("Self-hosting? Point any action at your own server")
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(showServerField ? .degrees(180) : .zero)
                }
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
            }

            if showServerField {
                TextField("https://your-server.example", text: $serverText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(.subheadline, design: .monospaced))
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Theme.card)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.cardBorder)
                    )
                    .accessibilityLabel("Custom server URL")
            }
        }
    }

    private var demoButton: some View {
        Button("Try the demo") {
            store.startDemo()
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(Theme.color(for: .planning))
    }

    // MARK: - Actions

    private func createBoard() {
        guard !isCreating else { return }
        errorText = nil
        guard let base = resolvedServerURL() else {
            errorText = "That server address doesn't look right."
            return
        }
        isCreating = true
        Task {
            do {
                // Legacy single-tenant servers have no workspaces — the whole
                // server IS the board. Probe first so a self-hoster isn't met
                // with a misleading "board no longer exists" from the 404.
                if try await AgStatusAPI.serverMode(of: base) == .legacy {
                    let board = Board(baseURL: base, token: nil)
                    try await AgStatusAPI.validate(board)
                    store.adopt(board)
                } else {
                    let board = try await AgStatusAPI.createBoard(on: base)
                    store.adopt(board)
                }
            } catch {
                errorText = error.localizedDescription
            }
            isCreating = false
        }
    }

    /// The custom server field (when filled) wins; otherwise the default server.
    private func resolvedServerURL() -> URL? {
        let trimmed = serverText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Board.defaultServer }
        var candidate = trimmed
        let lowered = candidate.lowercased()
        if !lowered.hasPrefix("http://") && !lowered.hasPrefix("https://") {
            candidate = "https://" + candidate
        }
        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host() != nil
        else { return nil }
        return url
    }
}

/// Small sheet for pasting or typing a board URL by hand.
private struct BoardURLEntrySheet: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var text = ""
    @State private var errorText: String?
    @State private var isConnecting = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Paste the board URL from your dashboard or from the setup output on your computer.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)

                HStack(spacing: 8) {
                    TextField("https://…/w/ags_…", text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.system(.subheadline, design: .monospaced))
                        .focused($fieldFocused)
                        .onSubmit(connect)
                    Button {
                        if let pasted = UIPasteboard.general.string {
                            text = pasted
                            errorText = nil
                        }
                    } label: {
                        Image(systemName: "doc.on.clipboard")
                    }
                    .accessibilityLabel("Paste board URL")
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Theme.card)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Theme.cardBorder)
                )

                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(Theme.color(for: .blocked))
                }

                Button(action: connect) {
                    HStack(spacing: 10) {
                        if isConnecting {
                            ProgressView()
                                .tint(.white)
                        }
                        Text(isConnecting ? "Checking…" : "Connect")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.color(for: .planning))
                .disabled(isConnecting || text.trimmingCharacters(in: .whitespaces).isEmpty)

                Spacer()
            }
            .padding(20)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Enter board URL")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .onAppear { fieldFocused = true }
    }

    private func connect() {
        guard !isConnecting else { return }
        errorText = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidate = trimmed
        let lowered = candidate.lowercased()
        if !lowered.hasPrefix("http://") && !lowered.hasPrefix("https://") {
            candidate = "https://" + candidate
        }
        guard !trimmed.isEmpty,
              let url = URL(string: candidate),
              let board = AgStatusAPI.parseBoardURL(url)
        else {
            errorText = "That doesn't look like a board URL."
            return
        }
        isConnecting = true
        Task {
            do {
                try await AgStatusAPI.validate(board)
                store.adopt(board)
                dismiss()
            } catch {
                errorText = error.localizedDescription
                isConnecting = false
            }
        }
    }
}
