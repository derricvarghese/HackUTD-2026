#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

struct MeshStatusView: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared

    var body: some View {
        NavigationStack {
            List {
                Section("Mesh") {
                    row("Phones nearby", "\(node.peerCount)", symbol: "dot.radiowaves.left.and.right")
                    row("Waiting for internet", "\(MessageUi.heldOffline(node.messages.map { MessageUi.map($0) }))", symbol: "tray.full")
                    row("Backend messages held", "\(node.heldBackendCount)", symbol: "envelope")
                    row("Mode", node.isGateway ? "Gateway (online)" : node.hasInternet ? "Relay (forced offline)" : "Offline relay",
                        symbol: node.isGateway ? "wifi" : "wifi.slash", tint: node.isGateway ? .green : .orange)
                }
                Section("Server") {
                    row("Server", node.backendHost, symbol: "server.rack")
                    row("Encryption key", node.encryptionKeyStatus.label, symbol: "lock.fill",
                        tint: node.encryptionKeyStatus == .none ? .red : .green)
                    row("Signing key", node.signingKeyStatus.label, symbol: "checkmark.seal",
                        tint: node.signingKeyStatus == .none ? .orange : .green)
                    row("Profile", node.profileDeleting ? "being deleted" : node.profileStatus.title, symbol: node.profileStatus.symbol,
                        tint: node.profileStatus == .synced ? .green : node.profileStatus == .empty ? .secondary : .orange)
                    if let at = node.lastProfileSyncAt { row("Profile last synced", Fmt.time(at), symbol: "person.crop.circle.badge.checkmark") }
                    row("This phone is registered", node.deviceId.map { "yes (\($0.prefix(8)))" } ?? "not yet", symbol: "person.badge.key")
                    row("Last upload", node.lastUpload.map { "\(Fmt.time(Date(timeIntervalSince1970: Double($0.atMs) / 1000))) \($0.ok ? "ok" : "failed")" } ?? "none yet",
                        symbol: "arrow.up.circle", tint: node.lastUpload.map { $0.ok ? .green : .red } ?? .secondary)
                    row("Server info refreshed", Fmt.time(node.lastInfoAt), symbol: "arrow.triangle.2.circlepath")
                    row("Emergency event", node.eventActive ? "active" : "none known", symbol: "exclamationmark.triangle")
                    row("Last heartbeat", Fmt.time(node.lastHeartbeatAt), symbol: "heart.text.square")
                    if let e = node.syncError { row("Last problem", e, symbol: "exclamationmark.circle", tint: .red) }
                }
                Section("This phone") {
                    row("Location", node.hasLocation ? (node.gpsAccuracy.map { "±\(Int($0)) m" } ?? "known") : "none yet",
                        symbol: "location", tint: node.hasLocation ? .green : .orange)
                    row("Relay id", node.relayId, symbol: "number")
                }
            }
            .navigationTitle("Mesh status")
            .refreshable { node.syncNow(); haptics.play(.tap) }
        }
    }

    private func row(_ title: String, _ value: String, symbol: String, tint: Color = .secondary) -> some View {
        HStack {
            Label(title, systemImage: symbol).foregroundStyle(.primary)
            Spacer(minLength: 12)
            Text(value).foregroundStyle(tint == .secondary ? Color.secondary : tint).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
