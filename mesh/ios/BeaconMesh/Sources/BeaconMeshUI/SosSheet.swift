#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

/// Confirmation sheet: optional note and head count, then a hold-to-send (critical and high) or a plain button.
struct SosSheet: View {
    @ObservedObject var node: MeshNode
    let category: Category
    /// nil = dismissed without sending.
    let finish: (SendResult?) -> Void

    @ObservedObject private var haptics = Haptics.shared
    @State private var note = ""
    @State private var people = 1
    @FocusState private var noteFocused: Bool

    private let maxNote = 280

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(category.title, systemImage: category.symbol)
                        .font(.title3.bold())
                        .foregroundStyle(category.color)
                    Text(explainer).font(.footnote).foregroundStyle(.secondary)
                }
                Section("Add details (optional)") {
                    TextField("What do responders need to know?", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($noteFocused)
                        .onChange(of: note) { if $0.count > maxNote { note = String($0.prefix(maxNote)) } }
                    Stepper(value: $people, in: 1...99) { Text(people == 1 ? "1 person" : "\(people) people") }
                        .onChange(of: people) { _ in haptics.play(.select) }
                        .accessibilityLabel("Number of people")
                        .accessibilityValue("\(people)")
                }
                Section {
                    if category.requiresHold {
                        HoldToConfirmButton(title: category.title, tint: category.color) { send() }
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    } else {
                        Button { haptics.play(.tap); send() } label: {
                            Label("Send", systemImage: "paperplane.fill").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(category.color)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                } footer: {
                    if !node.canEncrypt {
                        Text("No server key on this phone yet, so nothing can be sent. Connect to the internet once.")
                    } else if !node.hasLocation {
                        Text("No location yet. Allow location access so responders can find you.")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Confirm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { haptics.play(.sheetDismiss); finish(nil) }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { haptics.prepare() }
    }

    private var explainer: String {
        switch category.tier {
        case .critical: return "Highest priority. It can hop through up to 10 phones and stays alive for 24 hours."
        case .high: return "High priority. It can hop through up to 7 phones for 12 hours."
        case .safe: return "Lets people know you're fine. It hops through up to 3 phones."
        default: return "It hops from phone to phone until one has internet."
        }
    }

    private func send() {
        noteFocused = false
        let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = node.sendSOS(category, text: n.isEmpty ? nil : n, people: (people > 1 || category != .safe) ? people : nil)
        finish(result)
    }
}
#endif
