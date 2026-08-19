import Foundation
import XCTest
@testable import ComputerHistoryCore

final class TimelineRepositoryTests: XCTestCase {
    func testClosedSegmentGeneratesOneMarkdownDocumentIdempotently() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let repository = TimelineRepository(layout: fixture.layout)
        let startedAt = SegmentClock.start(for: Date(timeIntervalSince1970: 1_700_000_123))

        try await writer.append(makeEvent(at: startedAt.addingTimeInterval(10)))
        let closedResult = try await writer.closeExpired(
            at: startedAt.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)

        let first = try await repository.generateIfNeeded(for: closed)
        let second = try await repository.generateIfNeeded(for: closed)
        let documents = try await repository.loadDocuments()

        XCTAssertNotNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(documents.count, 1)
        XCTAssertEqual(documents.first?.sourceSegmentID, closed.metadata.id)
        XCTAssertEqual(documents.first?.applications.first?.name, "Editor")
    }

    func testSecondSegmentReceivesPreviousTimelineContext() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let summarizer = ContextRecordingSummarizer()
        let repository = TimelineRepository(
            layout: fixture.layout,
            summarizer: summarizer
        )
        let firstStart = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )

        try await writer.append(makeEvent(at: firstStart.addingTimeInterval(10)))
        let firstClosedResult = try await writer.append(
            makeEvent(at: firstStart.addingTimeInterval(610))
        )
        let firstClosed = try XCTUnwrap(firstClosedResult)
        let secondClosedResult = try await writer.closeExpired(
            at: firstStart.addingTimeInterval(1_200)
        )
        let secondClosed = try XCTUnwrap(secondClosedResult)

        _ = try await repository.generateIfNeeded(for: firstClosed)
        _ = try await repository.generateIfNeeded(for: secondClosed)

        let contexts = await summarizer.capturedContexts()
        XCTAssertEqual(contexts.count, 2)
        XCTAssertTrue(contexts[0].priorSummaries.isEmpty)
        XCTAssertEqual(contexts[1].priorSummaries.map(\.title), ["Segment 1"])
    }

    func testFallbackDocumentUpgradesInPlaceWhenLLMRecovers() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let summarizer = FallbackThenLLMSummarizer()
        let repository = TimelineRepository(
            layout: fixture.layout,
            summarizer: summarizer
        )
        let start = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )
        try await writer.append(makeEvent(at: start.addingTimeInterval(10)))
        let closedResult = try await writer.closeExpired(
            at: start.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)

        let fallbackResult = try await repository.generateIfNeeded(for: closed)
        let fallback = try XCTUnwrap(fallbackResult)
        let upgradedCount = try await repository.retryFallbackDocuments(
            segments: [closed],
            cooldown: 0
        )
        let documents = try await repository.loadDocuments()

        XCTAssertEqual(fallback.generator.type, "rules-fallback")
        XCTAssertEqual(upgradedCount, 1)
        XCTAssertEqual(documents.count, 1)
        XCTAssertEqual(documents[0].id, fallback.id)
        XCTAssertEqual(documents[0].generator.type, "llm")
        XCTAssertEqual(documents[0].title, "Recovered semantic summary")
    }

    func testLoginWindowOnlySegmentDoesNotGenerateTimeline() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let repository = TimelineRepository(layout: fixture.layout)
        let startedAt = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )
        let event = HistoryEvent(
            timestamp: startedAt.addingTimeInterval(10),
            kind: .windowChanged,
            application: .init(
                bundleIdentifier: "com.apple.loginwindow",
                name: "loginwindow"
            ),
            window: .init(title: "Login Window")
        )

        try await writer.append(event)
        let closedResult = try await writer.closeExpired(
            at: startedAt.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)

        let generated = try await repository.generateIfNeeded(for: closed)
        let documents = try await repository.loadDocuments()
        XCTAssertNil(generated)
        XCTAssertTrue(documents.isEmpty)
    }

    func testConcurrentGenerationCreatesOnlyOneDocument() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let summarizer = SlowCountingSummarizer()
        let repository = TimelineRepository(
            layout: fixture.layout,
            summarizer: summarizer
        )
        let startedAt = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )
        try await writer.append(makeEvent(at: startedAt.addingTimeInterval(10)))
        let closedResult = try await writer.closeExpired(
            at: startedAt.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)

        async let first = repository.generateIfNeeded(for: closed)
        async let second = repository.generateIfNeeded(for: closed)
        let results = try await [first, second]
        let documents = try await repository.loadDocuments()
        let summarizerCallCount = await summarizer.numberOfCalls()

        XCTAssertEqual(results.compactMap { $0 }.count, 1)
        XCTAssertEqual(documents.count, 1)
        XCTAssertEqual(summarizerCallCount, 1)
    }

    func testLowQualityLLMSummaryIsPersistedAsRulesQualityFallback() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let repository = TimelineRepository(
            layout: fixture.layout,
            summarizer: LowQualityLLMSummarizer()
        )
        let startedAt = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )
        try await writer.append(makeEvent(at: startedAt.addingTimeInterval(10)))
        let closedResult = try await writer.closeExpired(
            at: startedAt.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)

        let generatedResult = try await repository.generateIfNeeded(for: closed)
        let generated = try XCTUnwrap(generatedResult)
        let documents = try await repository.loadDocuments()

        XCTAssertEqual(generated.generator.type, "rules-quality-fallback")
        XCTAssertNotEqual(generated.title, "Activity")
        XCTAssertEqual(documents.count, 1)
    }

    func testLoadDocumentsHidesExistingDuplicateAndPrefersBetterEvidence() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let writer = SegmentWriter(layout: fixture.layout)
        let repository = TimelineRepository(layout: fixture.layout)
        let startedAt = SegmentClock.start(
            for: Date(timeIntervalSince1970: 1_700_000_123)
        )
        try await writer.append(makeEvent(at: startedAt.addingTimeInterval(10)))
        let closedResult = try await writer.closeExpired(
            at: startedAt.addingTimeInterval(600)
        )
        let closed = try XCTUnwrap(closedResult)
        let generatedResult = try await repository.generateIfNeeded(for: closed)
        let generated = try XCTUnwrap(generatedResult)
        let duplicate = TimelineDocument(
            sourceSegmentID: generated.sourceSegmentID,
            startedAt: generated.startedAt,
            endedAt: generated.endedAt,
            title: "Activity",
            description: "Work happened.",
            applications: generated.applications,
            evidenceEventIDs: [],
            generator: .init(type: "rules-fallback", version: 1),
            body: "## Recording summary"
        )
        let duplicateURL = fixture.layout.timeline
            .appendingPathComponent("duplicate-(duplicate.id).md")
        try TimelineMarkdownCodec.encode(duplicate).write(
            to: duplicateURL,
            atomically: true,
            encoding: .utf8
        )

        let documents = try await repository.loadDocuments()

        XCTAssertEqual(documents.count, 1)
        XCTAssertEqual(documents.first?.id, generated.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: duplicateURL.path))
    }

    private func makeEvent(at timestamp: Date) -> HistoryEvent {
        HistoryEvent(
            timestamp: timestamp,
            kind: .windowChanged,
            application: .init(
                bundleIdentifier: "com.example.editor",
                name: "Editor"
            ),
            window: .init(
                title: "Computer History Plan",
                url: "https://example.com/plan"
            )
        )
    }
}

