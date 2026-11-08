#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

/// Home: SOS tiles, check-in prompts and blocking problems. Deliberately no navigation title / big heading.
struct HomeView: View {
    @ObservedObject var node: MeshNode
    /// Opens the Mesh tab (the "Mesh details" button on the summary card).
    var onOpenMesh: (() -> Void)? = nil
    @ObservedObject private var haptics = Haptics.shared
    @State private var draft: Category?
    @State private var banner: Banner?

    struct Banner: Equatable {
        var text: String
        var good: Bool
    }

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    MeshSummaryCard(node: node, onOpenMesh: onOpenMesh)
                    if let banner { BannerView(banner: banner) }
                    ProfileHomeSection(node: node)
                    ForEach(node.checkins) { checkin in WelfareCard(checkin: checkin) { node.checkinToShow = checkin } }
                    problems
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach([Category.trapped, .injured, .medical, .waterMeds, .safe], id: \.self) { c in tile(c) }
                    }
                    Menu {
                        Button { open(.other) } label: { Label("Something else", systemImage: Category.other.symbol) }
                    } label: {
                        Label("More", systemImage: "plus.circle")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("More message types")
                }
                .padding(16)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .sheet(item: $draft) { category in
            SosSheet(node: node, category: category) { result in
                draft = nil
                switch result {
                case .sent(let msg):
                    haptics.play(.success)
                    let n = msg.sentToPeers
                    show(Banner(text: node.isGateway ? "Sent to responders." : n > 0 ? "Sent to \(n) nearby phone\(n == 1 ? "" : "s"). It keeps moving until it reaches the internet." : "Saved. It will go out as soon as a phone is nearby.", good: true))
                case .failed(let failure):
                    haptics.play(.error)
                    show(Banner(text: Self.message(for: failure), good: false))
                case nil: break
                }
            }
        }
        .onAppear { haptics.prepare() }
    }

    private var problems: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !node.canEncrypt {
                BannerView(banner: Banner(text: "Can't send yet: this phone has no key for the server. Connect to the internet once so Beacon can fetch it.", good: false))
            }
            if !node.hasLocation {
                BannerView(banner: Banner(text: "Waiting for your location. SOS messages need a position, so allow location access in Settings.", good: false))
            }
        }
    }

    private func tile(_ c: Category) -> some View {
        Button { open(c) } label: {
            VStack(spacing: 8) {
                Image(systemName: c.symbol).font(.title)
                Text(c.title).font(.headline).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 96)
            .padding(.vertical, 8)
        }
        .buttonStyle(.borderedProminent)
        .tint(c.color)
        .controlSize(.large)
        .accessibilityLabel(c == .safe ? "I'm safe" : "Send SOS: \(c.title)")
    }

    private func open(_ c: Category) {
        haptics.play(.sheetOpen)
        draft = c
    }

    private func show(_ b: Banner) {
        withAnimation { banner = b }
        Task {
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            await MainActor.run { withAnimation { if banner == b { banner = nil } } }
        }
    }

    static func message(for f: SendFailure) -> String {
        switch f {
        case .noBackendKey: return "Not sent: no server key on this phone. Connect to the internet once."
        case .noLocation: return "Not sent: no location yet. Allow location access and try again."
        case .other(let m): return "Not sent: \(m)"
        }
    }
}

extension Category: Identifiable { public var id: String { rawValue } }

/// Phones nearby, gateway role and GPS at a glance, pinned to the top of Home (same as Android's MeshSummary).
/// Every value is @Published on MeshNode, so the card updates live as peers connect and drop.
struct MeshSummaryCard: View {
    @ObservedObject var node: MeshNode
    var onOpenMesh: (() -> Void)?

    private var searching: Bool { node.peerCount == 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(node.isGateway ? Color.teal.opacity(0.25) : Color.accentColor.opacity(0.18))
                    if searching && !node.isGateway {
                        ProgressView().controlSize(.large)
                    } else {
                        Image(systemName: node.isGateway ? "icloud.and.arrow.up.fill" : "point.3.connected.trianglepath.dotted")
                            .font(.title2)
                            .foregroundStyle(node.isGateway ? Color.teal : Color.accentColor)
                    }
                }
                .frame(width: 64, height: 64)

                VStack(alignment: .leading, spacing: 2) {
                    Text(searching ? "Looking for nearby phones" : "\(node.peerCount) phone\(node.peerCount == 1 ? "" : "s") nearby")
                        .font(.title3.weight(.semibold))
                        .contentTransition(.numericText())
                        .animation(.default, value: node.peerCount)
                    Text(node.isGateway ? "Gateway: uploading to responders" : "Offline relay: passing messages along")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

            Label(gpsText, systemImage: node.hasLocation ? "location.fill" : "location.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let onOpenMesh {
                Button("Mesh details", action: onOpenMesh)
                    .font(.subheadline.weight(.medium))
                    .frame(minHeight: 44)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var gpsText: String {
        guard node.hasLocation else { return "Searching for GPS" }
        if let acc = node.gpsAccuracy { return "GPS fix, accurate to \(Int(acc.rounded())) m" }
        return "GPS fix"
    }
}

struct BannerView: View {
    let banner: HomeView.Banner
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: banner.good ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(banner.good ? Color.green : Color.orange)
            Text(banner.text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background((banner.good ? Color.green : Color.orange).opacity(0.15), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
#endif
