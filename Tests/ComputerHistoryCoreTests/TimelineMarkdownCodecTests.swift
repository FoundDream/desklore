import Foundation
import XCTest
@testable import ComputerHistoryCore

final class TimelineMarkdownCodecTests: XCTestCase {
    func testRoundTripPreservesTimelineDocument() throws {
        let startedAt = Date(timeIntervalSince1970: 1_776_658_400.125)
        let document = TimelineDocument(
            id: "timeline-1",
            sourceSegmentID: "2026-04-18T03-20-00Z",
            startedAt: startedAt,
            endedAt: startedAt.addingTimeInterval(600),
            title: "研究 \"Computer History\"",
            description: "第一行\n第二行",
            activityState: .implementationStarted,
            applications: [
                .init(bundleIdentifier: "com.openai.codex", name: "Codex"),
                .init(bundleIdentifier: "com.apple.Terminal", name: "Terminal"),
            ],
            evidenceEventIDs: ["event-1", "event-2"],
            generator: .init(type: "llm", version: 2, model: "test-model"),
            createdAt: startedAt.addingTimeInterval(601),
            body: "## 活动\n\n- 11:20–11:30：整理方案"
        )

        let markdown = TimelineMarkdownCodec.encode(document)
        let decoded = try TimelineMarkdownCodec.decode(markdown)

        XCTAssertEqual(decoded, document)
    }

    func testRejectsMarkdownWithoutFrontmatter() {
        XCTAssertThrowsError(
            try TimelineMarkdownCodec.decode("# Missing frontmatter")
        ) { error in
            XCTAssertEqual(
                error as? TimelineMarkdownCodecError,
                .missingFrontmatter
            )
        }
    }

    func testRejectsInvalidActivityState() {
        let markdown = """
        ---
        schema_version: 1
        id: "timeline-1"
        source_segment_id: "segment-1"
        started_at: "2026-04-18T03:20:00.000Z"
        ended_at: "2026-04-18T03:30:00.000Z"
        title: "Timeline"
        description: "Description"
        activity_state: "almost_done"
        applications:
          []
        evidence_event_ids:
          []
        generator:
          type: "rules"
          version: 1
        created_at: "2026-04-18T03:30:01.000Z"
        ---
        Body
        """

        XCTAssertThrowsError(try TimelineMarkdownCodec.decode(markdown)) { error in
            XCTAssertEqual(
                error as? TimelineMarkdownCodecError,
                .invalidField("activity_state")
            )
        }
    }
}
