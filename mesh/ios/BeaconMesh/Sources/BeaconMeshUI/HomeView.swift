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
    @State private var checkinPrompt: CheckinPrompt?

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
                    ForEach(node.checkins) { prompt in CheckinCard(prompt: prompt) { checkinPrompt = prompt } }
                    problems
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach([Category.trapped, .injured, .medical, .waterMeds, .safe], id: \.self) { c in tile(c) }
                    }
                    Menu {
                        Button { open(.checkin) } label: { Label("Send a check-in", systemImage: Category.checkin.symbol) }
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
        .sheet(item: $checkinPrompt) { prompt in
            CheckinSheet(node: node, prompt: prompt) { checkinPrompt = nil }
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

struct CheckinCard: View {
    let prompt: CheckinPrompt
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge.fill").font(.title2).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Responders are checking on you").font(.headline)
                    Text(prompt.message ?? "Are you OK? Please reply.").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the reply options")
    }
}

/// "I'm OK" / "I need help" / free text reply to a check-in request.
struct CheckinSheet: View {
    @ObservedObject var node: MeshNode
    let prompt: CheckinPrompt
    let done: () -> Void
    @ObservedObject private var haptics = Haptics.shared
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(prompt.message ?? "Are you OK? Please reply.")
                    if let d = prompt.deadlineAtMs {
                        Text("Please answer by \(Date(timeIntervalSince1970: Double(d) / 1000).formatted(date: .omitted, time: .shortened))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button { send("ok", "I'm OK") } label: { Label("I'm OK", systemImage: "hand.thumbsup.fill") }.tint(.green)
                    Button { send("need_help", "I need help") } label: { Label("I need help", systemImage: "exclamationmark.triangle.fill") }.tint(.red)
                }
                .disabled(sending)
                Section("Or write a reply") {
                    TextField("Short message", text: $text, axis: .vertical).lineLimit(1...4)
                    Button("Send reply") { send("other", nil) }.disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Check-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Later") { haptics.play(.sheetDismiss); done() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func send(_ response: String, _ fallbackText: String?) {
        haptics.play(.tap)
        sending = true
        let body = text.trimmingCharacters(in: .whitespaces)
        Task {
            let failure = await node.reply(to: prompt, response: response, text: body.isEmpty ? fallbackText : body)
            await MainActor.run {
                sending = false
                if let failure {
                    haptics.play(.error)
                    error = HomeView.message(for: failure)
                } else {
                    haptics.play(.success)
                    done()
                }
            }
        }
    }
}
#endif
