import Foundation

public struct StorageLayout: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public static func applicationSupport(
        fileManager: FileManager = .default
    ) throws -> StorageLayout {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return StorageLayout(
            root: base.appendingPathComponent("ComputerHistoryDesktop", isDirectory: true)
        )
    }

    public var segments: URL {
        root.appendingPathComponent("segments", isDirectory: true)
    }

    public var timeline: URL {
        root.appendingPathComponent("timeline", isDirectory: true)
    }

    public var state: URL {
        root.appendingPathComponent("state", isDirectory: true)
    }

    public func segmentDirectory(id: String) -> URL {
        segments.appendingPathComponent(id, isDirectory: true)
    }

    public func ensureDirectories(fileManager: FileManager = .default) throws {
        for directory in [root, segments, timeline, state] {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
        }
    }
}
