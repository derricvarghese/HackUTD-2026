// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BeaconMesh",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "BeaconMesh", targets: ["BeaconMesh"]),
        .library(name: "BeaconMeshUI", targets: ["BeaconMeshUI"]),
    ],
    targets: [
        .target(name: "BeaconMesh"),
        .target(name: "BeaconMeshUI", dependencies: ["BeaconMesh"]),
        .testTarget(name: "BeaconMeshTests", dependencies: ["BeaconMesh"]),
    ]
)
