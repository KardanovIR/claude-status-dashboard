import SwiftUI
import UserNotifications

@main
struct AgStatusApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store: SessionStore
    @State private var notifications = NotificationManager.shared

    init() {
        let store = SessionStore()
        // Leaving a board (disconnect or replacement) must release this
        // device's push registration — without the store depending on the
        // notification manager.
        store.onBoardReleased = { board in
            Task { await NotificationManager.shared.boardWillChange(from: board) }
        }
        _store = State(initialValue: store)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(notifications)
                .preferredColorScheme(.dark)
                .task { await notifications.resyncOnLaunch(for: store.board) }
        }
    }
}

/// Bridges the UIKit push callbacks to the NotificationManager and keeps
/// notification banners visible while the app is in the foreground.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationManager.shared.handle(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationManager.shared.handleRegistrationFailure(error)
    }

    /// The board itself stays authoritative on screen — the banner is a nudge.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// Tapping a notification just opens the app, which lands on the board.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {}
}
