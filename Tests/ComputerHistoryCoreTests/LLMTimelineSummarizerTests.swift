import Foundation
import XCTest
@testable import ComputerHistoryCore

final class LLMTimelineSummarizerTests: XCTestCase {
    func testStructuredSummaryUsesOnlyValidEvidenceAndIncludesContext() async throws {
        let event = makeEvent(id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
        let secondaryEvent = makeEvent(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000011")!,
            bundleIdentifier: "com.example.browser",
            applicationName: "Browser"
        )
        let transport = StubTimelineTransport(
            responses: [response(title: "Planning work", evidenceIDs: [event.id.uuidString])]
        )
        let summarizer = OpenAIResponsesTimelineSummarizer(
            configuration: configuration(maxAttempts: 1),
            transport: transport
        )
        let context = TimelineSummarizationContext(
            priorSummaries: [
                .init(
                    startedAt: event.timestamp.addingTimeInterval(-600),
                    endedAt: event.timestamp,
                    title: "Prior setup",
                    description: "Prepared the project."
                ),
            ]
        )

        let document = try await summarizer.summarize(
            segment: makeSegment(at: event.timestamp),
            events: [event, secondaryEvent],
            context: context
        )

        XCTAssertEqual(document.title, "Planning work")
        XCTAssertEqual(document.activityState, .planning)
        XCTAssertEqual(document.evidenceEventIDs, [event.id.uuidString.lowercased()])
        XCTAssertEqual(document.generator.type, "llm")
        XCTAssertEqual(document.generator.model, "test-model")
        XCTAssertEqual(
            Set(document.applications.map(\.bundleIdentifier)),
            ["com.example.editor", "com.example.browser"]
        )

        let capturedRequestBody = await transport.lastRequestBody()
        let requestBody = try XCTUnwrap(capturedRequestBody)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: requestBody) as? [String: Any]
        )
        XCTAssertEqual(root["store"] as? Bool, false)
        let text = try XCTUnwrap(root["text"] as? [String: Any])
        let format = try XCTUnwrap(text["format"] as? [String: Any])
        XCTAssertEqual(format["type"] as? String, "json_schema")
        XCTAssertEqual(format["strict"] as? Bool, true)
        XCTAssertTrue(String(data: requestBody, encoding: .utf8)?.contains("Prior setup") == true)
        XCTAssertFalse(
            String(data: requestBody, encoding: .utf8)?.contains("private=value") == true
        )
    }

    func testInvalidEvidenceRetriesThenSucceeds() async throws {
        let event = makeEvent(id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!)
        let transport = StubTimelineTransport(
            responses: [
                response(title: "Invalid", evidenceIDs: ["unknown-event"]),
                response(title: "Recovered", evidenceIDs: [event.id.uuidString]),
            ]
        )
        let summarizer = OpenAIResponsesTimelineSummarizer(
            configuration: configuration(maxAttempts: 2),
            transport: transport
        )

        let document = try await summarizer.summarize(
            segment: makeSegment(at: event.timestamp),
            events: [event]
        )

        XCTAssertEqual(document.title, "Recovered")
        let retryCallCount = await transport.numberOfCalls()
        XCTAssertEqual(retryCallCount, 2)
    }

    func testAuthenticationFailureFallsBackToRules() async throws {
        let event = makeEvent(id: UUID(uuidString: "00000000-0000-0000-0000-000000000003")!)
        let transport = StubTimelineTransport(
            responses: [TimelineHTTPResponse(data: Data(), statusCode: 401)]
        )
        let primary = OpenAIResponsesTimelineSummarizer(
            configuration: configuration(maxAttempts: 3),
            transport: transport
        )
        let summarizer = FallbackTimelineSummarizer(primary: primary)

        let document = try await summarizer.summarize(
            segment: makeSegment(at: event.timestamp),
            events: [event]
        )

        XCTAssertEqual(document.generator.type, "rules-fallback")
        XCTAssertEqual(document.evidenceEventIDs, [event.id.uuidString.lowercased()])
        let fallbackCallCount = await transport.numberOfCalls()
        XCTAssertEqual(fallbackCallCount, 1)
    }

    func testModelCanInferProgressWhenRuleDetectorIsUnknown() async throws {
        let event = HistoryEvent(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000021")!,
            timestamp: Date(timeIntervalSince1970: 1_800_000_010),
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.editor", name: "Editor"),
            window: .init(title: "Computer History")
        )
        let transport = StubTimelineTransport(
            responses: [
                response(
                    title: "Implemented timeline capture",
                    evidenceIDs: [event.id.uuidString],
                    activityState: .implementationCompleted
                ),
            ]
        )
        let summarizer = OpenAIResponsesTimelineSummarizer(
            configuration: configuration(maxAttempts: 1),
            transport: transport
        )

        let document = try await summarizer.summarize(
            segment: makeSegment(at: event.timestamp),
            events: [event]
        )

        XCTAssertEqual(document.activityState, .implementationCompleted)
        XCTAssertEqual(document.generator.type, "llm")
    }

    private func configuration(maxAttempts: Int) -> TimelineLLMConfiguration {
        TimelineLLMConfiguration(
            endpoint: URL(string: "https://example.test/v1/responses")!,
            apiKey: "test-key",
            model: "test-model",
            maxAttempts: maxAttempts,
            retryDelays: Array(repeating: 0, count: maxAttempts)
        )
    }

    private func makeEvent(
        id: UUID,
        bundleIdentifier: String = "com.example.editor",
        applicationName: String = "Editor"
    ) -> HistoryEvent {
        HistoryEvent(
            id: id,
            timestamp: Date(timeIntervalSince1970: 1_800_000_010),
            kind: .windowChanged,
            application: .init(
                bundleIdentifier: bundleIdentifier,
                name: applicationName
            ),
            window: .init(
                title: "Timeline plan",
                url: "https://example.com/plan?private=value"
            )
        )
    }

    private func makeSegment(at date: Date) -> ClosedSegment {
        let start = SegmentClock.start(for: date)
        return ClosedSegment(
            metadata: SegmentMetadata(
                id: SegmentClock.identifier(for: start),
                startedAt: start,
                endedAt: start.addingTimeInterval(SegmentClock.duration),
                eventCount: 1
            ),
            directoryURL: FileManager.default.temporaryDirectory
        )
    }

    private func response(
        title: String,
        evidenceIDs: [String],
        activityState: TimelineActivityState = .planning
    ) -> TimelineHTTPResponse {
        let draft: [String: Any] = [
            "title": title,
            "description": "Moved the timeline implementation forward.",
            "activity_state": activityState.rawValue,
            "evidence_event_ids": evidenceIDs,
        ]
        let draftData = try! JSONSerialization.data(withJSONObject: draft)
        let draftText = String(data: draftData, encoding: .utf8)!
        let envelope: [String: Any] = [
            "output": [
                ["content": [["type": "output_text", "text": draftText]]],
            ],
        ]
        return TimelineHTTPResponse(
            data: try! JSONSerialization.data(withJSONObject: envelope),
            statusCode: 200
        )
    }
}

private actor StubTimelineTransport: TimelineLLMTransport {
    private var responses: [TimelineHTTPResponse]
    private var requestBodies: [Data] = []

    init(responses: [TimelineHTTPResponse]) {
        self.responses = responses
    }

    func perform(_ request: URLRequest) async throws -> TimelineHTTPResponse {
        if let body = request.httpBody {
            requestBodies.append(body)
        }
        guard !responses.isEmpty else {
            throw TimelineLLMError.missingOutput
        }
        return responses.removeFirst()
    }

    func numberOfCalls() -> Int {
        requestBodies.count
    }

    func lastRequestBody() -> Data? {
        requestBodies.last
    }
}
