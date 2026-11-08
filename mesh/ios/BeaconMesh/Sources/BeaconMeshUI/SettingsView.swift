#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

struct SettingsView: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @State private var showLog = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    // Fixed at build time; shown read-only.
                    LabeledContent("Server", value: node.backendHost)
                        .accessibilityHint("Fixed in this build")
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
        }
    }
}
#endif
