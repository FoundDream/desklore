import XCTest
@testable import ComputerHistoryCore

final class KeyboardEventClassifierTests: XCTestCase {
    func testSingleLineReturnIsSubmit() {
        XCTAssertEqual(
            KeyboardEventClassifier.classify(
                keyEquivalent: "return",
                modifiers: [],
                target: .init(role: "AXTextField")
            ),
            .keyboardSubmit
        )
    }

    func testMultilineReturnRemainsShortcut() {
        XCTAssertEqual(
            KeyboardEventClassifier.classify(
                keyEquivalent: "return",
                modifiers: [],
                target: .init(role: "AXTextArea", description: "Document editor")
            ),
            .keyboardShortcut
        )
    }

    func testComposerReturnAndCommandReturnAreSubmit() {
        XCTAssertEqual(
            KeyboardEventClassifier.classify(
                keyEquivalent: "return",
                modifiers: [],
                target: .init(role: "AXTextArea", placeholder: "Send a message")
            ),
            .keyboardSubmit
        )
        XCTAssertEqual(
            KeyboardEventClassifier.classify(
                keyEquivalent: "return",
                modifiers: ["cmd"],
                target: .init(role: "AXTextArea")
            ),
            .keyboardSubmit
        )
    }
}
