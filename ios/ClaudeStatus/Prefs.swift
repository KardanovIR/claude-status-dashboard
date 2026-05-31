import Foundation

enum Prefs {
    private static let urlKey = "dashboard_url"
    private static let keepAwakeKey = "keep_awake"

    static var dashboardURL: String? {
        get {
            let raw = UserDefaults.standard.string(forKey: urlKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (raw?.isEmpty ?? true) ? nil : raw
        }
        set {
            UserDefaults.standard.set(newValue, forKey: urlKey)
        }
    }

    static var keepAwake: Bool {
        get {
            // Default true on first launch.
            if UserDefaults.standard.object(forKey: keepAwakeKey) == nil { return true }
            return UserDefaults.standard.bool(forKey: keepAwakeKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: keepAwakeKey)
        }
    }

    /// Returns a normalized http(s) URL string, or nil if the input is unusable.
    static func normalize(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard let url = URL(string: withScheme),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        var s = withScheme
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
