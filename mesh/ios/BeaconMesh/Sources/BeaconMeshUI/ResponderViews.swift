#if canImport(UIKit) && canImport(SwiftUI) && canImport(MapKit) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import MapKit
import SwiftUI
import UIKit

// MARK: - Session

/// Responder login + the live list of open cases. Polls the server while the Responder tab is on screen.
@MainActor
final class ResponderSession: ObservableObject {
    @Published private(set) var account: ResponderAccount?
    @Published private(set) var cases: [ResponderCase] = []
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var loading = false
    @Published var error: String?

    let client: ResponderClient

    init(baseURL: String) {
        client = ResponderClient(baseURL: baseURL, store: KeychainResponderTokenStore())
        account = client.account
    }

    func login(username: String, password: String) async {
        loading = true
        defer { loading = false }
        do {
            account = try await client.login(username: username, password: password)
            error = nil
            await refresh()
        } catch let e as ResponderError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    func logout() async {
        await client.logout()
        account = nil
        cases = []
        lastUpdated = nil
    }

    func refresh() async {
        guard account != nil else { return }
        do {
            cases = try await client.openCases()
            lastUpdated = Date()
            error = nil
        } catch let e as ResponderError {
            handle(e)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Claim, then reload so the case comes back with its exact location.
    func claim(_ c: ResponderCase) async {
        await run { _ = try await self.client.claim(c.id) }
    }

    func advance(_ c: ResponderCase, to status: String, outcome: String? = nil) async {
        guard let a = c.assignmentId else { return }
        await run { try await self.client.updateAssignment(a, status: status, outcome: outcome) }
    }

    /// Polls every 15 s until the task is cancelled (the tab disappears).
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 15_000_000_000)
        }
    }

    private func run(_ op: @escaping () async throws -> Void) async {
        loading = true
        defer { loading = false }
        do {
            try await op()
            error = nil
        } catch let e as ResponderError {
            handle(e)
        } catch {
            self.error = error.localizedDescription
        }
        await refresh()
    }

    private func handle(_ e: ResponderError) {
        if e == .signedOut { account = nil; cases = [] }
        error = e.message
    }
}

// MARK: - Map items

/// Something drawn on the responder map: a server case, or an SOS this phone heard over Bluetooth.
struct MapTarget: Identifiable, Equatable {
    enum Source: Equatable { case server, mesh }
    var id: String
    var source: Source
    var category: Category
    var title: String
    var lat: Double
    var lng: Double
    var radiusM: Double
    var exact: Bool
    var mine: Bool

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
}

extension ResponderCase {
    var uiCategory: Category { Category.fromWire(category) ?? .other }

    var displayName: String { name ?? uiCategory.title }

    func isMine(_ account: ResponderAccount?) -> Bool {
        guard let account, let assigneeId else { return false }
        return assigneeId == account.id && assignmentStatus.map { !["released", "cancelled", "resolved"].contains($0) } ?? false
    }

    func target(account: ResponderAccount?) -> MapTarget {
        MapTarget(id: id, source: .server, category: uiCategory, title: displayName, lat: lat, lng: lng,
                  radiusM: hasExactLocation ? 40 : max(radiusM, 100), exact: hasExactLocation, mine: isMine(account))
    }
}

