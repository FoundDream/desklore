import Foundation

public actor TimelineRepository {
    private let layout: StorageLayout
    private let fileManager: FileManager
    private var summarizer: any TimelineSummarizer
    private var fallbackRetryDates: [String: Date] = [:]
    private var generationInFlight: Set<String> = []

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

        for document in documents where Self.isRetryableFallback(document) {
            guard let segment = segmentByID[document.sourceSegmentID],
                  let fileURL = document.fileURL else {
                continue
            }
            guard generationInFlight.insert(document.sourceSegmentID).inserted else {
                continue
            }
            defer { generationInFlight.remove(document.sourceSegmentID) }
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
            let rawCandidate = try await summarizer.summarize(
                segment: segment,
                events: events,
                context: context
            )
            guard rawCandidate.generator.type == "llm" else { continue }
            let candidate = addingQualityEvidence(
                to: rawCandidate,
                events: events
            )
            let report = TimelineSummaryEvaluator.evaluate(
                document: candidate,
                events: events
            )
            guard report.passesQualityGate else { continue }

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
        guard generationInFlight.insert(segment.metadata.id).inserted else {
            return nil
        }
        defer { generationInFlight.remove(segment.metadata.id) }

        try layout.ensureDirectories(fileManager: fileManager)
        let existing = try loadDocuments()
        if existing.contains(where: { $0.sourceSegmentID == segment.metadata.id }) {
            return nil
        }

        let events = try SegmentReader.readEvents(from: segment.eventsURL)
        guard TimelineActivityFilter.hasMeaningfulActivity(events) else { return nil }
        let context = context(from: existing, before: segment.metadata.startedAt)
        let rawDocument = try await summarizer.summarize(
            segment: segment,
            events: events,
            context: context
        )
        var document = try await documentForPersistence(
            rawDocument,
            segment: segment,
            events: events,
            context: context
        )

        // Actor methods can be re-entered while awaiting the summarizer, and
        // files can also be added externally. Recheck immediately before the
        // atomic write even though this process holds the in-flight token.
        let refreshed = try loadDocuments()
        guard !refreshed.contains(where: {
            $0.sourceSegmentID == segment.metadata.id
        }) else {
            return nil
        }
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

        let decoded = urls
            .filter { $0.pathExtension.lowercased() == "md" }
            .compactMap { url in
                guard let markdown = try? String(contentsOf: url, encoding: .utf8) else {
                    return nil
                }
                return try? TimelineMarkdownCodec.decode(markdown, fileURL: url)
            }
            .filter(TimelineActivityFilter.shouldShow)

        // Preserve duplicate files on disk for recoverability, but never show
        // contradictory summaries for one source segment in the timeline.
        var bySegment: [String: TimelineDocument] = [:]
        for document in decoded {
            if let current = bySegment[document.sourceSegmentID] {
                bySegment[document.sourceSegmentID] = preferredDocument(
                    current,
                    document
                )
            } else {
                bySegment[document.sourceSegmentID] = document
            }
        }
        return bySegment.values.sorted { $0.startedAt > $1.startedAt }
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

    private func documentForPersistence(
        _ rawDocument: TimelineDocument,
        segment: ClosedSegment,
        events: [HistoryEvent],
        context: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        let candidate = addingQualityEvidence(to: rawDocument, events: events)
        let report = TimelineSummaryEvaluator.evaluate(
            document: candidate,
            events: events
        )

        if candidate.generator.type == "llm", !report.passesQualityGate {
            let fallback = try await RuleBasedTimelineSummarizer().summarize(
                segment: segment,
                events: events,
                context: context
            )
            let markedFallback = copy(
                fallback,
                generator: .init(type: "rules-quality-fallback", version: 1)
            )
            let preparedFallback = addingQualityEvidence(
                to: markedFallback,
                events: events
            )
            let fallbackReport = TimelineSummaryEvaluator.evaluate(
                document: preparedFallback,
                events: events
            )
            guard fallbackReport.passesIntegrityGate else {
                throw TimelineRepositoryError.integrityGateFailed
            }
            return preparedFallback
        }

        guard report.passesIntegrityGate else {
            throw TimelineRepositoryError.integrityGateFailed
        }
        return candidate
    }

    private func addingQualityEvidence(
        to document: TimelineDocument,
        events: [HistoryEvent],
        limit: Int = 64
    ) -> TimelineDocument {
        let initial = TimelineSummaryEvaluator.evaluate(
            document: document,
            events: events
        )
        guard !initial.passesQualityGate else { return document }

        var ids = document.evidenceEventIDs.map { $0.lowercased() }
        var seen = Set(ids)
        for event in TimelineEventSampler.sample(events, limit: limit) {
            let id = event.id.uuidString.lowercased()
            if ids.count < limit, seen.insert(id).inserted {
                ids.append(id)
            }
        }
        guard ids != document.evidenceEventIDs else { return document }

        let body: String
        if document.generator.type == "llm" {
            body = replacingEvidenceSection(in: document.body, ids: ids)
        } else {
            body = document.body
        }
        return copy(document, evidenceEventIDs: ids, body: body)
    }

    private func replacingEvidenceSection(in body: String, ids: [String]) -> String {
        let evidence = [
            "## Evidence",
            "",
            ids.map { "- event:\($0)" }.joined(separator: "\n"),
        ].joined(separator: "\n")
        guard let range = body.range(of: "## Evidence") else {
            return [body.trimmingCharacters(in: .whitespacesAndNewlines), evidence]
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
        }
        return String(body[..<range.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
            + "\n\n"
            + evidence
    }

    private func preferredDocument(
        _ lhs: TimelineDocument,
        _ rhs: TimelineDocument
    ) -> TimelineDocument {
        let eventsURL = layout.segments
            .appendingPathComponent(lhs.sourceSegmentID, isDirectory: true)
            .appendingPathComponent("events.jsonl")
        guard let events = try? SegmentReader.readEvents(from: eventsURL),
              !events.isEmpty else {
            return fallbackPreference(lhs) >= fallbackPreference(rhs) ? lhs : rhs
        }
        let lhsReport = TimelineSummaryEvaluator.evaluate(document: lhs, events: events)
        let rhsReport = TimelineSummaryEvaluator.evaluate(document: rhs, events: events)
        return qualityScore(lhsReport, document: lhs)
            >= qualityScore(rhsReport, document: rhs) ? lhs : rhs
    }

    private func qualityScore(
        _ report: TimelineEvaluationReport,
        document: TimelineDocument
    ) -> Double {
        (report.passesQualityGate ? 10_000 : 0)
            + (report.passesIntegrityGate ? 5_000 : 0)
            + (report.activityStateSupported ? 1_000 : 0)
            + report.evidenceApplicationCoverage * 500
            + report.evidenceTemporalCoverage * 200
            + Double(report.evidenceKindCount) * 25
            + Double(min(report.evidenceCount, 64))
            + Double(fallbackPreference(document))
    }

    private func fallbackPreference(_ document: TimelineDocument) -> Int {
        let generator = document.generator.type == "llm" ? 100 : 0
        let lifecycle = document.activityState == nil
            || document.activityState == .unknown ? 0 : 10
        return generator + lifecycle + min(document.evidenceEventIDs.count, 64)
    }

    private func copy(
        _ document: TimelineDocument,
        evidenceEventIDs: [String]? = nil,
        generator: TimelineDocument.Generator? = nil,
        body: String? = nil
    ) -> TimelineDocument {
        TimelineDocument(
            schemaVersion: document.schemaVersion,
            id: document.id,
            sourceSegmentID: document.sourceSegmentID,
            startedAt: document.startedAt,
            endedAt: document.endedAt,
            title: document.title,
            description: document.description,
            activityState: document.activityState,
            applications: document.applications,
            evidenceEventIDs: evidenceEventIDs ?? document.evidenceEventIDs,
            generator: generator ?? document.generator,
            createdAt: document.createdAt,
            body: body ?? document.body,
            fileURL: document.fileURL
        )
    }

    private static func isRetryableFallback(_ document: TimelineDocument) -> Bool {
        document.generator.type == "rules-fallback"
            || document.generator.type == "rules-quality-fallback"
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

public enum TimelineRepositoryError: Error, Equatable {
    case integrityGateFailed
}
