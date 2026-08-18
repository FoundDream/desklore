import Foundation

public struct SegmentMetadata: Codable, Equatable, Sendable {
    public let id: String
    public let startedAt: Date
    public var endedAt: Date?
    public var eventCount: Int
    public var suppressedEventCount: Int
    public let eventsFile: String

    public init(
        id: String,
        startedAt: Date,
        endedAt: Date? = nil,
        eventCount: Int = 0,
        suppressedEventCount: Int = 0,
        eventsFile: String = "events.jsonl"
    ) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.eventCount = eventCount
        self.suppressedEventCount = suppressedEventCount
        self.eventsFile = eventsFile
    }
}
public struct ClosedSegment: Equatable, Sendable {
    public let metadata: SegmentMetadata
    public let directoryURL: URL

    public init(metadata: SegmentMetadata, directoryURL: URL) {
        self.metadata = metadata
        self.directoryURL = directoryURL
    }

    public var eventsURL: URL {
        directoryURL.appendingPathComponent(metadata.eventsFile)
    }
}

public enum SegmentClock {
    public static let duration: TimeInterval = 10 * 60

    public static func start(for date: Date) -> Date {
        let interval = floor(date.timeIntervalSince1970 / duration) * duration
        return Date(timeIntervalSince1970: interval)
    }

    public static func end(for date: Date) -> Date {
        start(for: date).addingTimeInterval(duration)
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