private actor SlowCountingSummarizer: TimelineSummarizer {
    private var calls = 0

    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context _: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        calls += 1
        try await Task.sleep(nanoseconds: 50_000_000)
        return TimelineDocument(
            sourceSegmentID: segment.metadata.id,
            startedAt: segment.metadata.startedAt,
            endedAt: segment.metadata.endedAt
                ?? segment.metadata.startedAt.addingTimeInterval(SegmentClock.duration),
            title: "Concurrent semantic summary",
            description: "A sufficiently detailed summary for concurrent generation validation.",
            applications: events.map(\.application),
            evidenceEventIDs: events.map { $0.id.uuidString.lowercased() },
            generator: .init(type: "test", version: 1),
            body: "## Recording summary"
        )
    }

    func numberOfCalls() -> Int { calls }
}

private struct LowQualityLLMSummarizer: TimelineSummarizer {
    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context _: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        TimelineDocument(
            sourceSegmentID: segment.metadata.id,
            startedAt: segment.metadata.startedAt,
            endedAt: segment.metadata.endedAt
                ?? segment.metadata.startedAt.addingTimeInterval(SegmentClock.duration),
            title: "Activity",
            description: "Short",
            applications: events.map(\.application),
            evidenceEventIDs: events.prefix(1).map { $0.id.uuidString.lowercased() },
            generator: .init(type: "llm", version: 1, model: "test-model"),
            body: "## Recording summary"
        )
    }
}

private actor FallbackThenLLMSummarizer: TimelineSummarizer {
    private var callCount = 0

    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context _: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        callCount += 1
        let isRecovered = callCount > 1
        return TimelineDocument(
            sourceSegmentID: segment.metadata.id,
            startedAt: segment.metadata.startedAt,
            endedAt: segment.metadata.endedAt
                ?? segment.metadata.startedAt.addingTimeInterval(SegmentClock.duration),
            title: isRecovered ? "Recovered semantic summary" : "Fallback",
            description: isRecovered
                ? "The model recovered and replaced the fallback summary in place."
                : "Rule fallback",
            applications: events.map(\.application),
            evidenceEventIDs: events.map { $0.id.uuidString.lowercased() },
            generator: .init(
                type: isRecovered ? "llm" : "rules-fallback",
                version: 1,
                model: isRecovered ? "test-model" : nil
            ),
            body: "## Recording summary"
        )
    }
}

private actor ContextRecordingSummarizer: TimelineSummarizer {
    private var contexts: [TimelineSummarizationContext] = []

    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        contexts.append(context)
        let number = contexts.count
        return TimelineDocument(
            sourceSegmentID: segment.metadata.id,
            startedAt: segment.metadata.startedAt,
            endedAt: segment.metadata.endedAt
                ?? segment.metadata.startedAt.addingTimeInterval(SegmentClock.duration),
            title: "Segment \(number)",
            description: "Summary \(number)",
            applications: events.map(\.application),
            evidenceEventIDs: events.map { $0.id.uuidString.lowercased() },
            generator: .init(type: "test", version: 1),
            body: "## Recording summary"
        )
    }

    func capturedContexts() -> [TimelineSummarizationContext] {
        contexts
    }
}
