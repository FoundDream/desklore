import Foundation
@testable import ComputerHistoryCore

struct TemporaryFixture {
    let root: URL
    let layout: StorageLayout

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ComputerHistoryTests", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        layout = StorageLayout(root: root)
        try layout.ensureDirectories()
    }

    func cleanup() {
        guard root.path.contains("/ComputerHistoryTests/") else { return }
        try? FileManager.default.removeItem(at: root)
    }
}
