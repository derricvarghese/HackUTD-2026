#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

struct MessagesView: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @State private var filter: MessageUi.Filter = .all

    private var items: [MessageItem] {
        MessageUi.filter(node.messages.map { MessageUi.map($0, online: node.isGateway) }, filter)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Filter", selection: $filter) {
                        Text("All").tag(MessageUi.Filter.all)
                        Text("Mine").tag(MessageUi.Filter.mine)
                        Text("Received").tag(MessageUi.Filter.received)
                        Text("Held").tag(MessageUi.Filter.held)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: filter) { _ in haptics.play(.select) }
                }
                if items.isEmpty {
                    Section {
                        VStack(spacing: 8) {
                            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
                            Text("No messages here yet").font(.headline)
                            Text("Messages you send, and messages you pass on for others, show up here.")
                                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .accessibilityElement(children: .combine)
                    }
                } else {
                    Section("\(items.count) message\(items.count == 1 ? "" : "s")") {
                        ForEach(items) { item in
                            NavigationLink { MessageDetail(node: node, item: item) } label: { MessageRow(item: item) }
                                .simultaneousGesture(TapGesture().onEnded { haptics.play(.tap) })
                        }
                    }
                }
            }
            .navigationTitle("Messages")
            .refreshable { node.syncNow(); haptics.play(.tap) }
        }
    }
}

struct MessageRow: View {
    let item: MessageItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(Fmt.categoryName(item)).font(.headline)
                if item.critical { Text("CRITICAL").font(.caption2.bold()).foregroundStyle(.red) }
                Spacer()
                Text(Fmt.age(fromMs: item.createdAtMs)).font(.caption).foregroundStyle(.secondary)
            }
            if let text = item.text { Text(text).font(.subheadline) }
            Label(StatusStyle.text(item.status), systemImage: StatusStyle.symbol(item.status))
                .font(.subheadline)
                .foregroundStyle(StatusStyle.color(item.status))
            Text(hopLine).font(.caption.monospaced()).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var hopLine: String {
        let route = item.path.isEmpty ? "origin" : item.path.joined(separator: " > ")
        return "\(item.isOwn ? "yours" : "relayed") · hop \(item.hop)/\(item.maxHops) · \(route)"
    }
}

struct MessageDetail: View {
    @ObservedObject var node: MeshNode
    let item: MessageItem
    @State private var serverPhotos: [CaseImageMeta] = []

    private var queuedPhotos: [QueuedImage] {
        guard item.isOwn else { return [] }
        return node.imageQueue.queuedImages(for: item.id)
    }

    var body: some View {
        List {
            Section {
                Label(StatusStyle.text(item.status), systemImage: StatusStyle.symbol(item.status))
                    .foregroundStyle(StatusStyle.color(item.status))
            }
            Section("Message") {
                LabeledContent("Type", value: Fmt.categoryName(item))
                if let text = item.text { LabeledContent("Details", value: text) }
                if let p = item.people { LabeledContent("People", value: "\(p)") }
                LabeledContent("Created", value: Date(timeIntervalSince1970: Double(item.createdAtMs) / 1000).formatted(date: .abbreviated, time: .standard))
                LabeledContent("Expires", value: Date(timeIntervalSince1970: Double(item.expiresAtMs) / 1000).formatted(date: .abbreviated, time: .shortened))
            }
            if !queuedPhotos.isEmpty {
                Section("Attached photos (\(queuedPhotos.count) queued)") {
                    Text("These photos will upload to responders as soon as this phone reaches the internet.")
                        .font(.footnote).foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(queuedPhotos) { q in
                                VStack(alignment: .leading, spacing: 4) {
                                    if let img = UIImage(data: q.data) {
                                        Image(uiImage: img)
                                            .resizable()
                                            .scaledToFill()
                                            .frame(width: 80, height: 80)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                    if let cap = q.caption {
                                        Text(cap).font(.caption2).lineLimit(2).frame(width: 80, alignment: .leading)
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            if !serverPhotos.isEmpty {
                Section("Uploaded photos (\(serverPhotos.count))") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(serverPhotos) { sp in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Photo \(sp.id.prefix(8))").font(.caption).monospaced()
                                    if let cap = sp.caption {
                                        Text(cap).font(.caption2).lineLimit(2)
                                    }
                                }
                                .padding(8)
                                .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            Section("Route") {
                LabeledContent("Hops", value: "\(item.hop) of \(item.maxHops)")
                LabeledContent("Relays", value: item.path.isEmpty ? "none yet" : item.path.joined(separator: " > "))
                LabeledContent("Reached the server", value: item.uploaded ? "yes" : "not yet")
                LabeledContent("Id", value: item.shortId)
            }
            if !item.isOwn {
                Section { Text("The text of a message from another phone is encrypted. Only the responders can read it; you are just helping it along.").font(.footnote) }
            }
        }
        .navigationTitle(Fmt.categoryName(item))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if item.isOwn && item.uploaded {
                do {
                    serverPhotos = try await node.listCaseImages(sosId: item.id)
                } catch {
                    serverPhotos = []
                }
            }
        }
    }
}

#endif
