#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

// MARK: - Labels

extension MobilityNeed {
    var label: String {
        switch self {
        case .wheelchair: return "Uses a wheelchair"
        case .cannotWalk: return "Cannot walk"
        case .walksWithAid: return "Walks with an aid"
        case .visionImpaired: return "Vision impaired"
        case .hearingImpaired: return "Hearing impaired"
        case .cognitive: return "Memory or cognitive"
        case .oxygenDependent: return "Needs oxygen"
        case .other: return "Other"
        }
    }
}

extension BloodType {
    var label: String { self == .unknown ? "Don't know" : rawValue }
}

extension ProfileSyncStatus {
    var title: String {
        switch self {
        case .empty: return "No profile"
        case .pending: return "Waiting to sync"
        case .synced: return "Synced"
        case .failed: return "Sync failed"
        case .needsConsent: return "Needs your OK"
        }
    }
    var symbol: String {
        switch self {
        case .empty: return "person.crop.circle.badge.plus"
        case .pending: return "clock.arrow.circlepath"
        case .synced: return "checkmark.icloud.fill"
        case .failed: return "exclamationmark.icloud.fill"
        case .needsConsent: return "hand.raised.fill"
        }
    }
    var color: Color {
        switch self {
        case .empty: return .secondary
        case .pending: return .orange
        case .synced: return .green
        case .failed: return .red
        case .needsConsent: return .orange
        }
    }
    /// What VoiceOver and the detail rows say.
    var detail: String {
        switch self {
        case .empty: return "You have not created a profile."
        case .pending: return "Saved on this phone. It is sent to responders' systems as soon as there is internet."
        case .synced: return "Saved on this phone and on the Beacon server."
        case .failed(let why): return "Could not reach the server (\(why)). Beacon will try again."
        case .needsConsent: return "The privacy notice changed. Review it to keep your profile up to date."
        }
    }
}

// MARK: - Sync chip

