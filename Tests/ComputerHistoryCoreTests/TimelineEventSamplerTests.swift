import Foundation
import XCTest
@testable import ComputerHistoryCore

final class TimelineEventSamplerTests: XCTestCase {
    func testPreservesBriefApplicationsAndRareSemanticKinds() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var events = (0..<400).map { index in
            event(
                at: start.addingTimeInterval(Double(index)),
                app: "com.example.dominant",
                kind: .windowChanged
            )
        }
        let briefSubmit = event(
            at: start.addingTimeInterval(12.5),
            app: "com.example.brief",
            kind: .keyboardSubmit
        )
        let shortcut = event(
            at: start.addingTimeInterval(200.5),
            app: "com.example.dominant",
            kind: .keyboardShortcut
        )
        events.append(contentsOf: [briefSubmit, shortcut])

        let sampled = TimelineEventSampler.sample(events, limit: 20)

        XCTAssertEqual(sampled.count, 20)
        XCTAssertTrue(sampled.contains { $0.id == briefSubmit.id })
        XCTAssertTrue(sampled.contains { $0.id == shortcut.id })
        XCTAssertEqual(sampled.first?.timestamp, start)
        XCTAssertEqual(sampled.last?.timestamp, start.addingTimeInterval(399))
    }

    func testResultIsUniqueAndChronological() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let events = (0..<80).map { index in
            event(
                at: start.addingTimeInterval(Double(79 - index)),
                app: "app.\(index % 4)",
                kind: HistoryEvent.Kind.allCases[index % HistoryEvent.Kind.allCases.count]
            )
        }

        let sampled = TimelineEventSampler.sample(events, limit: 32)

        XCTAssertEqual(Set(sampled.map(\.id)).count, sampled.count)
        XCTAssertEqual(sampled.map(\.timestamp), sampled.map(\.timestamp).sorted())
        XCTAssertEqual(Set(sampled.map { $0.application.bundleIdentifier }).count, 4)
        XCTAssertEqual(Set(sampled.map(\.kind)), Set(HistoryEvent.Kind.allCases))
    }

    func testMilestoneAXEventSurvivesNoisyClickSampling() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var events = (0..<200).map { index in
            event(
                at: start.addingTimeInterval(Double(index)),
                app: "com.example.editor",
                kind: .mouseClick
            )
        }
        let milestone = HistoryEvent(
            timestamp: start.addingTimeInterval(100.5),
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.editor", name: "Editor"),
            window: .init(title: "Computer History"),
            accessibility: .init(
                mode: .fullTree,
                text: "Build complete. Tests passed. Smoke validation succeeded."
            )
        )
        events.append(milestone)

        let sampled = TimelineEventSampler.sample(events, limit: 20)

        XCTAssertEqual(sampled.count, 20)
        XCTAssertTrue(sampled.contains { $0.id == milestone.id })
    }

    private func event(
        at date: Date,
        app: String,
        kind: HistoryEvent.Kind
    ) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: kind,
            application: .init(bundleIdentifier: app, name: app),
            window: .init(title: "Timeline")
        )
    }
}
