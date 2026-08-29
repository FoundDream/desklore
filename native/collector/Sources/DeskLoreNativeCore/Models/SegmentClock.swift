import Foundation

/// Native AX snapshots use the segment boundary to decide when a full tree is
/// required. Segment metadata and persistence are owned by TypeScript.
public enum SegmentClock {
    public static let duration: TimeInterval = 10 * 60

    public static func start(for date: Date) -> Date {
        let interval = floor(date.timeIntervalSince1970 / duration) * duration
        return Date(timeIntervalSince1970: interval)
    }

    public static func identifier(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return formatter.string(from: start(for: date))
    }
}
