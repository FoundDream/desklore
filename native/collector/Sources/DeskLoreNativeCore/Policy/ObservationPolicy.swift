import Foundation

public struct WindowTitleExclusionRule: Codable, Equatable, Sendable {
    public enum Match: String, Codable, Sendable {
        case contains
        case exact
    }

    public let id: String
    public let pattern: String
    public let match: Match
    public let bundleIdentifier: String?

    public init(
        id: String,
        pattern: String,
        match: Match,
        bundleIdentifier: String? = nil
    ) {
        self.id = id
        self.pattern = pattern
        self.match = match
        self.bundleIdentifier = bundleIdentifier
    }
}

public struct ObservationPolicy: Codable, Equatable, Sendable {
    public enum DefaultBehavior: String, Codable, Sendable {
        case observe
        case doNotObserve = "do_not_observe"
    }

    public enum DecisionReason: String, Codable, Sendable {
        case allowed
        case privateBrowsing = "private_browsing"
        case applicationExcluded = "application_excluded"
        case domainExcluded = "domain_excluded"
        case windowTitleExcluded = "window_title_excluded"
    }

    public struct Decision: Equatable, Sendable {
        public let allowed: Bool
        public let reason: DecisionReason
        public let ruleID: String?
    }

    public let defaultApplicationBehavior: DefaultBehavior
    public let defaultURLBehavior: DefaultBehavior
    public let allowedBundleIdentifiers: [String]
    public let blockedBundleIdentifiers: [String]
    public let allowedDomains: [String]
    public let blockedDomains: [String]
    public let blockedWindowTitles: [WindowTitleExclusionRule]

    public init(
        defaultApplicationBehavior: DefaultBehavior,
        defaultURLBehavior: DefaultBehavior,
        allowedBundleIdentifiers: [String],
        blockedBundleIdentifiers: [String],
        allowedDomains: [String],
        blockedDomains: [String],
        blockedWindowTitles: [WindowTitleExclusionRule]
    ) {
        self.defaultApplicationBehavior = defaultApplicationBehavior
        self.defaultURLBehavior = defaultURLBehavior
        self.allowedBundleIdentifiers = allowedBundleIdentifiers
        self.blockedBundleIdentifiers = blockedBundleIdentifiers
        self.allowedDomains = allowedDomains
        self.blockedDomains = blockedDomains
        self.blockedWindowTitles = blockedWindowTitles
    }

    public func validated() throws -> ObservationPolicy {
        guard blockedWindowTitles.count <= 50,
              Set(blockedWindowTitles.map(\.id)).count == blockedWindowTitles.count,
              allowedBundleIdentifiers.allSatisfy(Self.validBundleIdentifier),
              blockedBundleIdentifiers.allSatisfy(Self.validBundleIdentifier),
              allowedDomains.allSatisfy(Self.validDomain),
              blockedDomains.allSatisfy(Self.validDomain),
              blockedWindowTitles.allSatisfy({ rule in
                  let length = rule.pattern.precomposedStringWithCompatibilityMapping
                      .trimmingCharacters(in: .whitespacesAndNewlines)
                      .count
                  return !rule.id.isEmpty
                      && rule.id.count <= 128
                      && length >= 3
                      && length <= 128
                      && rule.bundleIdentifier.map(Self.validBundleIdentifier) ?? true
              }) else {
            throw ObservationPolicyError.invalidPolicy
        }
        return self
    }

    public func allowsApplication(_ bundleIdentifier: String) -> Bool {
        if blockedBundleIdentifiers.contains(bundleIdentifier) { return false }
        return allowedBundleIdentifiers.contains(bundleIdentifier)
            || defaultApplicationBehavior == .observe
    }

    public func decision(
        bundleIdentifier: String,
        windowTitle: String?,
        url: String?,
        isPrivateBrowsing: Bool
    ) -> Decision {
        if isPrivateBrowsing {
            return Decision(allowed: false, reason: .privateBrowsing, ruleID: nil)
        }
        guard allowsApplication(bundleIdentifier) else {
            return Decision(allowed: false, reason: .applicationExcluded, ruleID: nil)
        }
        if let domain = Self.domain(from: url), !allowsDomain(domain) {
            return Decision(allowed: false, reason: .domainExcluded, ruleID: nil)
        }
        if let rule = matchingWindowTitleRule(
            bundleIdentifier: bundleIdentifier,
            title: windowTitle
        ) {
            return Decision(
                allowed: false,
                reason: .windowTitleExcluded,
                ruleID: rule.id
            )
        }
        return Decision(allowed: true, reason: .allowed, ruleID: nil)
    }

    public static func domain(from value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        let candidate = value.contains("://") ? value : "https://\(value)"
        return URL(string: candidate)?.host?.lowercased()
    }

    private func allowsDomain(_ domain: String) -> Bool {
        if Self.domainMatches(domain, rules: blockedDomains) { return false }
        return Self.domainMatches(domain, rules: allowedDomains)
            || defaultURLBehavior == .observe
    }

    private func matchingWindowTitleRule(
        bundleIdentifier: String,
        title: String?
    ) -> WindowTitleExclusionRule? {
        guard let title else { return nil }
        let normalizedTitle = Self.normalizedTitle(title)
        return blockedWindowTitles.first { rule in
            if let scope = rule.bundleIdentifier, scope != bundleIdentifier { return false }
            let pattern = Self.normalizedTitle(rule.pattern)
            switch rule.match {
            case .contains:
                return normalizedTitle.contains(pattern)
            case .exact:
                return normalizedTitle == pattern
            }
        }
    }

    private static func normalizedTitle(_ value: String) -> String {
        String(value.prefix(1_024))
            .precomposedStringWithCompatibilityMapping
            .lowercased()
    }

    private static func domainMatches(_ domain: String, rules: [String]) -> Bool {
        let normalized = domain.lowercased()
        return rules.contains { rule in
            normalized == rule || normalized.hasSuffix(".\(rule)")
        }
    }

    private static func validBundleIdentifier(_ value: String) -> Bool {
        !value.isEmpty
            && value.count <= 512
            && value.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil
    }

    private static func validDomain(_ value: String) -> Bool {
        !value.isEmpty
            && value.count <= 253
            && value == value.lowercased()
            && !value.contains("://")
            && value.range(of: #"[/@?#]"#, options: .regularExpression) == nil
    }
}

public enum ObservationPolicyError: Error {
    case invalidPolicy
}