struct ProfileSyncChip: View {
    let status: ProfileSyncStatus
    var body: some View {
        Label(status.title, systemImage: status.symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(status.color)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(status.color.opacity(0.15), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Profile: \(status.title)")
            .accessibilityHint(status.detail)
    }
}

// MARK: - Consent

/// Plain-language consent. Shown before any profile data is collected and again when the server's consent version changes.
struct ProfileConsentView: View {
    let version: String
    let canSkip: Bool
    let acceptTitle: String
    let onAccept: () -> Void
    let onSkip: () -> Void
    @ObservedObject private var haptics = Haptics.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "person.text.rectangle").font(.system(size: 48)).foregroundStyle(.tint).accessibilityHidden(true)
                Text("Tell responders who you are").font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                Text("If you ever send an SOS, rescuers can help faster when they know who you are and what you may need. Please read how your information is used.")
                point("person.fill", "Your name is shown to responders", "Your name, age range and a few general notes (for example \"needs oxygen\") are visible to every responder and volunteer on the dashboard.")
                point("lock.shield.fill", "Details stay private", "Medical information, phone numbers, your address, appearance and household are only visible to the responder assigned to help you, and to administrators. They are stored encrypted.")
                point("trash.fill", "You stay in control", "Your profile is deleted after the emergency event ends, or at any time when you ask. You can change or delete it in Settings.")
                point("checkmark.circle.fill", "Almost everything is optional", "Only your name is required. Add the rest if you want, and skip what you prefer not to share.")
                Text("Privacy notice \(version)").font(.footnote).foregroundStyle(.secondary)
                    .accessibilityLabel("Privacy notice version \(version)")
                VStack(spacing: 10) {
                    Button {
                        haptics.play(.success)
                        onAccept()
                    } label: {
                        Text(acceptTitle).frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    if canSkip {
                        Button {
                            haptics.play(.tap)
                            onSkip()
                        } label: {
                            Text("Skip for now").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .accessibilityHint("You can create a profile later from the Home screen")
                    }
                }
                .padding(.top, 4)
            }
            .padding(24)
        }
        .onAppear { haptics.prepare() }
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.title3).frame(width: 32).foregroundStyle(.tint).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Flow layout for chips

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, width: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            width = max(width, x - spacing)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

struct Chip: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if selected { Image(systemName: "checkmark").font(.footnote.weight(.bold)) }
                Text(title).font(.subheadline)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(selected ? Color.accentColor.opacity(0.2) : Color(.secondarySystemFill), in: Capsule())
            .overlay(Capsule().stroke(selected ? Color.accentColor : Color.clear, lineWidth: 1.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

// MARK: - Form

/// The profile form. Everything but the name is optional. Validation runs on every change and is shown inline per field.
struct ProfileFormView: View {
    @State private var draft: ProfileDraft
    private let initialDraft: ProfileDraft
    let requireName: Bool
    let saveTitle: String
    let onSave: (UserProfile) -> [String: String]
    let onCancel: (() -> Void)?
    @ObservedObject private var haptics = Haptics.shared
    @State private var showAllErrors = false
    @State private var showDiscardConfirm = false
    @State private var serverIssues: [String: String] = [:]
    @FocusState private var focused: String?

    init(initial: UserProfile?, requireName: Bool, saveTitle: String = "Save profile", onCancel: (() -> Void)? = nil,
         onSave: @escaping (UserProfile) -> [String: String]) {
        var start = initial.map(ProfileDraft.init) ?? ProfileDraft()
        start.setHeightSystem(UnitSettings.current)
        _draft = State(initialValue: start)
        self.initialDraft = start
        self.requireName = requireName
        self.saveTitle = saveTitle
        self.onCancel = onCancel
        self.onSave = onSave
    }

    private var hasUnsavedChanges: Bool { draft != initialDraft }
    private var nowYear: Int { ProfileDerive.utcYear(ms: Int64(Date().timeIntervalSince1970 * 1000)) }
    private var errors: [String: String] { serverIssues.merging(draft.validate(nowYear: nowYear, requireName: requireName)) { _, new in new } }

    /// Required-name hint only after a save attempt; everything else as soon as the text is wrong.
    private func error(_ path: String) -> String? {
        if path == "full_name" && !showAllErrors && draft.fullName.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
        return errors[path]
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: draft.completeness)
                    Text("\(Int((draft.completeness * 100).rounded())) percent complete. Only your name is required.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Profile progress \(Int((draft.completeness * 100).rounded())) percent. Only your name is required.")
            }
            identity
            appearance
            medical
            household
            contact
            notes
            Section {
                Button {
                    save()
                } label: {
                    Text(saveTitle).frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                }
                .buttonStyle(.borderedProminent)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                if showAllErrors && !errors.isEmpty {
                    Text("Please fix the highlighted fields.").font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { haptics.play(.tap); focused = nil }
            }
            ToolbarItem(placement: .cancellationAction) {
                if let onCancel {
                    Button("Cancel") {
                        if hasUnsavedChanges {
                            haptics.play(.warning)
                            showDiscardConfirm = true
                        } else {
                            haptics.play(.sheetDismiss)
                            onCancel()
                        }
                    }
                }
            }
        }
        .confirmationDialog("Discard Unsaved Changes?", isPresented: $showDiscardConfirm, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) {
                haptics.play(.sheetDismiss)
                onCancel?()
            }
            Button("Keep Editing", role: .cancel) { }
        } message: {
            Text("You have unsaved changes to your profile that will be lost.")
        }
        .interactiveDismissDisabled(hasUnsavedChanges)
        .onAppear { haptics.prepare() }
    }

    // MARK: Sections

    private var identity: some View {
        Section("Identity") {
            field("Full name", text: $draft.fullName, path: "full_name", required: requireName, content: .name, capitalization: .words)
            field("Preferred name (optional)", text: $draft.preferredName, path: "preferred_name", content: .nickname, capitalization: .words)
            field("Year of birth (optional)", text: $draft.birthYear, path: "birth_year", keyboard: .numberPad)
            field("Languages you speak (optional)", text: $draft.languages, path: "languages", capitalization: .words,
                  hint: "Separate with commas, for example Spanish, English")
            field("Your phone number (optional)", text: $draft.phone, path: "phone", keyboard: .phonePad, content: .telephoneNumber)
        }
    }

