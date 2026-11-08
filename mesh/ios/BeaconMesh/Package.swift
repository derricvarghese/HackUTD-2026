// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BeaconMesh",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "BeaconMesh", targets: ["BeaconMesh"]),
        .library(name: "BeaconMeshUI", targets: ["BeaconMeshUI"]),
    ],
    dependencies: [
        // CryptoKit is only on Apple platforms; swift-crypto is API compatible and lets the pure-logic target
        // (JSON, canonical signing, ECIES, router, store, backend client) build and test on Linux.
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
    ],
    targets: [
        .target(
            name: "BeaconMesh",
            dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))]
        ),
        .target(name: "BeaconMeshUI", dependencies: ["BeaconMesh"]),
        .testTarget(name: "BeaconMeshTests", dependencies: ["BeaconMesh"]),
    ]
)
