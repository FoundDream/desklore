// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "DeskLore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "ComputerHistoryCore",
            targets: ["ComputerHistoryCore"]
        ),
        .executable(
            name: "DeskLoreCollector",
            targets: ["DeskLoreCollector"]
        ),
    ],
    targets: [
        .target(
            name: "ComputerHistoryCore"
        ),
        .executableTarget(
            name: "DeskLoreCollector",
            dependencies: ["ComputerHistoryCore"],
            path: "Sources/ComputerHistoryApp"
        ),
        .testTarget(
            name: "ComputerHistoryCoreTests",
            dependencies: ["ComputerHistoryCore"]
        ),
    ]
)
