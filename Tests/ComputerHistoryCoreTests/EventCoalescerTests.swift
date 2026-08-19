import Foundation
import XCTest
@testable import ComputerHistoryCore

final class EventCoalescerTests: XCTestCase {
    func testUnchangedPollingEmitsOnlyHeartbeat() {
        var coalescer = EventCoalescer(unchangedHeartbeatWindow: 30)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertNotNil(coalescer.process(event(at: start)))
        XCTAssertNil(coalescer.process(event(at: start.addingTimeInterval(2))))
        XCTAssertNil(coalescer.process(event(at: start.addingTimeInterval(29))))
        XCTAssertNotNil(coalescer.process(event(at: start.addingTimeInterval(30))))
    }

    func testDefaultConfigurationNeverEmitsUnchangedHeartbeat() {
        var coalescer = EventCoalescer()
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertNotNil(coalescer.process(event(at: start)))
        XCTAssertNil(coalescer.process(event(at: start.addingTimeInterval(3_600))))
    }

    func testWindowChangeIsRecordedButFocusedTargetChurnIsIgnored() {
        var coalescer = EventCoalescer(unchangedHeartbeatWindow: 30)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertNotNil(coalescer.process(event(at: start, title: "Plan")))
        XCTAssertNotNil(
            coalescer.process(event(at: start.addingTimeInterval(2), title: "Build"))
        )
        XCTAssertNil(
            coalescer.process(
                event(at: start.addingTimeInterval(3), title: "Build", target: "AXButton")
            )
        )
    }

    func testTextInputIsRateLimitedAndStoredAsIncrement() throws {
        var coalescer = EventCoalescer(textInputWindow: 0.75)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        let first = try XCTUnwrap(
            coalescer.process(textEvent(at: start, value: "hello"))
        )
        XCTAssertEqual(first.interaction?.text, "hello")
        XCTAssertNil(first.target?.value)
        XCTAssertNil(
            coalescer.process(
                textEvent(at: start.addingTimeInterval(0.2), value: "hello w")
            )
        )
        let next = try XCTUnwrap(
            coalescer.process(
                textEvent(at: start.addingTimeInterval(0.8), value: "hello world")
            )
        )
        XCTAssertEqual(next.interaction?.text, " world")
        XCTAssertNil(next.target?.value)
    }

    func testTextInputWithoutReadableValueIsSuppressed() {
        var coalescer = EventCoalescer()
        let event = HistoryEvent(
            timestamp: Date(timeIntervalSince1970: 1_800_000_000),
            kind: .keyboardTextInput,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            target: .init(role: "AXWindow")
        )

        XCTAssertNil(coalescer.process(event))
    }

    func testEmptyAndRapidSelectionChangesAreSuppressed() {
        var coalescer = EventCoalescer(selectionWindow: 0.4)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        XCTAssertNil(coalescer.process(selectionEvent(at: start, text: "")))
        XCTAssertNotNil(coalescer.process(selectionEvent(at: start, text: "plan")))
        XCTAssertNil(
            coalescer.process(
                selectionEvent(at: start.addingTimeInterval(0.1), text: "planning")
            )
        )
        XCTAssertNotNil(
            coalescer.process(
                selectionEvent(at: start.addingTimeInterval(0.5), text: "planning")
            )
        )
    }

    func testRepeatedMouseClicksAreNotCollapsedOutsideDuplicateWindow() {
        var coalescer = EventCoalescer()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let click = HistoryEvent(
            timestamp: start,
            kind: .mouseClick,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            interaction: .init(mouseButton: "left", clickCount: 1)
        )
        let laterClick = HistoryEvent(
            timestamp: start.addingTimeInterval(1),
            kind: .mouseClick,
            application: click.application,
            interaction: click.interaction
        )

        XCTAssertNotNil(coalescer.process(click))
        XCTAssertNotNil(coalescer.process(laterClick))
    }

    private func event(
        at date: Date,
        title: String = "Plan",
        target: String = "AXTextField"
    ) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: title),
            target: .init(role: target)
        )
    }

    private func textEvent(at date: Date, value: String) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .keyboardTextInput,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: "Plan"),
            target: .init(role: "AXTextField", identifier: "editor", value: value),
            interaction: .init(text: value)
        )
    }

    private func selectionEvent(at date: Date, text: String) -> HistoryEvent {
        HistoryEvent(
            timestamp: date,
            kind: .selectionChanged,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: "Plan"),
            target: .init(role: "AXTextArea", identifier: "editor"),
            interaction: .init(selectedText: text)
        )
    }
}
