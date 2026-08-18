import Foundation
import XCTest
@testable import ComputerHistoryCore

final class EventBurstCoalescerTests: XCTestCase {
    func testSameTargetClicksMergeAndRetainOccurrenceCount() throws {
        var coalescer = EventBurstCoalescer(clickWindow: 0.8)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertTrue(coalescer.ingest(click(at: start)).isEmpty)
        XCTAssertTrue(
            coalescer.ingest(click(at: start.addingTimeInterval(0.4))).isEmpty
        )
        let flushed = coalescer.flushExpired(
            at: start.addingTimeInterval(1.3)
        )

        XCTAssertEqual(flushed.count, 1)
        XCTAssertEqual(flushed[0].occurrenceCount, 2)
        XCTAssertEqual(flushed[0].timestamp, start.addingTimeInterval(0.4))
    }

    func testDifferentClickTargetsRemainSeparate() {
        var coalescer = EventBurstCoalescer(clickWindow: 0.8)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        _ = coalescer.ingest(click(at: start, identifier: "one"))
        _ = coalescer.ingest(
            click(at: start.addingTimeInterval(0.2), identifier: "two")
        )

        XCTAssertEqual(coalescer.flushAll().count, 2)
    }

    func testWindowBurstKeepsLatestAndCombinesAXContext() throws {
        var coalescer = EventBurstCoalescer(windowChangeWindow: 0.75)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let first = windowEvent(at: start, axText: "first")
        let second = windowEvent(
            at: start.addingTimeInterval(0.5),
            axText: "second"
        )

        _ = coalescer.ingest(first)
        _ = coalescer.ingest(second)
        let event = try XCTUnwrap(coalescer.flushAll().first)

        XCTAssertEqual(event.occurrenceCount, 2)
        XCTAssertEqual(event.accessibility?.text, "first\nsecond")
    }

    private func click(at date: Date, identifier: String = "button") -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .mouseClick,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: "Plan"),
            target: .init(role: "AXButton", identifier: identifier),
            interaction: .init(mouseButton: "left", clickCount: 1)
        )
    }

    private func windowEvent(at date: Date, axText: String) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: "Plan"),
            accessibility: .init(mode: .diffFromPrevious, text: axText)
        )
    }
}
