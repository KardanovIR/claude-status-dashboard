//
//  NotificationManager.swift
//  AgStatus
//
//  Push notification lifecycle: the permission prompt, APNs device-token
//  registration (with a timeout so simulators never hang the UI), and
//  keeping the board's server in sync with this device. The AppDelegate
//  forwards token callbacks through the shared instance.
//

import Foundation
import Observation
import UIKit
import UserNotifications

@MainActor @Observable
final class NotificationManager {

    enum PushState: Equatable {
        case off, requesting, on, denied, unsupported
    }

    // MARK: State

    private(set) var state: PushState

    /// Also notify when an agent finishes (a per-device server flag).
    /// Persisted locally; callers push changes via updateFlags(for:).
    var notifyDone: Bool {
        didSet { UserDefaults.standard.set(notifyDone, forKey: Keys.notifyDone) }
    }

    /// Whether the board's server advertises push support. Nil means
    /// unknown — not probed yet, or the server couldn't be reached.
    private(set) var serverPushAvailable: Bool?

    /// Single instance so the AppDelegate token callbacks can reach the
    /// same manager the UI observes.
    static let shared = NotificationManager()

    @ObservationIgnored private var deviceToken: String?
    @ObservationIgnored private var tokenWaiter: (id: Int, continuation: CheckedContinuation<String, Error>)?
    @ObservationIgnored private var lastWaiterID = 0
    @ObservationIgnored private var probedBase: URL?
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?

    private enum Keys {
        static let enabled = "pushEnabled"
        static let notifyDone = "pushNotifyDone"
        static let deviceToken = "pushDeviceToken"
        static let pendingUnregisterToken = "pushPendingUnregisterToken"
        static let pendingUnregisterBoard = "pushPendingUnregisterBoard"
    }

    private enum PushError: Error {
        case tokenTimeout
    }

