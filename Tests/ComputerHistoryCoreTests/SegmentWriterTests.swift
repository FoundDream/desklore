import Foundation
import XCTest
@testable import ComputerHistoryCore

final class SegmentWriterTests: XCTestCase {
    func testWriterRotatesAtTenMinuteBoundary() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let startedAt = SegmentClock.start(for: Date(timeIntervalSince1970: 1_700_000_123))

        let first = makeEvent(at: startedAt.addingTimeInterval(30))
        let second = makeEvent(at: startedAt.addingTimeInterval(630))

        let firstClosed = try await writer.append(first)
        XCTAssertNil(firstClosed)

        let closed = try await writer.append(second)
        XCTAssertEqual(closed?.metadata.eventCount, 1)
        XCTAssertEqual(closed?.metadata.endedAt, startedAt.addingTimeInterval(600))

        let events = try SegmentReader.readEvents(from: try XCTUnwrap(closed?.eventsURL))
        XCTAssertEqual(events, [first])
    }

    func testExpiredSegmentClosesWithoutNewEvent() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let timestamp = Date(timeIntervalSince1970: 1_700_000_123)

        try await writer.append(makeEvent(at: timestamp))
        let closed = try await writer.closeExpired(
            at: SegmentClock.end(for: timestamp)
        )

        XCTAssertNotNil(closed)
        XCTAssertEqual(closed?.metadata.eventCount, 1)
    }

    func testStartupRecoveryFinalizesExpiredOpenSegment() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let originalWriter = SegmentWriter(layout: fixture.layout)
        let timestamp = Date(timeIntervalSince1970: 1_700_000_123)

        try await originalWriter.append(makeEvent(at: timestamp))

        let restartedWriter = SegmentWriter(layout: fixture.layout)
        let recovered = try await restartedWriter.recoverExpiredSegments(
            at: SegmentClock.end(for: timestamp).addingTimeInterval(1)
        )

        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(recovered.first?.metadata.eventCount, 1)
        XCTAssertNotNil(recovered.first?.metadata.endedAt)
    }

    func testPruningRemovesOnlyExpiredSegmentDirectories() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let oldTimestamp = Date(timeIntervalSince1970: 1_700_000_123)
        let recentTimestamp = oldTimestamp.addingTimeInterval(72 * 60 * 60)

        try await writer.append(makeEvent(at: oldTimestamp))
        _ = try await writer.append(makeEvent(at: recentTimestamp))

        let removed = try await writer.pruneSegments(
            olderThan: recentTimestamp.addingTimeInterval(-48 * 60 * 60)
        )

        XCTAssertEqual(removed, 1)
        let oldDirectory = fixture.layout.segmentDirectory(
            id: SegmentClock.identifier(for: oldTimestamp)
        )
        let recentDirectory = fixture.layout.segmentDirectory(
            id: SegmentClock.identifier(for: recentTimestamp)
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldDirectory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recentDirectory.path))
    }

    private func makeEvent(at timestamp: Date) -> HistoryEvent {
        HistoryEvent(
            timestamp: timestamp,
            kind: .windowChanged,
            application: .init(
                bundleIdentifier: "com.example.editor",
                name: "Editor"
            ),
            window: .init(title: "Plan.md")
        )
    }
}
