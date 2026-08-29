import XCTest
@testable import DeskLoreNativeCore

final class ObservationPolicyTests: XCTestCase {
    private func policy(
        defaultApplicationBehavior: ObservationPolicy.DefaultBehavior = .observe,
        defaultURLBehavior: ObservationPolicy.DefaultBehavior = .observe,
        allowedBundleIdentifiers: [String] = [],
        blockedBundleIdentifiers: [String] = [],
        allowedDomains: [String] = [],
        blockedDomains: [String] = [],
        blockedWindowTitles: [WindowTitleExclusionRule] = []
    ) -> ObservationPolicy {
        ObservationPolicy(
            defaultApplicationBehavior: defaultApplicationBehavior,
            defaultURLBehavior: defaultURLBehavior,
            allowedBundleIdentifiers: allowedBundleIdentifiers,
            blockedBundleIdentifiers: blockedBundleIdentifiers,
            allowedDomains: allowedDomains,
            blockedDomains: blockedDomains,
            blockedWindowTitles: blockedWindowTitles
        )
    }

    func testBlockRulesWinAndBrowserRequiresBothScopes() {
        let value = policy(
            defaultApplicationBehavior: .doNotObserve,
            defaultURLBehavior: .doNotObserve,
            allowedBundleIdentifiers: ["com.example.browser"],
            blockedBundleIdentifiers: ["com.example.blocked"],
            allowedDomains: ["example.com"],
            blockedDomains: ["private.example.com"]
        )

        XCTAssertTrue(
            value.decision(
                bundleIdentifier: "com.example.browser",
                windowTitle: "Allowed",
                url: "https://docs.example.com/page",
                isPrivateBrowsing: false
            ).allowed
        )
        XCTAssertEqual(
            value.decision(
                bundleIdentifier: "com.example.browser",
                windowTitle: "Blocked",
                url: "https://private.example.com/page",
                isPrivateBrowsing: false
            ).reason,
            .domainExcluded
        )
        XCTAssertEqual(
            value.decision(
                bundleIdentifier: "com.example.blocked",
                windowTitle: nil,
                url: nil,
                isPrivateBrowsing: false
            ).reason,
            .applicationExcluded
        )
    }

    func testWindowTitleRulesAreCaseInsensitiveAndCanBeAppScoped() {
        let value = policy(
            blockedWindowTitles: [
                .init(
                    id: "rule-global",
                    pattern: "Private Project",
                    match: .contains
                ),
                .init(
                    id: "rule-scoped",
                    pattern: "Payroll",
                    match: .exact,
                    bundleIdentifier: "com.example.sheets"
                ),
            ]
        )

        XCTAssertEqual(
            value.decision(
                bundleIdentifier: "com.example.editor",
                windowTitle: "Notes — PRIVATE PROJECT",
                url: nil,
                isPrivateBrowsing: false
            ).ruleID,
            "rule-global"
        )
        XCTAssertTrue(
            value.decision(
                bundleIdentifier: "com.example.editor",
                windowTitle: "Payroll",
                url: nil,
                isPrivateBrowsing: false
            ).allowed
        )
        XCTAssertEqual(
            value.decision(
                bundleIdentifier: "com.example.sheets",
                windowTitle: "Payroll",
                url: nil,
                isPrivateBrowsing: false
            ).ruleID,
            "rule-scoped"
        )
    }

    func testPrivateBrowsingCannotBeAllowedByRules() {
        let value = policy(
            allowedBundleIdentifiers: ["com.example.browser"],
            allowedDomains: ["example.com"]
        )
        XCTAssertEqual(
            value.decision(
                bundleIdentifier: "com.example.browser",
                windowTitle: "Private",
                url: "https://example.com",
                isPrivateBrowsing: true
            ).reason,
            .privateBrowsing
        )
    }

    func testValidationRejectsDuplicateWindowRuleIDs() {
        let value = policy(
            blockedWindowTitles: [
                .init(id: "duplicate", pattern: "First", match: .contains),
                .init(id: "duplicate", pattern: "Second", match: .contains),
            ]
        )
        XCTAssertThrowsError(try value.validated())
    }
}