enum ResponderText {
    static func status(_ s: String) -> String {
        switch s {
        case "reported": return "Waiting for help"
        case "assigned": return "Claimed"
        case "en_route": return "Responder en route"
        case "on_scene": return "Responder on scene"
        case "resolved": return "Resolved"
        default: return s.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func flag(_ f: String) -> String {
        switch f {
        case "mobility": return "Mobility needs"
        case "medical": return "Medical"
        case "elderly": return "Elderly"
        case "child": return "Child"
        case "oxygen": return "Oxygen"
        case "sensory": return "Vision/hearing"
        case "cognitive": return "Cognitive"
        default: return f.capitalized
        }
    }

    static func ago(_ d: Date?) -> String {
        guard let d else { return "unknown" }
        if Date().timeIntervalSince(d) < 10 { return "just now" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: Date())
    }
}

// MARK: - Tab root

struct ResponderTab: View {
    @ObservedObject var node: MeshNode
    @StateObject private var session: ResponderSession

    init(node: MeshNode) {
        self.node = node
        _session = StateObject(wrappedValue: ResponderSession(baseURL: node.backendURL))
    }

    var body: some View {
        if session.account == nil {
            ResponderLoginView(session: session, host: node.backendHost)
        } else {
            ResponderDashboard(node: node, session: session)
        }
    }
}

// MARK: - Login

struct ResponderLoginView: View {
    @ObservedObject var session: ResponderSession
    let host: String
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case user, pass }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "cross.case.fill").font(.largeTitle).foregroundStyle(.red)
                        Text("First responder mode").font(.title2.weight(.semibold))
                        Text("See where people have asked for help on a map, claim a case to get their exact location, and update your status as you go.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .user)
                        .submitLabel(.next)
                        .onSubmit { focus = .pass }
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .pass)
                        .submitLabel(.go)
                        .onSubmit(signIn)
                } header: {
                    Text("Responder account")
                } footer: {
                    Text("Use your Beacon dashboard login. Server: \(host)")
                }
                if let error = session.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                }
                Section {
                    Button(action: signIn) {
                        HStack {
                            Spacer()
                            if session.loading { ProgressView() } else { Text("Sign in").fontWeight(.semibold) }
                            Spacer()
                        }
                    }
                    .disabled(username.isEmpty || password.isEmpty || session.loading)
                }
            }
            .navigationTitle("Responder")
        }
    }

    private func signIn() {
        guard !username.isEmpty, !password.isEmpty else { return }
        focus = nil
        Task { await session.login(username: username.trimmingCharacters(in: .whitespaces), password: password) }
    }
}

// MARK: - Dashboard

struct ResponderDashboard: View {
    @ObservedObject var node: MeshNode
    @ObservedObject var session: ResponderSession
    @State private var selectedId: String?
    @State private var showMesh = true
    @State private var fitToken = 0

    /// SOS messages this phone heard over Bluetooth that are still live: only the ~1 km routing cell is readable.
    private var meshTargets: [MapTarget] {
        guard showMesh else { return [] }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let serverIds = Set(session.cases.map(\.id))
        return node.messages.compactMap { m in
            let e = m.envelope
            guard !m.isOwn, e.kind == "sos", e.expiresAtMs > nowMs, !serverIds.contains(m.id),
                  let approx = e.routing["approx"], let lat = approx["lat"]?.doubleValue, let lng = approx["lng"]?.doubleValue else { return nil }
            let cat = Category.fromWire(e.category) ?? .other
            return MapTarget(id: "mesh-" + m.id, source: .mesh, category: cat, title: "\(cat.title) (Bluetooth)",
                             lat: lat, lng: lng, radiusM: approx["radius_m"]?.doubleValue ?? 1000, exact: false, mine: false)
        }
    }

    private var targets: [MapTarget] { session.cases.map { $0.target(account: session.account) } + meshTargets }

    private var selectedCase: ResponderCase? { session.cases.first { $0.id == selectedId } }
    private var selectedMesh: MapTarget? { meshTargets.first { $0.id == selectedId } }

