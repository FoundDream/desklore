import Foundation
import XCTest
@testable import ComputerHistoryCore

final class ObservationPolicyTests: XCTestCase {
    private let application = HistoryEvent.Application(
        bundleIdentifier: "com.example.editor",
        name: "Editor"
    )

    func testDefaultPolicyAllowsUnknownApplicationAndURL() {
        let policy = ObservationPolicy()
        XCTAssertTrue(policy.allows(event()))
        XCTAssertTrue(policy.allows(event(url: "https://docs.example.com/page")))
    }

    func testBlockedApplicationIsDenied() {
        var policy = ObservationPolicy()
        policy.blockedBundleIdentifiers.insert(application.bundleIdentifier)
        XCTAssertFalse(policy.allows(event()))
    }

    func testBlockedDomainAndSubdomainsAreDenied() {
        var policy = ObservationPolicy()
        policy.blockedDomains.insert("example.com")
        XCTAssertFalse(policy.allows(event(url: "https://docs.example.com/page")))
        XCTAssertTrue(policy.allows(event(url: "https://example.org/page")))
    }

    func testPrivateBrowsingAndSecureInputAreAlwaysDenied() {
        let policy = ObservationPolicy()

        XCTAssertFalse(policy.allows(event(isPrivate: true)))
        XCTAssertFalse(policy.allows(event(targetRole: "AXSecureTextField")))
    }

    private func event(
        url: String? = nil,
        isPrivate: Bool = false,
        targetRole: String? = nil
    ) -> HistoryEvent {
        HistoryEvent(
            timestamp: Date(),
            kind: .windowChanged,
            application: application,
            window: .init(url: url, isPrivateBrowsing: isPrivate),
            target: .init(role: targetRole)
        )
    }
}
