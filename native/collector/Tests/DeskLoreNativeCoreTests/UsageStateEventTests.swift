import DeskLoreNativeCore
import Foundation
import XCTest

final class UsageStateEventTests: XCTestCase {
    func testUnavailableAndExcludedStatesDiscardApplicationIdentity() {
        let application = HistoryEvent.Application(
            bundleIdentifier: "com.example.private",
            name: "Private"
        )

        XCTAssertNil(
            UsageStateEvent(
                state: .excluded,
                reason: .applicationActivation,
                application: application
            ).application
        )
        XCTAssertNil(
            UsageStateEvent(
                state: .unavailable,
                reason: .screenSleep,
                application: application
            ).application
        )
        XCTAssertEqual(
            UsageStateEvent(
                state: .foreground,
                reason: .applicationActivation,
                application: application
            ).application,
            application
        )
    }
}
