#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI
import UIKit

/// Destinations pushed inside the Settings tab. Kept in a NavigationPath owned by the root view so that tapping the
/// Settings tab again can pop back to this root.
enum SettingsRoute: Hashable {
    case myProfile
}

struct SettingsView: View {
    @ObservedObject var node: MeshNode
    @Binding var path: NavigationPath
    @ObservedObject private var haptics = Haptics.shared
    @State private var showLog = false
    @State private var confirmReset = false
    @State private var resetFailed = false
    @State private var copied = false
    @AppStorage(ResponderPrefs.modeKey) private var responderMode = false
    @AppStorage(UnitPreference.storageKey) private var unitPref = UnitPreference.automatic.rawValue

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section("Server") {
                    // Fixed at build time; shown read-only.
                    LabeledContent("Server", value: node.backendHost)
                        .accessibilityHint("Fixed in this build")
                }
                Section {
                    Picker("Units", selection: Binding(get: { unitPref }, set: { unitPref = $0; haptics.play(.select) })) {
                        ForEach(UnitPreference.allCases, id: \.self) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Units")
                } header: {
                    Text("Units")
                } footer: {
                    let shown = UnitSettings.system(for: unitPref) == .imperial ? "feet, inches and miles" : "centimeters, meters and kilometers"
                    Text("Automatic follows your region. Right now Beacon shows \(shown). Storage and the server always use metric.")
                }
                ProfileSettingsSection(node: node)
                Section {
                    Toggle("Responder mode", isOn: Binding(get: { responderMode }, set: { responderMode = $0; haptics.play(.toggle) }))
                        .accessibilityHint("Adds a Responder tab. Turning it off signs you out and stops sharing your location")
                } header: {
                    Text("First responder mode")
                } footer: {
                    Text("Adds a Responder tab: sign in with your dashboard account to see people who asked for help on a map. The mesh keeps relaying while you use it. Turning this off signs you out.")
                }
                Section("Feedback") {
                    Toggle("Haptic feedback", isOn: Binding(get: { haptics.enabled }, set: { v in
                        haptics.enabled = v
                        haptics.play(.toggle)
                    }))
                }
                Section {
                    Stepper(value: Binding(get: { node.demoHopCap ?? 0 }, set: { node.demoHopCap = $0 == 0 ? nil : $0; haptics.play(.select) }), in: 0...10) {
                        Text(node.demoHopCap.map { "Max hops for non-critical: \($0)" } ?? "Hop cap: off (priority table)")
                    }
                    Toggle("Force offline (never act as gateway)", isOn: Binding(get: { node.forceOffline }, set: { node.forceOffline = $0; haptics.play(.toggle) }))
                    Button("Sync with server now") { haptics.play(.tap); node.syncNow() }
                    Button("Reset device identity", role: .destructive) { haptics.play(.warning); confirmReset = true }
                        .accessibilityHint("Makes this phone a new sender so the server does not merge your reports. Asks first")
                    LabeledContent("Sender id", value: node.keyShortId)
                    LabeledContent("Peer id", value: node.instanceShortId)
                    if let r = node.lastIdentityReset {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Identity reset").font(.subheadline.weight(.semibold))
                            Text("Sender: \(r.oldKeyId) to \(r.newKeyId)\nPeer: \(r.oldInstanceId) to \(r.newInstanceId)")
                                .font(.footnote.monospaced())
                                .fixedSize(horizontal: false, vertical: true)
                            Button(copied ? "Copied" : "Copy ids") {
                                UIPasteboard.general.string = "sender \(r.oldKeyId) -> \(r.newKeyId), peer \(r.oldInstanceId) -> \(r.newInstanceId)"
                                copied = true
                                haptics.play(.success)
                            }
                            .accessibilityLabel("Copy old and new identity ids")
                        }
                        .accessibilityElement(children: .contain)
                    }
                    if resetFailed {
                        Label("Could not create a new key. Nothing was changed.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                } header: {
                    Text("Debug and demo")
                } footer: {
                    Text("The hop cap lowers max hops for everything except critical alerts, so you can watch a message stop after N phones.")
                }
                Section("Haptics lab") {
                    ForEach(HapticEvent.allCases, id: \.self) { e in
                        Button(String(describing: e)) { haptics.play(e) }
                    }
                    HoldToConfirmButton(title: "test", tint: .purple) { }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    Text(haptics.usesCoreHaptics ? "Using CoreHaptics for the hold ramp." : "CoreHaptics unavailable: using the standard feedback generators.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Diagnostics") {
                    LabeledContent("Relay id", value: node.relayId)
                    DisclosureGroup("Log", isExpanded: $showLog) {
                        ForEach(Array(node.logLines.enumerated()), id: \.offset) { _, line in
                            Text(line).font(.caption2.monospaced())
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(for: SettingsRoute.self) { route in
                switch route {
                case .myProfile: MyProfileView(node: node)
                }
            }
            .alert("Reset device identity?", isPresented: $confirmReset) {
                Button("Reset", role: .destructive) {
                    copied = false
                    let ok = node.resetIdentity()
                    resetFailed = !ok
                    haptics.play(ok ? .success : .error)
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This phone gets a new signing key and a new Bluetooth peer id, and registers with the server as a new device, so new reports are not merged with earlier ones. Your profile is kept and sent to the new device. Message history stays on this phone. The old key is deleted and cannot be restored.")
            }
        }
    }
}
#endif