    private var sortedCases: [ResponderCase] {
        session.cases.sorted { a, b in
            let am = a.isMine(session.account), bm = b.isMine(session.account)
            if am != bm { return am }
            return a.score > b.score
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack(alignment: .topLeading) {
                    ResponderMapView(targets: targets, selectedId: $selectedId, fitToken: fitToken)
                    legend.padding(10)
                }
                .frame(maxHeight: .infinity)

                List {
                    Section {
                        if session.cases.isEmpty && meshTargets.isEmpty {
                            Text(session.lastUpdated == nil ? "Loading cases…" : "No open cases right now.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(sortedCases) { c in
                            Button { selectedId = c.id } label: { CaseRow(c: c, mine: c.isMine(session.account)) }
                                .buttonStyle(.plain)
                        }
                        ForEach(meshTargets) { t in
                            Button { selectedId = t.id } label: { MeshRow(t: t) }.buttonStyle(.plain)
                        }
                    } header: {
                        HStack {
                            Text("\(session.cases.count) open case\(session.cases.count == 1 ? "" : "s")")
                            Spacer()
                            if let u = session.lastUpdated { Text("Updated \(ResponderText.ago(u))") }
                        }
                    } footer: {
                        if let e = session.error { Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    }
                }
                .listStyle(.insetGrouped)
                .frame(height: 300)
            }
            .navigationTitle("Responder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { fitToken += 1 } label: { Image(systemName: "scope") }
                        .accessibilityLabel("Show all cases")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    HStack {
                        if session.loading { ProgressView() }
                        Button { Task { await session.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("Refresh")
                        Menu {
                            if let a = session.account { Text("\(a.name) (\(a.role))") }
                            Toggle("Show Bluetooth reports", isOn: $showMesh)
                            Button("Sign out", role: .destructive) { Task { await session.logout() } }
                        } label: { Image(systemName: "person.crop.circle") }
                    }
                }
            }
            .sheet(isPresented: Binding(get: { selectedCase != nil }, set: { if !$0 { selectedId = nil } })) {
                if let c = selectedCase {
                    CaseDetailSheet(c: c, mine: c.isMine(session.account), session: session)
                        .presentationDetents([.medium, .large])
                }
            }
            .alert(selectedMesh?.title ?? "", isPresented: Binding(get: { selectedMesh != nil }, set: { if !$0 { selectedId = nil } })) {
                Button("OK", role: .cancel) { selectedId = nil }
            } message: {
                Text("This phone heard this SOS over Bluetooth. Its exact location is encrypted for the server, so only the ~1 km area is shown. It will appear as a case once any phone uploads it.")
            }
        }
        .task { await session.poll() }
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Circle = person is somewhere inside", systemImage: "circle.dashed")
            Label("Claim a case to see the exact spot", systemImage: "mappin.and.ellipse")
        }
        .font(.caption2)
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct CaseRow: View {
    let c: ResponderCase
    let mine: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: c.uiCategory.symbol)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(c.uiCategory.color, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(c.displayName).font(.headline).lineLimit(1)
                    if mine { Text("YOURS").font(.caption2.weight(.bold)).padding(.horizontal, 5).padding(.vertical, 1).background(.blue, in: Capsule()).foregroundStyle(.white) }
                    if c.silent { Image(systemName: "bell.slash.fill").foregroundStyle(.orange).font(.caption) }
                }
                Text("\(c.uiCategory.title) · \(ResponderText.status(c.status)) · \(ResponderText.ago(c.lastHeardAt))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text("\(c.score)").font(.headline.monospacedDigit()).foregroundStyle(c.score >= 70 ? .red : .primary)
                .accessibilityLabel("Priority \(c.score)")
        }
        .contentShape(Rectangle())
    }
}

struct MeshRow: View {
    let t: MapTarget

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .foregroundStyle(t.category.color)
                .frame(width: 36, height: 36)
                .overlay(Circle().strokeBorder(t.category.color, style: StrokeStyle(lineWidth: 2, dash: [4, 3])))
            VStack(alignment: .leading, spacing: 2) {
                Text(t.title).font(.headline)
                Text("Heard nearby over Bluetooth, not on the server yet").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Case detail

struct CaseDetailSheet: View {
    let c: ResponderCase
    let mine: Bool
    @ObservedObject var session: ResponderSession
    @Environment(\.dismiss) private var dismiss
    @State private var confirmResolve = false

    private var claimedByOther: Bool { c.assigneeId != nil && !mine && c.assignmentStatus.map { !["released", "cancelled"].contains($0) } ?? false }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: c.uiCategory.symbol).font(.title2).foregroundStyle(.white)
                            .frame(width: 48, height: 48).background(c.uiCategory.color, in: Circle())
                        VStack(alignment: .leading) {
                            Text(c.displayName).font(.title3.weight(.semibold))
                            Text("\(c.uiCategory.title) · priority \(c.score)").foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    if mine {
                        if c.assignmentStatus == "assigned" { action("I'm on my way", "car.fill") { await session.advance(c, to: "en_route") } }
                        if c.assignmentStatus == "assigned" || c.assignmentStatus == "en_route" {
                            action("I'm on scene", "figure.wave") { await session.advance(c, to: "on_scene") }
                        }
                        Button { confirmResolve = true } label: { Label("Resolve case", systemImage: "checkmark.seal.fill") }
                        action("Release case", "arrow.uturn.backward", role: .destructive) { await session.advance(c, to: "released") }
                    } else if claimedByOther {
                        Label("Claimed by \(c.assigneeName ?? "another responder")", systemImage: "person.fill.checkmark").foregroundStyle(.secondary)
                    } else {
                        action("Claim this case", "hand.raised.fill") { await session.claim(c) }
                    }
                } footer: {
                    if let e = session.error { Text(e).foregroundStyle(.orange) }
                }
                Section("Location") {
                    if c.hasExactLocation {
                        Label(String(format: "Exact GPS: %.5f, %.5f", c.lat, c.lng), systemImage: "mappin.circle.fill")
                        Button { openDirections() } label: { Label("Directions in Maps", systemImage: "car.fill") }
                    } else {
                        Label("Somewhere within \(Int(c.radiusM)) m of the circle's centre", systemImage: "circle.dashed")
                        if !claimedByOther { Text("Claim the case to get the exact spot.").font(.footnote).foregroundStyle(.secondary) }
                        Button { openDirections() } label: { Label("Directions to the area", systemImage: "car") }
                    }
                }

                Section("Details") {
                    if let t = c.text, !t.isEmpty { Text("“\(t)”") }
                    if let p = c.peopleCount { LabeledContent("People", value: "\(p)") }
                    if let a = c.ageRange { LabeledContent("Age", value: a) }
                    if !c.flags.isEmpty { LabeledContent("Needs", value: c.flags.map(ResponderText.flag).joined(separator: ", ")) }
                    LabeledContent("Status", value: ResponderText.status(c.status))
                    LabeledContent("Last heard", value: ResponderText.ago(c.lastHeardAt))
                    if c.silent { Label("Gone quiet since the last check-in", systemImage: "bell.slash.fill").foregroundStyle(.orange) }
                    if c.channel == "mesh", let h = c.hopCount, let m = c.maxHops { LabeledContent("Relayed", value: "\(h) of \(m) phone hops") }
                }

            }
            .navigationTitle("Case")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("How did it end?", isPresented: $confirmResolve, titleVisibility: .visible) {
                ForEach([("rescued", "Rescued"), ("safe_on_arrival", "Safe on arrival"), ("referred", "Referred"),
                         ("unreachable", "Couldn't reach them"), ("false_alarm", "False alarm")], id: \.0) { o in
                    Button(o.1) { Task { await session.advance(c, to: "resolved", outcome: o.0); dismiss() } }
                }
            }
        }
    }

    private func action(_ title: String, _ icon: String, role: ButtonRole? = nil, _ op: @escaping () async -> Void) -> some View {
        Button(role: role) { Task { await op() } } label: { Label(title, systemImage: icon) }
            .disabled(session.loading)
    }

    private func openDirections() {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: c.lat, longitude: c.lng)))
        item.name = c.displayName
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

