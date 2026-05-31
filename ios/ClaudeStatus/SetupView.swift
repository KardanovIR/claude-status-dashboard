import SwiftUI

struct SetupView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var url: String
    @State private var keepAwake: Bool
    @State private var error: String?

    let isFirstLaunch: Bool
    let onSave: (String, Bool) -> Void

    init(isFirstLaunch: Bool, onSave: @escaping (String, Bool) -> Void) {
        self.isFirstLaunch = isFirstLaunch
        self.onSave = onSave
        _url = State(initialValue: Prefs.dashboardURL ?? "")
        _keepAwake = State(initialValue: Prefs.keepAwake)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.50:3000", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .submitLabel(.done)
                } header: {
                    Text("Dashboard URL")
                } footer: {
                    Text("Include the scheme (http or https) and port if it's not 80/443.")
                }

                Section {
                    Toggle("Keep screen on", isOn: $keepAwake)
                } footer: {
                    Text("Prevents the device from sleeping while the dashboard is open.")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(isFirstLaunch ? "Setup" : "Dashboard server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isFirstLaunch {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
        }
    }

    private func save() {
        guard let normalized = Prefs.normalize(url) else {
            error = "Please enter a valid http(s) URL with a host."
            return
        }
        Prefs.dashboardURL = normalized
        Prefs.keepAwake = keepAwake
        onSave(normalized, keepAwake)
        dismiss()
    }
}
