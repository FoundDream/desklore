import Foundation

public struct ObservationPolicy: Codable, Equatable, Sendable {
    public enum DefaultBehavior: String, Codable, Sendable {
        case observe
        case doNotObserve = "do_not_observe"
    }

    public var defaultApplicationBehavior: DefaultBehavior
    public var defaultURLBehavior: DefaultBehavior
    public var allowedBundleIdentifiers: Set<String>
    public var blockedBundleIdentifiers: Set<String>
    public var allowedDomains: Set<String>
    public var blockedDomains: Set<String>

    public init(
        defaultApplicationBehavior: DefaultBehavior = .observe,
        defaultURLBehavior: DefaultBehavior = .observe,
        allowedBundleIdentifiers: Set<String> = [],
        blockedBundleIdentifiers: Set<String> = [],
        allowedDomains: Set<String> = [],
        blockedDomains: Set<String> = []
    ) {
        self.defaultApplicationBehavior = defaultApplicationBehavior
        self.defaultURLBehavior = defaultURLBehavior
        self.allowedBundleIdentifiers = allowedBundleIdentifiers
        self.blockedBundleIdentifiers = blockedBundleIdentifiers
        self.allowedDomains = allowedDomains
        self.blockedDomains = blockedDomains
    }

    public func allowsApplication(_ bundleIdentifier: String) -> Bool {
        guard !bundleIdentifier.isEmpty else { return false }
        guard !blockedBundleIdentifiers.contains(bundleIdentifier) else {
            return false
        }
        return allowedBundleIdentifiers.contains(bundleIdentifier)
            || defaultApplicationBehavior == .observe
    }

    public func allowsDomain(_ domain: String) -> Bool {
        let normalizedDomain = domain.lowercased()
        guard !matches(domain: normalizedDomain, rules: blockedDomains) else {
            return false
        }
        return matches(domain: normalizedDomain, rules: allowedDomains)
            || defaultURLBehavior == .observe
    }

    public func allows(_ event: HistoryEvent) -> Bool {
        guard allowsApplication(event.application.bundleIdentifier) else { return false }

        guard event.window?.isPrivateBrowsing != true else { return false }
        guard event.target?.isSecureInput != true else { return false }

        guard let urlString = event.window?.url,
              let domain = Self.domain(from: urlString) else {
            return true
        }

        return allowsDomain(domain)
    }

    public func sanitized(
        _ event: HistoryEvent,
        textLimit: Int = 4_096,
        accessibilityTextLimit: Int = 48_000
    ) -> HistoryEvent? {
        guard allows(event) else { return nil }
        return PrivacySanitizer.sanitize(
            event,
            textLimit: textLimit,
            accessibilityTextLimit: accessibilityTextLimit
        )
    }

    private func matches(domain: String, rules: Set<String>) -> Bool {
        rules.contains { rule in
            domain == rule || domain.hasSuffix(".\(rule)")
        }
    }

    private static func domain(from value: String) -> String? {
        let candidate = value.contains("://") ? value : "https://\(value)"
        return URL(string: candidate)?.host?.lowercased()
    }

}