    private var appearance: some View {
        Section {
            Picker("Height unit", selection: Binding(get: { draft.heightSystem }, set: { draft.setHeightSystem($0); haptics.play(.select) })) {
                Text("cm").tag(UnitSystem.metric)
                Text("ft/in").tag(UnitSystem.imperial)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Height unit")
            if draft.heightSystem == .metric {
                field("Height in cm (optional)", text: $draft.heightCm, path: "appearance.height_cm", keyboard: .numberPad)
            } else {
                heightFeetInches
            }
            field("Hair (optional)", text: $draft.hair, path: "appearance.hair", multiline: true)
            field("Clothing you usually wear (optional)", text: $draft.clothing, path: "appearance.clothing", multiline: true)
            field("Scars, tattoos, glasses (optional)", text: $draft.distinguishingMarks, path: "appearance.distinguishing_marks", multiline: true)
        } header: { Text("Appearance") } footer: { Text("Helps rescuers recognise you.") }
    }

    /// Height typed as feet and inches. Stored as centimetres by `ProfileDraft`; the error for the pair shows below.
    private var heightFeetInches: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Height (optional)").font(.subheadline).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    TextField("Feet", text: Binding(get: { draft.heightFeet }, set: { draft.editHeightFeet($0) }))
                        .keyboardType(.numberPad)
                        .focused($focused, equals: "height.feet")
                        .accessibilityLabel("Feet, 1 to 8")
                    Text("feet, 1 to 8").font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    TextField("Inches", text: Binding(get: { draft.heightInches }, set: { draft.editHeightInches($0) }))
                        .keyboardType(.numberPad)
                        .focused($focused, equals: "height.inches")
                        .accessibilityLabel("Inches, 0 to 11")
                    Text("inches, 0 to 11").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let e = error("appearance.height_cm") {
                Label(e, systemImage: "exclamationmark.circle.fill").font(.footnote).foregroundStyle(.red)
                    .accessibilityLabel("Problem: \(e)")
            }
        }
    }

    private var medical: some View {
        Section {
            field("Medical conditions (optional)", text: $draft.conditions, path: "medical.conditions", multiline: true,
                  hint: "Separate with commas")
            field("Medications (optional)", text: $draft.medications, path: "medical.medications", multiline: true, hint: "Separate with commas")
            field("Allergies (optional)", text: $draft.allergies, path: "medical.allergies", multiline: true, hint: "Separate with commas")
            Picker("Blood type", selection: Binding(get: { draft.bloodType }, set: { draft.bloodType = $0; haptics.play(.select) })) {
                Text("Not set").tag(BloodType?.none)
                ForEach(BloodType.allCases, id: \.self) { Text($0.label).tag(BloodType?.some($0)) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Mobility and senses").font(.subheadline.weight(.semibold))
                FlowLayout(spacing: 8) {
                    ForEach(MobilityNeed.allCases, id: \.self) { need in
                        Chip(title: need.label, selected: draft.needs.contains(need)) {
                            if draft.needs.contains(need) { draft.needs.remove(need) } else { draft.needs.insert(need) }
                            haptics.play(.toggle)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
            field("Notes about mobility (optional)", text: $draft.mobilityNotes, path: "mobility.notes", multiline: true)
        } header: { Text("Medical and mobility") } footer: { Text("Only the responder assigned to help you and administrators can see this.") }
    }

    private var household: some View {
        Section {
            field("People in your home, including you", text: $draft.peopleCount, path: "household.people_count", keyboard: .numberPad)
            field("Of them, children", text: $draft.children, path: "household.children", keyboard: .numberPad)
            field("Of them, elderly", text: $draft.elderly, path: "household.elderly", keyboard: .numberPad)
            if let e = error("household") { Text(e).font(.footnote).foregroundStyle(.red) }
            ForEach($draft.pets) { $pet in
                let index = draft.pets.firstIndex(where: { $0.id == pet.id }) ?? 0
                HStack(spacing: 12) {
                    TextField("Pet (dog, cat...)", text: $pet.kind).accessibilityLabel("Pet kind")
                    TextField("How many", text: $pet.count).keyboardType(.numberPad).frame(maxWidth: 90).accessibilityLabel("Number of this kind of pet")
                }
                if let e = errors["household.pets.\(index).kind"] ?? errors["household.pets.\(index).count"] {
                    Text(e).font(.footnote).foregroundStyle(.red)
                }
            }
            .onDelete { offsets in draft.pets.remove(atOffsets: offsets); haptics.play(.warning) }
            if draft.pets.count < ProfileLimits.pets {
                Button {
                    haptics.play(.tap)
                    draft.pets.append(.init())
                } label: { Label("Add a pet", systemImage: "plus.circle") }
            }
        } header: { Text("Household") } footer: { Text("Rescuers may need to look for children, elderly relatives and pets.") }
    }

    private var contact: some View {
        Section {
            field("Home address (optional)", text: $draft.homeAddress, path: "home_address", content: .fullStreetAddress, multiline: true)
            field("Contact name", text: $draft.contactName, path: "emergency_contact.name", content: .name, capitalization: .words)
            field("Contact phone", text: $draft.contactPhone, path: "emergency_contact.phone", keyboard: .phonePad, content: .telephoneNumber)
            field("Relationship (for example mother, friend)", text: $draft.contactRelationship, path: "emergency_contact.relationship", capitalization: .never)
        } header: { Text("Emergency contact") } footer: { Text("Add all three or none.") }
    }

    private var notes: some View {
        Section {
            TextField("Anything else rescuers should know (optional)", text: $draft.notes, axis: .vertical)
                .lineLimit(3...8)
                .focused($focused, equals: "notes")
                .accessibilityLabel("Notes")
            HStack {
                if let e = error("notes") { Text(e).font(.footnote).foregroundStyle(.red) }
                Spacer()
                Text("\(draft.notes.utf16.count) of \(ProfileLimits.notes)").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            }
        } header: { Text("Notes") }
    }

    // MARK: Field

    @ViewBuilder
    private func field(_ title: String, text: Binding<String>, path: String, required: Bool = false, keyboard: UIKeyboardType = .default,
                       content: UITextContentType? = nil, capitalization: TextInputAutocapitalization = .sentences,
                       multiline: Bool = false, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if multiline {
                    TextField(title, text: text, axis: .vertical).lineLimit(1...4)
                } else {
                    TextField(title, text: text)
                }
            }
            .keyboardType(keyboard)
            .textContentType(content)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled(keyboard != .default || content != nil)
            .focused($focused, equals: path)
            .accessibilityLabel(required ? "\(title), required" : title)
            .accessibilityHint(hint ?? "")
            if let hint, error(path) == nil { Text(hint).font(.caption).foregroundStyle(.secondary) }
            if let e = error(path) {
                Label(e, systemImage: "exclamationmark.circle.fill").font(.footnote).foregroundStyle(.red)
                    .accessibilityLabel("Problem: \(e)")
            }
        }
    }

    private func save() {
        showAllErrors = true
        let local = draft.validate(nowYear: nowYear, requireName: requireName)
        guard local.isEmpty else {
            haptics.play(.error)
            focused = local.keys.sorted().first
            return
        }
        let issues = onSave(draft.toProfile())
        if issues.isEmpty { haptics.play(.success) } else { serverIssues = issues; haptics.play(.error) }
    }
}

// MARK: - First-run / "complete your profile" flow

/// Consent first, then the form. Used full screen at first launch and in a sheet from the Home banner.
struct ProfileOnboardingView: View {
    @ObservedObject var node: MeshNode
    /// Non-nil when shown as a sheet that can be dismissed.
    var onClose: (() -> Void)?
    @State private var consented = false
    @ObservedObject private var haptics = Haptics.shared

    var body: some View {
        NavigationStack {
            Group {
                if node.profileStatus == .needsConsent || !consented {
                    ProfileConsentView(version: node.profileConsentVersion,
                                       canSkip: true,
                                       acceptTitle: node.userProfile == nil ? "I agree, continue" : "I agree",
                                       onAccept: accept, onSkip: skip)
                } else {
                    ProfileFormView(initial: node.userProfile, requireName: true, saveTitle: "Save and continue",
                                    onCancel: nil) { p in
                        let issues = node.saveProfile(p, consentVersion: node.profileConsentVersion)
                        if issues.isEmpty { onClose?() }
                        return issues
                    }
                    .navigationTitle("Your profile")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(onClose != nil ? "Close" : "Skip for now") { skip() }
                        }
                    }
                }
            }
        }
        .interactiveDismissDisabled(onClose == nil)
    }

    private func accept() {
        if node.userProfile != nil && node.profileStatus == .needsConsent {
            // existing profile, the notice changed: accepting is the whole step
            node.renewProfileConsent()
            onClose?()
        } else {
            consented = true
        }
    }

    private func skip() {
        haptics.play(.sheetDismiss)
        if let onClose { onClose() } else { node.skipProfile() }
    }
}

