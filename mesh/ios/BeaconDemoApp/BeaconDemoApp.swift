import BeaconMesh
import BeaconMeshUI
import SwiftUI

@main
struct BeaconDemoApp: App {
    @StateObject private var node = MeshNode()

    var body: some Scene {
        WindowGroup {
            BeaconRootView(node: node)
        }
    }
}
