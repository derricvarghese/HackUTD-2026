#if canImport(UIKit) && canImport(SwiftUI) && canImport(CoreBluetooth) && canImport(CoreLocation) && canImport(Combine) && canImport(Network)
import BeaconMesh
import SwiftUI

/// The whole app UI: a first-run explainer, then four tabs.
public struct BeaconRootView: View {
    @ObservedObject var node: MeshNode
    @ObservedObject private var haptics = Haptics.shared
    @AppStorage("beacon.onboarded") private var onboarded = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = 0
    /// Settings -> "Responder mode". Off (the default) = no Responder tab and no responder code runs.
    @AppStorage(ResponderPrefs.modeKey) private var responderMode = false
    @StateObject private var responder: ResponderSession

    public init(node: MeshNode) {
        self.node = node
        _responder = StateObject(wrappedValue: ResponderSession(baseURL: node.backendURL))
    }

    public var body: some View {
        Group {
            if onboarded && node.needsProfileOnboarding {
                // Right after the permissions explainer: consent, then name and details. Works offline; syncs later.
                ProfileOnboardingView(node: node, onClose: nil)
            } else if onboarded {
                TabView(selection: $tab) {
                    HomeView(node: node, onOpenMesh: { tab = 2 })
                        .tabItem { Label("Home", systemImage: "sos") }.tag(0)
                    MessagesView(node: node)
                        .tabItem { Label("Messages", systemImage: "tray.full") }.tag(1)
                        .badge(node.messages.filter { $0.isOwn && !$0.uploaded }.count)
                    MeshStatusView(node: node)
                        .tabItem { Label("Mesh", systemImage: "dot.radiowaves.left.and.right") }.tag(2)
                    if responderMode {
                        ResponderTab(node: node, session: responder)
                            .tabItem { Label("Responder", systemImage: "cross.case") }.tag(4)
                    }
                    SettingsView(node: node)
                        .tabItem { Label("Settings", systemImage: "gearshape") }.tag(3)
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if responderMode && responder.sharing {
                        SharingChip().frame(maxWidth: .infinity).padding(.vertical, 4).background(.bar)
                    }
                }
                .onChange(of: tab) { _ in haptics.play(.select) }
                .onChange(of: responderMode) { on in
                    // Leaving responder mode signs out and stops sharing; never leave the user on a vanished tab.
                    guard !on else { return }
                    if tab == 4 { tab = 0 }
                    Task { await responder.logout() }
                }
            } else {
                OnboardingView {
                    haptics.play(.success)
                    onboarded = true
                    node.start()
                }
            }
        }
        // One confirmation sheet per check-in: opened by a notification tap or the card on Home, never a pile.
        .sheet(item: $node.checkinToShow) { checkin in WelfareSheet(node: node, checkin: checkin) }
        .onAppear { if onboarded { node.start() } }
        .onChange(of: scenePhase) { phase in
            if phase == .active { node.tick(); haptics.prepare() }
        }
    }
}

struct OnboardingView: View {
    let done: () -> Void
    @ObservedObject private var haptics = Haptics.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 56)).foregroundStyle(.red)
                    .accessibilityHidden(true)
                Text("Beacon").font(.largeTitle.bold())
                Text("When the network is down, Beacon passes your SOS from phone to phone over Bluetooth until one of them has internet and can tell responders.")
                point("antenna.radiowaves.left.and.right", "Bluetooth", "Lets nearby phones hand messages to each other, even in airplane mode.")
                point("location.fill", "Location", "Your position goes to responders, encrypted so only they can read it.")
                point("lock.shield", "Private", "Phones that pass your message along cannot read it.")
                Button {
                    haptics.play(.tap)
                    done()
                } label: {
                    Text("Continue").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityHint("Asks for Bluetooth and location access")
            }
            .padding(24)
        }
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.title3).frame(width: 32).foregroundStyle(.tint).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
