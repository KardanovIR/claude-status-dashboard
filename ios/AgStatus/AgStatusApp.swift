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
        // A "Bring to front" tapped on a push: the store sends the command
        // once the board is in — the same explicit control the card offers.
        NotificationManager.shared.onFocusAction = { [weak store] sessionId in
            store?.focusFromNotification(sessionId: sessionId)
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
        NotificationManager.shared.registerCategories()
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
    /// Our "Bring to front" action opens it too, and additionally hands the
    /// push's session id (its `thread-id`) to the store, which sends the
    /// focus command once it has the board — if the session is still there
    /// with its machine online; otherwise the app has simply opened.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == NotificationManager.focusActionIdentifier else { return }
        let sessionId = response.notification.request.content.threadIdentifier
        guard !sessionId.isEmpty else { return }
        NotificationManager.shared.handleFocusAction(sessionId: sessionId)
    }
}