// MARK: - Home

/// Banner + status chip for the Home screen.
struct ProfileHomeSection: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @State private var showFlow = false

    private var isFailed: Bool { if case .failed = node.profileStatus { return true } else { return false } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if node.userProfile == nil || node.profileStatus == .needsConsent, !node.profileBannerDismissed {
                HStack(alignment: .top, spacing: 4) {
                Button {
                    haptics.play(.sheetOpen)
                    showFlow = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: node.profileStatus == .needsConsent ? "hand.raised.fill" : "person.crop.circle.badge.exclamationmark")
                            .font(.title2).foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(node.profileStatus == .needsConsent ? "Review the privacy notice" : "Complete your profile").font(.headline)
                            Text(node.profileStatus == .needsConsent ? "It changed. Your profile stays as it is until you agree."
                                 : node.profileNudgeProminent ? "Responders can find and help you faster. It takes a minute, and you can skip it."
                                 : "Your name and a few details help rescuers find and help you faster.")
                                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color.accentColor.opacity(node.profileNudgeProminent ? 0.22 : 0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.accentColor.opacity(node.profileNudgeProminent ? 0.6 : 0), lineWidth: 1.5))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the profile form")
                Button {
                    haptics.play(.tap)
                    withAnimation { node.dismissProfileBanner() }
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss until next launch")
                }
            } else if node.profileStatus != .synced {
                Button {
                    if isFailed { haptics.play(.tap); node.retryProfileSync() }
                } label: { ProfileSyncChip(status: node.profileStatus) }
                .buttonStyle(.plain)
                .accessibilityHint(isFailed ? "Double tap to retry" : "")
            }
        }
        .sheet(isPresented: $showFlow) {
            ProfileOnboardingView(node: node) { showFlow = false }
        }
    }
}

