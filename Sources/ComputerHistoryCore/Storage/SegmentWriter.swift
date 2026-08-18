import Foundation

public actor SegmentWriter {
    private let layout: StorageLayout
    private let fileManager: FileManager
    private var current: SegmentMetadata?

    public init(
        layout: StorageLayout,
        fileManager: FileManager = .default
    ) {
        self.layout = layout
        self.fileManager = fileManager
    }

    @discardableResult
    public func append(_ event: HistoryEvent) throws -> ClosedSegment? {
        try layout.ensureDirectories(fileManager: fileManager)
        let segmentID = SegmentClock.identifier(for: event.timestamp)
        var closed: ClosedSegment?

        if let current, current.id != segmentID {
            closed = try finalize(current)
            self.current = nil
        }

        var metadata = try loadOrCreateMetadata(
            id: segmentID,
            timestamp: event.timestamp
        )
        try appendEvent(event, to: layout.segmentDirectory(id: segmentID))
        metadata.eventCount += 1
        try writeMetadata(metadata)
        current = metadata
        return closed
    }

    @discardableResult
    public func recordSuppressed(at timestamp: Date) throws -> ClosedSegment? {
        try layout.ensureDirectories(fileManager: fileManager)
        let segmentID = SegmentClock.identifier(for: timestamp)
        var closed: ClosedSegment?

        if let current, current.id != segmentID {
            closed = try finalize(current)
            self.current = nil
        }

        var metadata = try loadOrCreateMetadata(id: segmentID, timestamp: timestamp)
        metadata.suppressedEventCount += 1
        try writeMetadata(metadata)
        current = metadata
        return closed
    }

    @discardableResult
    public func closeExpired(at date: Date) throws -> ClosedSegment? {
        guard let current else { return nil }
        let segmentEnd = current.startedAt.addingTimeInterval(SegmentClock.duration)
        guard date >= segmentEnd else { return nil }
        let closed = try finalize(current)
        self.current = nil
        return closed
    }

    public func pendingClosedSegments() throws -> [ClosedSegment] {
        try layout.ensureDirectories(fileManager: fileManager)
        let urls = try fileManager.contentsOfDirectory(
            at: layout.segments,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        return try urls.compactMap { directory in
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { return nil }
            let metadataURL = directory.appendingPathComponent("metadata.json")
            guard fileManager.fileExists(atPath: metadataURL.path) else { return nil }
            let data = try Data(contentsOf: metadataURL)
            let metadata = try HistoryCoders.jsonDecoder().decode(
                SegmentMetadata.self,
                from: data
            )
            guard metadata.endedAt != nil else { return nil }
            return ClosedSegment(metadata: metadata, directoryURL: directory)
        }
        .sorted { $0.metadata.startedAt < $1.metadata.startedAt }
    }

    public func recoverExpiredSegments(at date: Date) throws -> [ClosedSegment] {
        try layout.ensureDirectories(fileManager: fileManager)
        let urls = try fileManager.contentsOfDirectory(
            at: layout.segments,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )
        var recovered: [ClosedSegment] = []

        for directory in urls {
            let values = try directory.resourceValues(
                forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
            )
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                continue
            }
            let metadataURL = directory.appendingPathComponent("metadata.json")
            guard fileManager.fileExists(atPath: metadataURL.path) else { continue }
            let data = try Data(contentsOf: metadataURL)
            let metadata = try HistoryCoders.jsonDecoder().decode(
                SegmentMetadata.self,
                from: data
            )
            guard metadata.endedAt == nil,
                  metadata.startedAt.addingTimeInterval(SegmentClock.duration) <= date else {
                continue
            }
            recovered.append(try finalize(metadata))
            if current?.id == metadata.id {
                current = nil
            }
        }

        return recovered.sorted { $0.metadata.startedAt < $1.metadata.startedAt }
    }

    @discardableResult
    public func pruneSegments(olderThan cutoff: Date) throws -> Int {
        try layout.ensureDirectories(fileManager: fileManager)
        let urls = try fileManager.contentsOfDirectory(
            at: layout.segments,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )
        var removed = 0

        for directory in urls {
            let values = try directory.resourceValues(
                forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
            )
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                continue
            }
            guard directory.deletingLastPathComponent().standardizedFileURL
                    == layout.segments.standardizedFileURL else {
                continue
            }
            let metadataURL = directory.appendingPathComponent("metadata.json")
            guard fileManager.fileExists(atPath: metadataURL.path),
                  let data = try? Data(contentsOf: metadataURL),
                  let metadata = try? HistoryCoders.jsonDecoder().decode(
                    SegmentMetadata.self,
                    from: data
                  ) else {
                continue
            }
            let effectiveEnd = metadata.endedAt
                ?? metadata.startedAt.addingTimeInterval(SegmentClock.duration)
            guard effectiveEnd < cutoff else { continue }
            try fileManager.removeItem(at: directory)
            removed += 1
            if current?.id == metadata.id {
                current = nil
            }
        }
        return removed
    }

    private func loadOrCreateMetadata(
        id: String,
        timestamp: Date
    ) throws -> SegmentMetadata {
        if let current, current.id == id {
            return current
        }

        let directory = layout.segmentDirectory(id: id)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let metadataURL = directory.appendingPathComponent("metadata.json")

        if fileManager.fileExists(atPath: metadataURL.path) {
            let data = try Data(contentsOf: metadataURL)
            return try HistoryCoders.jsonDecoder().decode(
                SegmentMetadata.self,
                from: data
            )
        }

        return SegmentMetadata(
            id: id,
            startedAt: SegmentClock.start(for: timestamp)
        )
    }

    private func appendEvent(_ event: HistoryEvent, to directory: URL) throws {
        let eventsURL = directory.appendingPathComponent("events.jsonl")
        var data = try HistoryCoders.jsonEncoder().encode(event)
        data.append(0x0A)

        if !fileManager.fileExists(atPath: eventsURL.path) {
            try data.write(to: eventsURL, options: .atomic)
            return
        }

        let handle = try FileHandle(forWritingTo: eventsURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.close()
    }

    private func writeMetadata(_ metadata: SegmentMetadata) throws {
        let directory = layout.segmentDirectory(id: metadata.id)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let metadataURL = directory.appendingPathComponent("metadata.json")
        let data = try HistoryCoders.jsonEncoder(prettyPrinted: true).encode(metadata)
        try data.write(to: metadataURL, options: .atomic)
    }

    private func finalize(_ metadata: SegmentMetadata) throws -> ClosedSegment {
        var finalized = metadata
        finalized.endedAt = metadata.startedAt.addingTimeInterval(SegmentClock.duration)
        try writeMetadata(finalized)
        return ClosedSegment(
            metadata: finalized,
            directoryURL: layout.segmentDirectory(id: finalized.id)
        )
    }
}
