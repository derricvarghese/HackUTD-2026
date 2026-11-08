#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
#if canImport(PhotosUI)
import PhotosUI
#endif
import SwiftUI
import UIKit

/// Confirmation sheet: optional note, head count, and up to 6 photos, then a hold-to-send or plain button.
struct SosSheet: View {
    struct AttachedPhoto: Identifiable {
        let id = UUID()
        var data: Data
        var preview: UIImage
        var caption: String = ""
    }

    @ObservedObject var node: MeshNode
    let category: Category
    /// nil = dismissed without sending.
    let finish: (SendResult?) -> Void

    @ObservedObject private var haptics = Haptics.shared
    @State private var note = ""
    @State private var people = 1
    @State private var attachedPhotos: [AttachedPhoto] = []
    #if canImport(PhotosUI)
    @State private var selectedPickerItems: [PhotosPickerItem] = []
    #endif
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
                Section("Photos (optional, max 6)") {
                    if !attachedPhotos.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(attachedPhotos.indices, id: \.self) { idx in
                                    VStack(alignment: .leading, spacing: 4) {
                                        ZStack(alignment: .topTrailing) {
                                            Image(uiImage: attachedPhotos[idx].preview)
                                                .resizable()
                                                .scaledToFill()
                                                .frame(width: 80, height: 80)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                            Button {
                                                haptics.play(.tap)
                                                attachedPhotos.remove(at: idx)
                                            } label: {
                                                Image(systemName: "xmark.circle.fill")
                                                    .foregroundStyle(.white, .red)
                                                    .font(.title3)
                                            }
                                            .offset(x: 6, y: -6)
                                        }
                                        TextField("Caption", text: $attachedPhotos[idx].caption)
                                            .font(.caption2)
                                            .frame(width: 80)
                                            .textFieldStyle(.roundedBorder)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    if attachedPhotos.count < 6 {
                        #if canImport(PhotosUI)
                        PhotosPicker(
                            selection: $selectedPickerItems,
                            maxSelectionCount: 6 - attachedPhotos.count,
                            matching: .images
                        ) {
                            Label(attachedPhotos.isEmpty ? "Attach photos (up to 6)" : "Add more photos", systemImage: "photo.badge.plus")
                        }
                        .onChange(of: selectedPickerItems) { items in
                            loadPickerItems(items)
                        }
                        #endif
                    }
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

    #if canImport(PhotosUI)
    private func loadPickerItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            for item in items {
                guard attachedPhotos.count < 6 else { break }
                if let rawData = try? await item.loadTransferable(type: Data.self),
                   let processed = ImageProcessor.process(data: rawData),
                   let preview = UIImage(data: processed) {
                    await MainActor.run {
                        if attachedPhotos.count < 6 {
                            attachedPhotos.append(AttachedPhoto(data: processed, preview: preview))
                        }
                    }
                }
            }
            await MainActor.run {
                selectedPickerItems = []
                haptics.play(.select)
            }
        }
    }
    #endif

    private func send() {
        noteFocused = false
        let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageCount = attachedPhotos.count
        let result = node.sendSOS(
            category,
            text: n.isEmpty ? nil : n,
            people: (people > 1 || category != .safe) ? people : nil,
            imageCount: imageCount > 0 ? imageCount : nil
        )
        if case .sent(let msg) = result {
            for photo in attachedPhotos {
                try? node.imageQueue.enqueue(
                    sosId: msg.id,
                    data: photo.data,
                    caption: photo.caption.isEmpty ? nil : photo.caption
                )
            }
        }
        finish(result)
    }
}
#endif
