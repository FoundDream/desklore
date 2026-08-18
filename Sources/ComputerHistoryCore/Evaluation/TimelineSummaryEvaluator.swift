import Foundation

public struct TimelineEvaluationReport: Codable, Equatable, Sendable {
    public let eventCount: Int
    public let evidenceCount: Int
    public let invalidEvidenceEventIDs: [String]
    /// Coverage of applications explicitly named by the summary prose.
    public let evidenceApplicationCoverage: Double
    public let unlistedEvidenceApplicationIDs: [String]
    /// Fraction of occupied timeline buckets containing at least one citation.
    public let evidenceTemporalCoverage: Double
    public let evidenceKindCoverage: Double
    public let observedKindCount: Int
    public let evidenceKindCount: Int
    public let hasSpecificTitle: Bool
    public let hasSubstantiveDescription: Bool
    public let containsSensitiveResidual: Bool
    public let detectedActivityState: TimelineActivityState
    public let activityStateSupported: Bool
    public let milestoneEvidenceCount: Int

    public var passesIntegrityGate: Bool {
        eventCount > 0
            && evidenceCount > 0
            && invalidEvidenceEventIDs.isEmpty
            && unlistedEvidenceApplicationIDs.isEmpty
            && evidenceApplicationCoverage == 1
            && !containsSensitiveResidual
    }

    public var passesQualityGate: Bool {
        passesIntegrityGate
            && evidenceTemporalCoverage >= 0.4
            && evidenceKindCount >= min(2, observedKindCount)
            && hasSpecificTitle
            && hasSubstantiveDescription
            && activityStateSupported
    }
}

public enum TimelineSummaryEvaluator {
    public static func evaluate(
        document: TimelineDocument,
        events: [HistoryEvent]
    ) -> TimelineEvaluationReport {
        var eventByID: [String: HistoryEvent] = [:]
        for event in events {
            eventByID[event.id.uuidString.lowercased()] = event
        }
        let normalizedEvidenceIDs = document.evidenceEventIDs.map { $0.lowercased() }
        let invalidIDs = normalizedEvidenceIDs.filter { eventByID[$0] == nil }
        let evidenceEvents = normalizedEvidenceIDs.compactMap { eventByID[$0] }
        let evidenceApplications = Set(
            evidenceEvents.map { $0.application.bundleIdentifier }
        )
        let listedApplications = Set(document.applications.map(\.bundleIdentifier))
        let unlistedApplications = evidenceApplications
            .subtracting(listedApplications)
            .sorted()

        let summaryText = [document.title, document.description, document.body]
            .joined(separator: "\n")
        let normalizedSummary = summaryText.lowercased()
        let mentionedApplications: Set<String> = Set(
            document.applications.compactMap { application -> String? in
                let name = application.name
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                let bundle = application.bundleIdentifier.lowercased()
                guard (!name.isEmpty && normalizedSummary.contains(name))
                        || normalizedSummary.contains(bundle) else {
                    return nil
                }
                return application.bundleIdentifier
            }
        )
        let applicationCoverage = mentionedApplications.isEmpty
            ? (evidenceEvents.isEmpty ? 0 : 1)
            : Double(evidenceApplications.intersection(mentionedApplications).count)
                / Double(mentionedApplications.count)

        let temporalCoverage = temporalCoverage(
            events: events,
            evidenceEvents: evidenceEvents
        )
        let eventKinds = Set(events.map(\.kind))
        let evidenceKinds = Set(evidenceEvents.map(\.kind))
        let kindCoverage = eventKinds.isEmpty
            ? 0
            : Double(evidenceKinds.intersection(eventKinds).count)
                / Double(eventKinds.count)

        let normalizedTitle = document.title
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let genericTitles = ["计算机活动", "computer activity"]
        let hasSpecificTitle = normalizedTitle.count >= 6
            && !genericTitles.contains(normalizedTitle)
            && !normalizedTitle.hasPrefix("使用 ")
        let normalizedDescription = document.description
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasSubstantiveDescription = normalizedDescription.count >= 32
            && !normalizedDescription.contains("个有效交互事件")
        let containsSensitiveResidual = PrivacySanitizer.clean(
            summaryText,
            limit: summaryText.count
        ) != summaryText
        let lifecycle = TimelineLifecycleDetector.detect(in: events)
        let activityStateSupported = document.activityState.map {
            TimelineLifecycleDetector.supports(
                observed: lifecycle.state,
                summarized: $0
            )
        } ?? true
        let milestoneEvidenceCount = evidenceEvents.filter {
            TimelineLifecycleDetector.milestoneScore(for: $0) >= 3
        }.count

        return TimelineEvaluationReport(
            eventCount: events.count,
            evidenceCount: normalizedEvidenceIDs.count,
            invalidEvidenceEventIDs: invalidIDs,
            evidenceApplicationCoverage: applicationCoverage,
            unlistedEvidenceApplicationIDs: unlistedApplications,
            evidenceTemporalCoverage: temporalCoverage,
            evidenceKindCoverage: kindCoverage,
            observedKindCount: eventKinds.count,
            evidenceKindCount: evidenceKinds.count,
            hasSpecificTitle: hasSpecificTitle,
            hasSubstantiveDescription: hasSubstantiveDescription,
            containsSensitiveResidual: containsSensitiveResidual,
            detectedActivityState: lifecycle.state,
            activityStateSupported: activityStateSupported,
            milestoneEvidenceCount: milestoneEvidenceCount
        )
    }

    private static func temporalCoverage(
        events: [HistoryEvent],
        evidenceEvents: [HistoryEvent],
        bucketCount: Int = 5
    ) -> Double {
        guard !events.isEmpty, !evidenceEvents.isEmpty else { return 0 }
        guard let first = events.map(\.timestamp).min(),
              let last = events.map(\.timestamp).max() else {
            return 0
        }
        let duration = last.timeIntervalSince(first)
        guard duration > 0 else { return 1 }

        func bucket(for date: Date) -> Int {
            let progress = max(0, min(1, date.timeIntervalSince(first) / duration))
            return min(bucketCount - 1, Int(progress * Double(bucketCount)))
        }
        let occupied = Set(events.map { bucket(for: $0.timestamp) })
        let evidenced = Set(evidenceEvents.map { bucket(for: $0.timestamp) })
        return Double(occupied.intersection(evidenced).count)
            / Double(occupied.count)
    }
}
