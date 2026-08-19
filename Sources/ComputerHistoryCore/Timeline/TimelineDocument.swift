import Foundation

public struct TimelineDocument: Equatable, Identifiable, Sendable {
    public static let currentSchemaVersion = 2

    public struct Generator: Equatable, Sendable {
        public let type: String
        public let version: Int
        public let model: String?

        public init(type: String, version: Int, model: String? = nil) {
            self.type = type
            self.version = version
            self.model = model
        }
    }

    public let schemaVersion: Int
    public let id: String
    public let sourceSegmentID: String
    public let startedAt: Date
    public let endedAt: Date
    public let title: String
    public let description: String
    public let activityState: TimelineActivityState?
    public let applications: [HistoryEvent.Application]
    public let evidenceEventIDs: [String]
    public let generator: Generator
    public let createdAt: Date
    public let body: String
    public var fileURL: URL?

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        id: String = UUID().uuidString.lowercased(),
        sourceSegmentID: String,
        startedAt: Date,
        endedAt: Date,
        title: String,
        description: String,
        activityState: TimelineActivityState? = nil,
        applications: [HistoryEvent.Application],
        evidenceEventIDs: [String] = [],
        generator: Generator,
        createdAt: Date = Date(),
        body: String,
        fileURL: URL? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.sourceSegmentID = sourceSegmentID
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.title = title
        self.description = description
        self.activityState = activityState
        self.applications = applications
        self.evidenceEventIDs = evidenceEventIDs
        self.generator = generator
        self.createdAt = createdAt
        self.body = body
        self.fileURL = fileURL
    }
}
