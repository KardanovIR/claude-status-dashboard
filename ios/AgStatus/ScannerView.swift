import SwiftUI
import UIKit
import AVFoundation
import Vision
import VisionKit

/// Full-screen QR scanner for the setup code printed by the pairing command.
/// Falls back to a paste field when live scanning isn't available.
struct ScannerView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    /// nil while we're still checking camera support/permission.
    @State private var scanningAvailable: Bool?
    @State private var hint: String?
    @State private var isValidating = false
    @State private var manualText = ""

    var body: some View {
        NavigationStack {
            Group {
                switch scanningAvailable {
                case .none:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .some(true):
                    scannerBody
                case .some(false):
                    fallbackPanel
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Scan setup QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close scanner")
                }
            }
        }
        .task {
            guard DataScannerViewController.isSupported else {
                scanningAvailable = false
                return
            }
            if !DataScannerViewController.isAvailable {
                // Triggers the camera permission prompt on first run.
                _ = await AVCaptureDevice.requestAccess(for: .video)
            }
            scanningAvailable = DataScannerViewController.isAvailable
        }
    }

    // MARK: - Live scanner

    private var scannerBody: some View {
        ZStack(alignment: .bottom) {
            QRScannerRepresentable { payload in
                handleScanned(payload)
            }
            .ignoresSafeArea()

            LinearGradient(
                colors: [.clear, .black.opacity(0.75)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 180)
            .allowsHitTesting(false)

            statusHint
                .padding(.horizontal, 24)
                .padding(.bottom, 28)
        }
    }

    @ViewBuilder
    private var statusHint: some View {
        Group {
            if isValidating {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Checking board…")
                }
                .foregroundStyle(Theme.textPrimary)
            } else if let hint {
                Label(hint, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.color(for: .testing))
            } else {
                Text("Point your camera at the setup QR code shown on your computer.")
                    .foregroundStyle(Theme.textPrimary)
            }
        }
        .font(.subheadline)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.black.opacity(0.55))
        )
    }

    // MARK: - Fallback (simulator / no camera)

    private var fallbackPanel: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.slash")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
                .padding(.top, 32)
            Text("Camera scanning isn't available")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Paste the board URL instead — it's printed right under the QR code.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)

            HStack(spacing: 8) {
                TextField("https://…/w/ags_…", text: $manualText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(.subheadline, design: .monospaced))
                    .onSubmit { handleManual() }
                Button {
                    if let pasted = UIPasteboard.general.string {
                        manualText = pasted
                        hint = nil
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

            if let hint {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.color(for: .blocked))
                    .multilineTextAlignment(.center)
            }

            Button(action: handleManual) {
                HStack(spacing: 10) {
                    if isValidating {
                        ProgressView()
                            .tint(.white)
                    }
                    Text(isValidating ? "Checking…" : "Connect")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.color(for: .planning))
            .disabled(
                isValidating
                    || manualText.trimmingCharacters(in: .whitespaces).isEmpty
            )

            Spacer()
        }
        .padding(20)
    }

    // MARK: - Shared handling

    private func handleScanned(_ payload: String) {
        guard !isValidating else { return }
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let board = AgStatusAPI.parseBoardURL(url)
        else {
            withAnimation { hint = "That's not an AgStatus board QR" }
            return
        }
        adopt(board)
    }

    private func handleManual() {
        guard !isValidating else { return }
        let trimmed = manualText.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidate = trimmed
        let lowered = candidate.lowercased()
        if !lowered.hasPrefix("http://") && !lowered.hasPrefix("https://") {
            candidate = "https://" + candidate
        }
        guard !trimmed.isEmpty,
              let url = URL(string: candidate),
              let board = AgStatusAPI.parseBoardURL(url)
        else {
            withAnimation { hint = "That doesn't look like a board URL." }
            return
        }
        adopt(board)
    }

    private func adopt(_ board: Board) {
        isValidating = true
        hint = nil
        Task {
            do {
                try await AgStatusAPI.validate(board)
                store.adopt(board)
                dismiss()
            } catch {
                withAnimation { hint = error.localizedDescription }
                isValidating = false
            }
        }
    }
}

// MARK: - VisionKit wrapper

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onScan = onScan
        if !scanner.isScanning {
            try? scanner.startScanning()
        }
    }

    static func dismantleUIViewController(
        _ scanner: DataScannerViewController,
        coordinator: Coordinator
    ) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onScan: (String) -> Void

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        // A code that stays in frame only fires didAdd once; if its first
        // validation failed (server briefly down), didUpdate + a cooldown
        // lets the same code retry without the user re-aiming the camera.
        private var lastPayload: String?
        private var lastPayloadAt: Date = .distantPast

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            handle(addedItems)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            handle(updatedItems)
        }

        private func handle(_ items: [RecognizedItem]) {
            for item in items {
                if case .barcode(let barcode) = item,
                   let payload = barcode.payloadStringValue {
                    let now = Date()
                    if payload == lastPayload, now.timeIntervalSince(lastPayloadAt) < 3 {
                        return // same code, still cooling down from the last attempt
                    }
                    lastPayload = payload
                    lastPayloadAt = now
                    onScan(payload)
                    return
                }
            }
        }
    }
}
