import Foundation
import XCTest
@testable import ComputerHistoryCore

final class TimelineSummaryEvaluatorTests: XCTestCase {
    func testValidSemanticSummaryPassesQualityGate() {
        let event = makeEvent()
        let document = makeDocument(
            evidenceIDs: [event.id.uuidString],
            description: "You planned the timeline implementation and completed its validation checks."
        )

        let report = TimelineSummaryEvaluator.evaluate(document: document, events: [event])

        XCTAssertTrue(report.passesIntegrityGate)
        XCTAssertTrue(report.passesQualityGate)
    }

    func testUnknownEvidenceAndSensitiveResidualFailGates() {
        let event = makeEvent()
        let document = makeDocument(
            evidenceIDs: ["unknown"],
            description: "Used api_key=sk-abcdefghijklmnopqrstuvwxyz while working on the timeline."
        )

        let report = TimelineSummaryEvaluator.evaluate(document: document, events: [event])

        XCTAssertEqual(report.invalidEvidenceEventIDs, ["unknown"])
        XCTAssertTrue(report.containsSensitiveResidual)
        XCTAssertFalse(report.passesIntegrityGate)
        XCTAssertFalse(report.passesQualityGate)
    }

    func testNamedApplicationNeedsEvidenceFromThatApplication() {
        let editor = makeEvent()
        let browser = makeEvent(
            at: editor.timestamp.addingTimeInterval(60),
            bundleIdentifier: "com.example.browser",
            name: "Browser"
        )
        let description = "You planned the implementation in Editor and verified the result in Browser."
        let document = makeDocument(
            evidenceIDs: [editor.id.uuidString],
            description: description,
            applications: [editor.application, browser.application]
        )

        let report = TimelineSummaryEvaluator.evaluate(
            document: document,
            events: [editor, browser]
        )

        XCTAssertEqual(report.evidenceApplicationCoverage, 0.5)
        XCTAssertFalse(report.passesIntegrityGate)
    }

    func testEvidenceMustCoverMoreThanOneEndOfLongActivity() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let events = (0..<5).map {
            makeEvent(at: start.addingTimeInterval(Double($0 * 100)))
        }
        let document = makeDocument(
            evidenceIDs: [events[0].id.uuidString],
            description: "You planned the timeline implementation and completed its validation checks."
        )

        let report = TimelineSummaryEvaluator.evaluate(document: document, events: events)

        XCTAssertEqual(report.evidenceTemporalCoverage, 0.2)
        XCTAssertTrue(report.passesIntegrityGate)
        XCTAssertFalse(report.passesQualityGate)
    }

    func testEvidenceFromAnUnlistedApplicationFailsIntegrity() {
        let browser = makeEvent(
            bundleIdentifier: "com.example.browser",
            name: "Browser"
        )
        let document = makeDocument(
            evidenceIDs: [browser.id.uuidString],
            description: "You planned the timeline implementation and completed its validation checks."
        )

        let report = TimelineSummaryEvaluator.evaluate(
            document: document,
            events: [browser]
        )

        XCTAssertEqual(report.unlistedEvidenceApplicationIDs, ["com.example.browser"])
        XCTAssertFalse(report.passesIntegrityGate)
    }

    func testUnsupportedLifecycleClaimFailsQualityGate() {
        let event = HistoryEvent(
            timestamp: Date(timeIntervalSince1970: 1_800_000_000),
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.editor", name: "Editor"),
            window: .init(title: "Computer History implementation"),
            accessibility: .init(
                mode: .fullTree,
                text: "Build complete. Tests passed. Smoke validation succeeded."
            )
        )
        let document = makeDocument(
            evidenceIDs: [event.id.uuidString],
            description: "You researched the Computer History timeline implementation approach.",
            activityState: .researching
        )

        let report = TimelineSummaryEvaluator.evaluate(document: document, events: [event])

        XCTAssertEqual(report.detectedActivityState, .validated)
        XCTAssertEqual(report.milestoneEvidenceCount, 1)
        XCTAssertFalse(report.activityStateSupported)
        XCTAssertFalse(report.passesQualityGate)
    }

    private func makeEvent(
        at date: Date = Date(timeIntervalSince1970: 1_800_000_000),
        bundleIdentifier: String = "com.example.editor",
        name: String = "Editor"
    ) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .windowChanged,
            application: .init(bundleIdentifier: bundleIdentifier, name: name),
            window: .init(title: "Computer History implementation")
        )
    }

    private func makeDocument(
        evidenceIDs: [String],
        description: String,
        activityState: TimelineActivityState? = nil,
        applications: [HistoryEvent.Application] = [
            .init(bundleIdentifier: "com.example.editor", name: "Editor"),
        ]
    ) -> TimelineDocument {
        TimelineDocument(
            sourceSegmentID: "segment-1",
            startedAt: Date(timeIntervalSince1970: 1_800_000_000),
            endedAt: Date(timeIntervalSince1970: 1_800_000_600),
            title: "Computer History Timeline Implementation",
            description: description,
            activityState: activityState,
            applications: applications,
            evidenceEventIDs: evidenceIDs,
            generator: .init(type: "llm", version: 1, model: "test-model"),
            body: "## Recording summary\n\n\(description)"
        )
    }
}