    private init() {
        let defaults = UserDefaults.standard
        state = defaults.bool(forKey: Keys.enabled) ? .on : .off
        notifyDone = defaults.bool(forKey: Keys.notifyDone)
        deviceToken = defaults.string(forKey: Keys.deviceToken)

        // A denied user may grant permission in iOS Settings and come back —
        // re-arm the toggle and tip when the app returns to the foreground.
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.recheckDeniedPermission()
            }
        }
    }

    // MARK: Enable / disable

    /// Full opt-in path: permission prompt → APNs registration → server POST.
    func enable(for board: Board) async {
        guard state != .requesting else { return }
        state = .requesting
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                setEnabled(false)
                state = .denied
                return
            }
            let token = try await currentDeviceToken()
            try await AgStatusAPI.registerDevice(token, notifyDone: notifyDone, for: board)
            clearPendingUnregister()
            setEnabled(true)
            state = .on
        } catch is APIError {
            // The server rejected us or is unreachable — the toggle snaps back.
            setEnabled(false)
            state = .off
        } catch is CancellationError {
            // Superseded by a newer registration attempt — it owns the state.
            return
        } catch {
            // Token timeout or OS registration failure — push isn't available here.
            setEnabled(false)
            state = .unsupported
        }
    }

    /// Removes this device from the board's server. The OS registration is
    /// kept so re-enabling doesn't re-prompt. A failed DELETE is remembered
    /// and retried on the next launch so pushes don't keep arriving.
    func disable(for board: Board) async {
        setEnabled(false)
        state = .off
        guard let deviceToken else { return }
        do {
            try await AgStatusAPI.unregisterDevice(deviceToken, for: board)
        } catch {
            storePendingUnregister(deviceToken, for: board)
        }
    }

    /// Re-POSTs the registration so the server picks up the current flags.
    func updateFlags(for board: Board) async {
        guard state == .on, let deviceToken else { return }
        try? await AgStatusAPI.registerDevice(deviceToken, notifyDone: notifyDone, for: board)
    }

    /// Tears down push for a board this device is leaving (disconnect or
    /// replacement): best-effort server unregister, then a local reset so
    /// the next board starts from a clean slate.
    func boardWillChange(from old: Board?) async {
        if UserDefaults.standard.bool(forKey: Keys.enabled),
           let deviceToken, let old, old.token != nil {
            try? await AgStatusAPI.unregisterDevice(deviceToken, for: old)
        }
        setEnabled(false)
        state = .off
        probedBase = nil
        serverPushAvailable = nil
    }

    /// Silent re-registration on launch so APNs token rotation is picked up.
    /// Also downgrades the state when permission was revoked in iOS Settings,
    /// and retries any unregister that failed while disabling.
    func resyncOnLaunch(for board: Board?) async {
        await retryPendingUnregister()
        guard UserDefaults.standard.bool(forKey: Keys.enabled),
              let board, board.token != nil else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .denied:
            state = .denied
            return
        default:
            state = .off
            return
        }
        do {
            let token = try await currentDeviceToken()
            try await AgStatusAPI.registerDevice(token, notifyDone: notifyDone, for: board)
            state = .on
        } catch is APIError {
            // Server unreachable right now — keep the cached registration.
        } catch is CancellationError {
            // Superseded by a newer registration attempt — it owns the state.
            return
        } catch {
            state = .unsupported
        }
    }

    /// Asks the server whether it sends pushes at all. Only definitive
    /// answers are cached — an unreachable server stays "unknown" so the
    /// next appearance retries.
    func probeServerSupport(for board: Board) async {
        if probedBase != board.baseURL {
            probedBase = board.baseURL
            serverPushAvailable = nil
        }
        guard serverPushAvailable == nil else { return }
        serverPushAvailable = await AgStatusAPI.serverSupportsPush(board.baseURL)
    }

    // MARK: AppDelegate callbacks

    /// Called by the AppDelegate when APNs hands over a device token.
    func handle(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = hex
        UserDefaults.standard.set(hex, forKey: Keys.deviceToken)
        if let waiter = tokenWaiter {
            tokenWaiter = nil
            waiter.continuation.resume(returning: hex)
        }
    }

    /// Called by the AppDelegate when APNs registration fails.
    func handleRegistrationFailure(_ error: Error) {
        if let waiter = tokenWaiter {
            tokenWaiter = nil
            waiter.continuation.resume(throwing: error)
        }
    }

    // MARK: Helpers

    /// If the user granted permission in iOS Settings while we showed
    /// .denied, drop back to .off so the toggle and tip work again.
    private func recheckDeniedPermission() async {
        guard state == .denied else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            state = .off
        default:
            break
        }
    }

    /// Asks the OS (again) for the APNs token and waits for the delegate
    /// callback. Times out after 10s — simulators may never call back.
    private func currentDeviceToken() async throws -> String {
        if let waiter = tokenWaiter {
            tokenWaiter = nil
            waiter.continuation.resume(throwing: CancellationError())
        }
        lastWaiterID += 1
        let id = lastWaiterID
        UIApplication.shared.registerForRemoteNotifications()
        return try await withCheckedThrowingContinuation { continuation in
            tokenWaiter = (id, continuation)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                guard let self, let waiter = self.tokenWaiter, waiter.id == id else { return }
                self.tokenWaiter = nil
                waiter.continuation.resume(throwing: PushError.tokenTimeout)
            }
        }
    }

    private func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Keys.enabled)
    }

    // MARK: Pending unregister

    private func storePendingUnregister(_ token: String, for board: Board) {
        guard let data = try? JSONEncoder().encode(board) else { return }
        let defaults = UserDefaults.standard
        defaults.set(token, forKey: Keys.pendingUnregisterToken)
        defaults.set(data, forKey: Keys.pendingUnregisterBoard)
    }

    private func clearPendingUnregister() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Keys.pendingUnregisterToken)
        defaults.removeObject(forKey: Keys.pendingUnregisterBoard)
    }

    /// Retries a DELETE that failed while disabling. A gone board counts as
    /// done — deleting a board purges its devices server-side. Unreadable
    /// leftovers are dropped so they can't wedge the retry forever.
    private func retryPendingUnregister() async {
        let defaults = UserDefaults.standard
        guard let token = defaults.string(forKey: Keys.pendingUnregisterToken),
              let data = defaults.data(forKey: Keys.pendingUnregisterBoard),
              let board = try? JSONDecoder().decode(Board.self, from: data) else {
            if defaults.object(forKey: Keys.pendingUnregisterToken) != nil
                || defaults.object(forKey: Keys.pendingUnregisterBoard) != nil {
                clearPendingUnregister()
            }
            return
        }
        do {
            try await AgStatusAPI.unregisterDevice(token, for: board)
            clearPendingUnregister()
        } catch let error as APIError where error == .boardNotFound {
            clearPendingUnregister()
        } catch {
            // Still failing — keep it for the next launch.
        }
    }
}
