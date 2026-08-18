import Foundation

public enum PrivacySanitizer {
    public static func sanitize(
        _ event: HistoryEvent,
        textLimit: Int = 4_096,
        accessibilityTextLimit: Int = 12_000
    ) -> HistoryEvent {
        let sensitiveTarget = isSensitiveTarget(event.target)
        let window = event.window.map {
            HistoryEvent.Window(
                title: clean($0.title, limit: 1_024),
                url: sanitizedURL($0.url, limit: 2_048),
                isPrivateBrowsing: $0.isPrivateBrowsing
            )
        }
        let target = event.target.map {
            HistoryEvent.Target(
                role: clean($0.role, limit: 256),
                subrole: clean($0.subrole, limit: 256),
                identifier: clean($0.identifier, limit: 512),
                title: clean($0.title, limit: 1_024),
                description: clean($0.description, limit: 1_024),
                placeholder: clean($0.placeholder, limit: 1_024),
                value: sensitiveTarget ? nil : clean($0.value, limit: textLimit)
            )
        }
        let interaction = event.interaction.map {
            HistoryEvent.Interaction(
                text: sensitiveTarget ? nil : clean($0.text, limit: textLimit),
                selectedText: sensitiveTarget
                    ? nil
                    : clean($0.selectedText, limit: textLimit),
                keyEquivalent: clean($0.keyEquivalent, limit: 128),
                modifiers: $0.modifiers?.compactMap {
                    clean($0, limit: 32)
                },
                mouseButton: clean($0.mouseButton, limit: 64),
                clickCount: $0.clickCount,
                mouseOrigin: $0.mouseOrigin,
                mouseDestination: $0.mouseDestination
            )
        }
        let accessibility = event.accessibility.map {
            HistoryEvent.AccessibilityContext(
                mode: $0.mode,
                text: clean($0.text, limit: accessibilityTextLimit) ?? ""
            )
        }

        return HistoryEvent(
            id: event.id,
            timestamp: event.timestamp,
            kind: event.kind,
            occurrenceCount: event.occurrenceCount,
            application: event.application,
            window: window,
            target: target,
            interaction: interaction,
            accessibility: accessibility
        )
    }

    public static func sanitizedURL(_ value: String?, limit: Int = 2_048) -> String? {
        guard let value, !value.isEmpty else { return value }
        guard var components = URLComponents(string: value),
              components.scheme != nil else {
            return clean(value, limit: limit)
        }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        return clean(components.string, limit: limit)
    }

    public static func clean(_ value: String?, limit: Int) -> String? {
        guard let value, !value.isEmpty else { return value }
        var result = value
        for pattern in secretPatterns {
            result = result.replacingOccurrences(
                of: pattern,
                with: "[REDACTED]",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        return String(result.prefix(max(0, limit)))
    }

    public static func isSensitiveTarget(_ target: HistoryEvent.Target?) -> Bool {
        guard let target else { return false }
        if target.isSecureInput { return true }
        let label = [
            target.role,
            target.subrole,
            target.identifier,
            target.title,
            target.description,
            target.placeholder,
        ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
        return sensitiveLabels.contains { label.contains($0) }
    }

    private static let sensitiveLabels = [
        "password", "passwd", "passcode", "secret", "api key", "token",
        "密码", "口令", "验证码", "密钥",
    ]

    private static let secretPatterns = [
        #"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b"#,
        #"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"#,
        #"\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+"#,
        #"\b(?:\d[ -]?){13,19}\b"#,
    ]
}
