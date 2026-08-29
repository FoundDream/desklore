// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "DeskLore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "DeskLoreNativeCore",
            targets: ["DeskLoreNativeCore"]
        ),
        .executable(
            name: "DeskLoreCollector",
            targets: ["DeskLoreCollector"]
        ),
    ],
    targets: [
        .target(
            name: "DeskLoreNativeCore"
        ),
        .executableTarget(
            name: "DeskLoreCollector",
            dependencies: ["DeskLoreNativeCore"]
        ),
        .testTarget(
            name: "DeskLoreNativeCoreTests",
            dependencies: ["DeskLoreNativeCore"]
        ),
    ]
)
