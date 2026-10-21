// swift-tools-version:5.9
import PackageDescription

// Husk Bar: a menu-bar companion for a local Husk server, with a pill under the
// notch on Macs that have one. Logic lives in HuskBarCore so it can be tested
// without a screen; the app target is the AppKit and SwiftUI shell around it.
let package = Package(
    name: "HuskBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "HuskBar", targets: ["HuskBar"]),
    ],
    targets: [
        .target(name: "HuskBarCore"),
        .executableTarget(name: "HuskBar", dependencies: ["HuskBarCore"]),
        .testTarget(name: "HuskBarCoreTests", dependencies: ["HuskBarCore"]),
    ]
)
