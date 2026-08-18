import Foundation

public actor TimelineRepository {
    private let layout: StorageLayout
    private let fileManager: FileManager
    private var summarizer: any TimelineSummarizer
    private var fallbackRetryDates: [String: Date] = [:]

    public init(
        layout: StorageLayout,
        summarizer: any TimelineSummarizer = RuleBasedTimelineSummarizer(),
        fileManager: FileManager = .default
    ) {
        self.layout = layout
        self.summarizer = summarizer
        self.fileManager = fileManager
    }

    public func setSummarizer(_ summarizer: any TimelineSummarizer) {
        self.summarizer = summarizer
    }

    @discardableResult
    public func retryFallbackDocuments(
        segments: [ClosedSegment],
        at date: Date = Date(),
        cooldown: TimeInterval = 15 * 60
    ) async throws -> Int {
        let documents = try loadDocuments()
        let segmentByID = Dictionary(
            uniqueKeysWithValues: segments.map { ($0.metadata.id, $0) }
        )
        var upgraded = 0

        for document in documents where document.generator.type == "rules-fallback" {
            guard let segment = segmentByID[document.sourceSegmentID],
                  let fileURL = document.fileURL else {
                continue
            }
            if let lastAttempt = fallbackRetryDates[document.sourceSegmentID],
               date.timeIntervalSince(lastAttempt) < cooldown {
                continue
            }
            fallbackRetryDates[document.sourceSegmentID] = date
            let events = try SegmentReader.readEvents(from: segment.eventsURL)
            guard !events.isEmpty else { continue }
            let context = context(
                from: documents.filter { $0.id != document.id },
                before: segment.metadata.startedAt
            )
            let candidate = try await summarizer.summarize(
                segment: segment,
                events: events,
                context: context
            )
            guard candidate.generator.type == "llm" else { continue }

            let replacement = TimelineDocument(
                schemaVersion: candidate.schemaVersion,
                id: document.id,
                sourceSegmentID: document.sourceSegmentID,
                startedAt: document.startedAt,
                endedAt: document.endedAt,
                title: candidate.title,
                description: candidate.description,
                activityState: candidate.activityState,
                applications: candidate.applications,
                evidenceEventIDs: candidate.evidenceEventIDs,
                generator: candidate.generator,
                createdAt: document.createdAt,
                body: candidate.body,
                fileURL: fileURL
            )
            try TimelineMarkdownCodec.encode(replacement).write(
                to: fileURL,
                atomically: true,
                encoding: .utf8
            )
            upgraded += 1
        }
        return upgraded
    }

    @discardableResult
    public func generateIfNeeded(
        for segment: ClosedSegment
    ) async throws -> TimelineDocument? {
        try layout.ensureDirectories(fileManager: fileManager)
        let existing = try loadDocuments()
        if existing.contains(where: { $0.sourceSegmentID == segment.metadata.id }) {
            return nil
        }

        let events = try SegmentReader.readEvents(from: segment.eventsURL)
        guard TimelineActivityFilter.hasMeaningfulActivity(events) else { return nil }
        let context = context(from: existing, before: segment.metadata.startedAt)
        var document = try await summarizer.summarize(
            segment: segment,
            events: events,
            context: context
        )
        let destination = layout.timeline.appendingPathComponent(
            filename(for: document)
        )
        let markdown = TimelineMarkdownCodec.encode(document)
        try markdown.write(to: destination, atomically: true, encoding: .utf8)
        document.fileURL = destination
        return document
    }

    public func generatePending(
        segments: [ClosedSegment]
    ) async throws -> [TimelineDocument] {
        var generated: [TimelineDocument] = []
        for segment in segments {
            if let document = try await generateIfNeeded(for: segment) {
                generated.append(document)
            }
        }
        return generated
    }

    public func loadDocuments() throws -> [TimelineDocument] {
        try layout.ensureDirectories(fileManager: fileManager)
        let urls = try fileManager.contentsOfDirectory(
            at: layout.timeline,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )

        return urls
            .filter { $0.pathExtension.lowercased() == "md" }
            .compactMap { url in
                guard let markdown = try? String(contentsOf: url, encoding: .utf8) else {
                    return nil
                }
                return try? TimelineMarkdownCodec.decode(markdown, fileURL: url)
            }
            .filter(TimelineActivityFilter.shouldShow)
            .sorted { $0.startedAt > $1.startedAt }
    }

    public func delete(document: TimelineDocument) throws {
        guard let url = document.fileURL else { return }
        guard url.deletingLastPathComponent().standardizedFileURL
                == layout.timeline.standardizedFileURL else {
            throw CocoaError(.fileWriteNoPermission)
        }
        try fileManager.removeItem(at: url)
    }

    private func filename(for document: TimelineDocument) -> String {
        let slug = slugify(document.title)
        return "\(document.sourceSegmentID)-\(document.id)-10min-\(slug).md"
    }

    private func context(
        from documents: [TimelineDocument],
        before date: Date
    ) -> TimelineSummarizationContext {
        TimelineSummarizationContext(
            priorSummaries: documents
                .filter { $0.endedAt <= date }
                .sorted { $0.endedAt > $1.endedAt }
                .prefix(2)
                .reversed()
                .map {
                    .init(
                        startedAt: $0.startedAt,
                        endedAt: $0.endedAt,
                        title: $0.title,
                        description: $0.description
                    )
                }
        )
    }

    private func slugify(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let parts = value.lowercased().unicodeScalars.split { !allowed.contains($0) }
        let slug = parts.map(String.init).filter { !$0.isEmpty }.joined(separator: "-")
        return String((slug.isEmpty ? "activity" : slug).prefix(64))
    }
}
