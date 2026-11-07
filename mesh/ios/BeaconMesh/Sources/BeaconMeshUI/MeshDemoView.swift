import BeaconMesh
import SwiftUI

/// Minimal test harness UI for the mesh: SOS buttons, hop-cap demo setting, message list and log.
public struct MeshDemoView: View {
    @ObservedObject var node: MeshNode
    @State private var note = ""
    @State private var showLog = false

    public init(node: MeshNode) {
        self.node = node
    }

    public var body: some View {
        NavigationView {
            List {
                Section {
                    HStack {
                        Label("\(node.peerCount) peer(s)", systemImage: "dot.radiowaves.left.and.right")
                        Spacer()
                        Text(node.isGateway ? "GATEWAY (online)" : "Offline relay")
                            .font(.caption.bold())
                            .foregroundColor(node.isGateway ? .green : .orange)
                    }
                    Text("Relay ID \(node.relayId)").font(.caption.monospaced())
                }

                Section("Send SOS") {
                    TextField("Optional note (e.g. 2 people, water rising)", text: $note)
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())]) {
                        sosButton("Trapped", .trapped, .red)
                        sosButton("Injured", .injured, .red)
                        sosButton("Water / meds", .waterMeds, .orange)
                        sosButton("I'm safe", .safe, .green)
                    }
                }

                Section("Demo settings") {
                    Stepper(value: Binding(get: { node.demoHopCap ?? 0 },
                                           set: { node.demoHopCap = $0 == 0 ? nil : $0 }),
                            in: 0...10) {
                        Text(node.demoHopCap.map { "Non-critical max hops: \($0)" } ?? "Hop cap: off (priority table)")
                    }
                    Toggle("Force offline (never act as gateway)", isOn: $node.forceOffline)
                    TextField("Backend URL (https://…)", text: $node.backendURLString)
                        .autocorrectionDisabled()
                }

                Section("Messages (\(node.messages.count))") {
                    ForEach(node.messages) { msg in
                        MessageRow(msg: msg)
                    }
                }

                Section {
                    DisclosureGroup("Log", isExpanded: $showLog) {
                        ForEach(Array(node.logLines.enumerated()), id: \.offset) { _, line in
                            Text(line).font(.caption2.monospaced())
                        }
                    }
                }
            }
            .navigationTitle("Beacon Mesh")
        }
    }

    private func sosButton(_ title: String, _ category: BeaconMesh.Category, _ color: Color) -> some View {
        Button {
            node.sendSOS(category, text: note)
            note = ""
        } label: {
            Text(title).font(.headline).frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.borderedProminent)
        .tint(color)
    }
}

struct MessageRow: View {
    let msg: StoredMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(msg.header.body?.category ?? msg.header.kind).font(.headline)
                Text(msg.header.pri.uppercased()).font(.caption.bold())
                    .foregroundColor(msg.header.priority == .critical ? .red : .secondary)
                Spacer()
                if msg.uploaded { Image(systemName: "checkmark.icloud.fill").foregroundColor(.green) }
                if msg.isOwn { Text("mine").font(.caption).foregroundColor(.blue) }
            }
            if let text = msg.header.body?.text { Text(text).font(.subheadline) }
            Text(hopLine).font(.caption.monospaced()).foregroundColor(.secondary)
        }
    }

    private var hopLine: String {
        let e = msg.envelope
        let route = e.path.isEmpty ? "origin" : e.path.joined(separator: " → ")
        let status = msg.canForward ? "relaying" : "hop limit reached"
        return "hop \(e.hop)/\(msg.header.maxHops) · \(route) · \(status)"
    }
}