// MARK: - Settings: view / edit

struct MyProfileView: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @State private var editing = false
    @AppStorage(UnitPreference.storageKey) private var unitPref = UnitPreference.automatic.rawValue

    var body: some View {
        List {
            if let p = node.userProfile {
                Section {
                    row("Full name", p.fullName)
                    row("Preferred name", p.preferredName)
                    row("Year of birth", p.birthYear.map(String.init))
                    row("Languages", p.languages.joined(separator: ", "))
                    row("Phone", p.phone)
                }
                if !p.appearance.isEmpty {
                    Section("Appearance") {
                        row("Height", p.appearance.heightCm.map { Units.height(cm: $0, system: UnitSettings.system(for: unitPref)) })
                        row("Hair", p.appearance.hair); row("Clothing", p.appearance.clothing); row("Marks", p.appearance.distinguishingMarks)
                    }
                }
                if !p.medical.isEmpty || !p.mobility.isEmpty {
                    Section("Medical and mobility") {
                        row("Conditions", p.medical.conditions.joined(separator: ", "))
                        row("Medications", p.medical.medications.joined(separator: ", "))
                        row("Allergies", p.medical.allergies.joined(separator: ", "))
                        row("Blood type", p.medical.bloodType?.label)
                        row("Needs", p.mobility.needs.map(\.label).joined(separator: ", "))
                        row("Mobility notes", p.mobility.notes)
                    }
                }
                if !p.household.isEmpty {
                    Section("Household") {
                        row("People", p.household.peopleCount.map(String.init))
                        row("Children", p.household.children.map(String.init)); row("Elderly", p.household.elderly.map(String.init))
                        row("Pets", p.household.pets.map { "\($0.count.map { "\($0) " } ?? "")\($0.kind)" }.joined(separator: ", "))
                    }
                }
                if !p.emergencyContact.isEmpty || !p.homeAddress.isEmpty || !p.notes.isEmpty {
                    Section("Contact and notes") {
                        row("Home address", p.homeAddress)
                        row("Emergency contact", p.emergencyContact.isEmpty ? nil : "\(p.emergencyContact.name) (\(p.emergencyContact.relationship))")
                        row("Contact phone", p.emergencyContact.phone)
                        row("Notes", p.notes)
                    }
                }
                Section("Sharing") {
                    HStack { ProfileSyncChip(status: node.profileStatus); Spacer() }
                    Text("Visible to all responders and volunteers: name, age range and general notes. Everything else is only visible to the responder assigned to help you and to administrators.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Not set up", systemImage: "person.crop.circle.badge.questionmark").font(.headline)
                    Text("Responders can find and help you faster with your name and a few details. It is optional.").font(.subheadline).foregroundStyle(.secondary)
                    Button("Set up") { haptics.play(.sheetOpen); editing = true }.buttonStyle(.borderedProminent)
                }
                .accessibilityElement(children: .contain)
            }
        }
        .navigationTitle("My profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(node.userProfile == nil ? "Set up" : "Edit") { haptics.play(.sheetOpen); editing = true }
            }
        }
        .sheet(isPresented: $editing) {
            if node.userProfile == nil || node.profileStatus == .needsConsent {
                ProfileOnboardingView(node: node) { editing = false }
            } else {
                NavigationStack {
                    ProfileFormView(initial: node.userProfile, requireName: true, saveTitle: "Save changes", onCancel: { editing = false }) { p in
                        let issues = node.saveProfile(p, consentVersion: node.acceptedConsent?.version ?? node.profileConsentVersion)
                        if issues.isEmpty { editing = false }
                        return issues
                    }
                    .navigationTitle("Edit profile")
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// The Settings section: My profile, sync row with Retry, consent info and erasure.
struct ProfileSettingsSection: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @State private var confirmDelete = false

    var body: some View {
        Section {
            NavigationLink(value: SettingsRoute.myProfile) {
                Label("My profile", systemImage: "person.crop.circle")
                if node.userProfile == nil { Text("Not set up").font(.footnote).foregroundStyle(.secondary) }
            }
            HStack {
                Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                Spacer()
                ProfileSyncChip(status: node.profileDeleting ? .pending : node.profileStatus)
            }
            .accessibilityElement(children: .combine)
            if node.profileDeleting {
                Text("Deleted on this phone. Removing it from the server as soon as there is internet.").font(.footnote).foregroundStyle(.secondary)
            }
            if node.userProfile != nil, node.profileStatus != .synced {
                Button("Retry now") { haptics.play(.tap); node.retryProfileSync() }
            }
            if let c = node.acceptedConsent, node.userProfile != nil {
                LabeledContent("Privacy notice", value: "\(c.version), \(Fmt.time(Date(timeIntervalSince1970: Double(c.acceptedAtMs) / 1000)))")
                    .accessibilityElement(children: .combine)
            }
            if node.userProfile != nil {
                Button("Delete my profile", role: .destructive) { haptics.play(.warning); confirmDelete = true }
            }
        } header: {
            Text("Profile")
        } footer: {
            Text("Your profile is deleted automatically after the emergency event. Deleting it here also removes it from the server.")
        }
        .confirmationDialog("Delete your profile?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete profile", role: .destructive) { haptics.play(.success); node.deleteProfile() }
            Button("Keep it", role: .cancel) { haptics.play(.tap) }
        } message: {
            Text("Your name and details are erased from this phone and from the Beacon server. SOS messages you already sent are not affected.")
        }
    }
}
#endif
