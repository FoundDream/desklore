import Foundation
import XCTest
@testable import ComputerHistoryCore

final class PrivacySanitizerTests: XCTestCase {
    func testStripsURLCredentialsQueryAndFragment() {
        let value = PrivacySanitizer.sanitizedURL(
            "https://alice:secret@example.com/path?q=token#section"
        )
        XCTAssertEqual(value, "https://example.com/path")
    }

    func testRedactsCommonSecretsAndCardNumbers() {
        let value = PrivacySanitizer.clean(
            "api_key=sk-abcdefghijklmnopqrstuvwxyz card 4242 4242 4242 4242",
            limit: 1_000
        )
        XCTAssertEqual(value, "[REDACTED] card [REDACTED]")
    }

    func testSensitiveTargetDropsTextButKeepsSafeContext() {
        let event = HistoryEvent(
            timestamp: Date(),
            kind: .keyboardTextInput,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            window: .init(title: "Sign in"),
            target: .init(
                role: "AXTextField",
                title: "API Token",
                value: "sk-abcdefghijklmnopqrstuvwxyz"
            ),
            interaction: .init(text: "sk-abcdefghijklmnopqrstuvwxyz")
        )

        let sanitized = PrivacySanitizer.sanitize(event)
        XCTAssertEqual(sanitized.target?.title, "API Token")
        XCTAssertNil(sanitized.target?.value)
        XCTAssertNil(sanitized.interaction?.text)
    }

    func testPreservesNewSemanticMouseAndTargetFields() {
        let event = HistoryEvent(
            timestamp: Date(),
            kind: .mouseDrag,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            target: .init(
                role: "AXButton",
                subrole: "AXCloseButton",
                identifier: "close-window",
                placeholder: "Close"
            ),
            interaction: .init(
                modifiers: ["cmd", "shift"],
                mouseButton: "left",
                mouseOrigin: .init(x: 10, y: 20),
                mouseDestination: .init(x: 30, y: 40)
            )
        )

        let sanitized = PrivacySanitizer.sanitize(event)

        XCTAssertEqual(sanitized.target?.subrole, "AXCloseButton")
        XCTAssertEqual(sanitized.target?.identifier, "close-window")
        XCTAssertEqual(sanitized.target?.placeholder, "Close")
        XCTAssertEqual(sanitized.interaction?.modifiers, ["cmd", "shift"])
        XCTAssertEqual(sanitized.interaction?.mouseOrigin, .init(x: 10, y: 20))
        XCTAssertEqual(sanitized.interaction?.mouseDestination, .init(x: 30, y: 40))
    }

    func testSensitivePlaceholderDropsCapturedText() {
        let event = HistoryEvent(
            timestamp: Date(),
            kind: .keyboardTextInput,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            target: .init(role: "AXTextField", placeholder: "API Key"),
            interaction: .init(text: "secret-value")
        )

        let sanitized = PrivacySanitizer.sanitize(event)

        XCTAssertNil(sanitized.interaction?.text)
    }

    func testAccessibilityContextUsesIndependentLargerLimit() {
        let event = HistoryEvent(
            timestamp: Date(),
            kind: .windowChanged,
            application: .init(bundleIdentifier: "com.example.app", name: "Example"),
            interaction: .init(text: String(repeating: "i", count: 100)),
            accessibility: .init(
                mode: .fullTree,
                text: String(repeating: "a", count: 100)
            )
        )

        let sanitized = PrivacySanitizer.sanitize(
            event,
            textLimit: 20,
            accessibilityTextLimit: 80
        )

        XCTAssertEqual(sanitized.interaction?.text?.count, 20)
        XCTAssertEqual(sanitized.accessibility?.text.count, 80)
    }
}
