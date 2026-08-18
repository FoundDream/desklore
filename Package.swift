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
            name: "ComputerHistoryApp",
            targets: ["ComputerHistoryApp"]
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
            name: "ComputerHistoryApp",
            dependencies: ["ComputerHistoryCore"]
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
