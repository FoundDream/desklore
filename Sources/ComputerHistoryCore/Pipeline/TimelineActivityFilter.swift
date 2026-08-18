import Foundation

/// Filters lock-screen and authentication surfaces that do not represent
/// deliberate computer activity. Raw capture, timeline generation, and the UI
/// use the same rule so an idle system cannot create visible history entries.
public enum TimelineActivityFilter {
    public static let excludedBundleIdentifiers: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.ScreenSaver.Engine",
        "com.apple.SecurityAgent",
    ]

    public static func shouldRecord(bundleIdentifier: String) -> Bool {
        !excludedBundleIdentifiers.contains(bundleIdentifier)
    }

    public static func hasMeaningfulActivity(_ events: [HistoryEvent]) -> Bool {
        events.contains {
            shouldRecord(bundleIdentifier: $0.application.bundleIdentifier)
        }
    }

    public static func shouldShow(_ document: TimelineDocument) -> Bool {
        document.applications.contains {
            shouldRecord(bundleIdentifier: $0.bundleIdentifier)
        }
    }
}
