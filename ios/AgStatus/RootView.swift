import SwiftUI
import UIKit

/// Switches between the welcome flow and the live board, and owns the
/// keep-awake behavior while a board is on screen.
struct RootView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("keepAwake") private var keepAwake = false
    /// Minutes of board silence before the screen may sleep again; 0 = never.
    @AppStorage("keepAwakeIdleMinutes") private var keepAwakeIdleMinutes = 10
    @State private var idleRelease: Task<Void, Never>?

    private var showsBoard: Bool { store.board != nil || store.isDemo }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if showsBoard {
                BoardView()
                    .transition(.opacity)
            } else {
                WelcomeView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: showsBoard)
        .onAppear { applyKeepAwake() }
        .onChange(of: keepAwake) { applyKeepAwake() }
        .onChange(of: keepAwakeIdleMinutes) { applyKeepAwake() }
        .onChange(of: showsBoard) { applyKeepAwake() }
        // Every board event restarts the idle countdown, so an active agent
        // keeps the screen on and a quiet board lets it sleep.
        .onChange(of: store.lastActivityAt) { applyKeepAwake() }
        .onChange(of: scenePhase) { _, newPhase in
            // A suspended SSE socket dies silently; reconnect on return so the
            // board never shows stale data under a green dot — and release the
            // server's per-board connection slot while backgrounded.
            switch newPhase {
            case .active:
                // Returning from background arrives as .inactive → .active, so
                // key off the store's state (.idle after the background
                // disconnect), not the previous phase — a brief .inactive dip
                // (app switcher, notification shade) leaves the stream .live
                // and correctly skips this.
                if store.board != nil, !store.isDemo,
                   store.connection == .idle {
                    store.connect()
                }
                applyKeepAwake()
            case .background:
                if !store.isDemo, store.connection != .boardGone {
                    store.disconnect()
                }
            default:
                break
            }
        }
    }

    /// Holds the screen awake while the board is on and active, and re-arms
    /// an idle countdown that releases it after `keepAwakeIdleMinutes` of
    /// board silence (0 = hold forever, the pre-setting behavior).
    private func applyKeepAwake() {
        idleRelease?.cancel()
        idleRelease = nil

        guard keepAwake && showsBoard else {
            UIApplication.shared.isIdleTimerDisabled = false
            return
        }
        UIApplication.shared.isIdleTimerDisabled = true

        guard keepAwakeIdleMinutes > 0 else { return }
        idleRelease = Task {
            try? await Task.sleep(for: .seconds(keepAwakeIdleMinutes * 60))
            guard !Task.isCancelled else { return }
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }
}
