import BeaconMesh
import BeaconMeshUI
import SwiftUI

@main
struct BeaconDemoApp: App {
    @StateObject private var node = MeshNode()

    init() {
        // The notification delegate must exist before the first notification tap can launch the app (cold launch).
        WelfareNotificationCenter.shared.install()
    }

    var body: some Scene {
        WindowGroup {
            BeaconRootView(node: node)
        }
    }
}
