// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ComputerHistory",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "ComputerHistoryCore",
            targets: ["ComputerHistoryCore"]
        ),
        .executable(
            name: "ComputerHistoryAgent",
            targets: ["ComputerHistoryAgent"]
        ),
        .executable(
            name: "ComputerHistoryEval",
            targets: ["ComputerHistoryEval"]
        ),
    ],
    targets: [
        .target(
            name: "ComputerHistoryCore"
        ),
        .executableTarget(
            name: "ComputerHistoryAgent",
            dependencies: ["ComputerHistoryCore"],
            path: "Sources/ComputerHistoryApp"
        ),
        .executableTarget(
            name: "ComputerHistoryEval",
            dependencies: ["ComputerHistoryCore"]
        ),
        .testTarget(
            name: "ComputerHistoryCoreTests",
            dependencies: ["ComputerHistoryCore"]
        ),
    ]
)