// MARK: - Map (MKMapView, so it works on iOS 16)

final class TargetCircle: MKCircle {
    var target: MapTarget!
}

final class TargetPin: NSObject, MKAnnotation {
    let target: MapTarget
    init(_ t: MapTarget) { target = t }
    var coordinate: CLLocationCoordinate2D { target.coordinate }
    var title: String? { target.title }
}

struct ResponderMapView: UIViewRepresentable {
    var targets: [MapTarget]
    @Binding var selectedId: String?
    var fitToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.showsUserLocation = true
        map.pointOfInterestFilter = .excludingAll
        map.register(MKMarkerAnnotationView.self, forAnnotationViewWithReuseIdentifier: "pin")
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        map.addGestureRecognizer(tap)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if c.drawn != targets {
            map.removeOverlays(map.overlays)
            map.removeAnnotations(map.annotations.filter { $0 is TargetPin })
            // Biggest circles first so smaller (more precise) ones sit on top.
            for t in targets.sorted(by: { $0.radiusM > $1.radiusM }) {
                let circle = TargetCircle(center: t.coordinate, radius: t.radiusM)
                circle.target = t
                map.addOverlay(circle)
                map.addAnnotation(TargetPin(t))
            }
            if c.drawn.isEmpty && !targets.isEmpty { fitWhenSized(map, tries: 20) }
            c.drawn = targets
        }
        if c.fitToken != fitToken {
            c.fitToken = fitToken
            fit(map)
        }
    }

    /// On first appearance the map can still be zero-sized; retry briefly so the first fit lands.
    private func fitWhenSized(_ map: MKMapView, tries: Int) {
        if map.bounds.width > 0 && map.bounds.height > 0 {
            DispatchQueue.main.async { fit(map) }
        } else if tries > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { fitWhenSized(map, tries: tries - 1) }
        }
    }

    private func fit(_ map: MKMapView) {
        guard !targets.isEmpty else {
            if let u = map.userLocation.location { map.setRegion(MKCoordinateRegion(center: u.coordinate, latitudinalMeters: 4000, longitudinalMeters: 4000), animated: true) }
            return
        }
        var rect = MKMapRect.null
        for t in targets { rect = rect.union(MKCircle(center: t.coordinate, radius: t.radiusM).boundingMapRect) }
        map.setVisibleMapRect(rect, edgePadding: UIEdgeInsets(top: 60, left: 30, bottom: 30, right: 30), animated: true)
    }

    final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        var parent: ResponderMapView
        var drawn: [MapTarget] = []
        var fitToken = 0

        init(_ p: ResponderMapView) { parent = p; fitToken = p.fitToken }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let circle = overlay as? TargetCircle, let t = circle.target else { return MKOverlayRenderer(overlay: overlay) }
            let r = MKCircleRenderer(circle: circle)
            let color = UIColor(t.category.color)
            r.fillColor = color.withAlphaComponent(t.exact ? 0.35 : 0.15)
            r.strokeColor = t.mine ? UIColor.systemBlue : color
            r.lineWidth = t.mine ? 3 : 2
            if t.source == .mesh { r.lineDashPattern = [6, 5] }
            return r
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let pin = annotation as? TargetPin else { return nil }
            let v = mapView.dequeueReusableAnnotationView(withIdentifier: "pin", for: annotation) as! MKMarkerAnnotationView
            v.markerTintColor = UIColor(pin.target.category.color)
            v.glyphImage = UIImage(systemName: pin.target.source == .mesh ? "dot.radiowaves.left.and.right" : pin.target.category.symbol)
            v.displayPriority = pin.target.exact ? .required : .defaultHigh
            v.titleVisibility = .adaptive
            v.alpha = pin.target.source == .mesh ? 0.8 : 1
            return v
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            guard let pin = view.annotation as? TargetPin else { return }
            mapView.deselectAnnotation(pin, animated: false)
            parent.selectedId = pin.target.id
        }

        /// Tapping inside a circle selects it (the smallest circle containing the tap wins).
        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let map = g.view as? MKMapView else { return }
            let coord = map.convert(g.location(in: map), toCoordinateFrom: map)
            let here = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
            let hit = parent.targets
                .filter { CLLocation(latitude: $0.lat, longitude: $0.lng).distance(from: here) <= $0.radiusM }
                .min { $0.radiusM < $1.radiusM }
            if let hit { parent.selectedId = hit.id }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            !(touch.view is MKAnnotationView)
        }
    }
}
#endif
