import XCTest
@testable import ComputerHistoryCore

final class PrivacySanitizerTests: XCTestCase {
    func testCaptureGuardRedactsSecretsBeforeAXTextLeavesNativeProcess() {
        let value = PrivacySanitizer.clean(
            "api_key=sk-abcdefghijklmnopqrstuvwxyz card 4242 4242 4242 4242",
            limit: 1_000
        )
        XCTAssertEqual(value, "[REDACTED] card [REDACTED]")
    }

    func testCaptureGuardRecognizesSensitiveFieldsBeforeReadingTheirValue() {
        XCTAssertTrue(
            PrivacySanitizer.isSensitiveTarget(
                .init(role: "AXTextField", placeholder: "API Key")
            )
        )
        XCTAssertTrue(
            PrivacySanitizer.isSensitiveTarget(
                .init(role: "AXSecureTextField")
            )
        )
    }
}
