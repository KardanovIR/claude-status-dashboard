import SwiftUI
import UIKit

struct ContentView: View {
    @State private var dashboardURL: String? = Prefs.dashboardURL
    @State private var keepAwake: Bool = Prefs.keepAwake
    @State private var showSetup: Bool = Prefs.dashboardURL == nil
    @State private var reloadToken: Int = 0
    @State private var isLoading: Bool = false
    @State private var loadError: String?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color(red: 0x0b/255, green: 0x0d/255, blue: 0x12/255)
                .ignoresSafeArea()

            if let urlString = dashboardURL, let url = URL(string: urlString) {
                DashboardWebView(
                    url: url,
                    reloadToken: $reloadToken,
                    isLoading: $isLoading,
                    loadError: $loadError
                )
                .ignoresSafeArea()

                if let err = loadError {
                    VStack(spacing: 16) {
                        Text("Could not load the dashboard.")
                            .font(.headline)
                        Text(err)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button("Retry") {
                            loadError = nil
                            reloadToken += 1
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
                    .padding(32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black.opacity(0.25))
                }
            } else {
                Color.clear
            }

            menuButton
                .padding(.top, 8)
                .padding(.trailing, 12)
        }
        .sheet(isPresented: $showSetup) {
            SetupView(
                isFirstLaunch: dashboardURL == nil,
                onSave: { newURL, awake in
                    dashboardURL = newURL
                    keepAwake = awake
                    applyKeepAwake()
                    reloadToken += 1
                    loadError = nil
                }
            )
            .interactiveDismissDisabled(dashboardURL == nil)
        }
        .onAppear { applyKeepAwake() }
        .onChange(of: keepAwake) { _ in applyKeepAwake() }
    }

    private var menuButton: some View {
        Menu {
            Button {
                reloadToken += 1
                loadError = nil
            } label: {
                Label("Reload", systemImage: "arrow.clockwise")
            }
            .disabled(dashboardURL == nil)

            Toggle(isOn: $keepAwake) {
                Label("Keep screen on", systemImage: "sun.max")
            }

            Button {
                showSetup = true
            } label: {
                Label("Change URL…", systemImage: "globe")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 40, height: 40)
                .background(
                    Circle().fill(Color.black.opacity(0.55))
                )
                .overlay(Circle().stroke(.white.opacity(0.08)))
        }
        .menuStyle(.button)
        .accessibilityLabel("Menu")
    }

    private func applyKeepAwake() {
        UIApplication.shared.isIdleTimerDisabled = keepAwake && dashboardURL != nil
    }
}
