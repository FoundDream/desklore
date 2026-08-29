import Foundation

/// Capture-time safety guard. Full event sanitization and policy enforcement
/// happen in TypeScript, but native AX traversal must never read a secret field.
public enum PrivacySanitizer {
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
