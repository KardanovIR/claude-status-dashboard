import SwiftUI
import UIKit

/// Switches between the welcome flow and the live board, and owns the
/// keep-awake behavior while a board is on screen.
struct RootView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("keepAwake") private var keepAwake = false

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
        .onChange(of: showsBoard) { applyKeepAwake() }
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
            case .background:
                if !store.isDemo, store.connection != .boardGone {
                    store.disconnect()
                }
            default:
                break
            }
        }
    }

    private func applyKeepAwake() {
        UIApplication.shared.isIdleTimerDisabled = keepAwake && showsBoard
    }
}
