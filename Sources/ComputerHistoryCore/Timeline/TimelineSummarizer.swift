import Foundation

public struct TimelineSummarizationContext: Equatable, Sendable {
    public struct PriorSummary: Equatable, Sendable {
        public let startedAt: Date
        public let endedAt: Date
        public let title: String
        public let description: String

        public init(
            startedAt: Date,
            endedAt: Date,
            title: String,
            description: String
        ) {
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.title = title
            self.description = description
        }
    }

    public let priorSummaries: [PriorSummary]

    public init(priorSummaries: [PriorSummary] = []) {
        self.priorSummaries = priorSummaries
    }
}

public protocol TimelineSummarizer: Sendable {
    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context: TimelineSummarizationContext
    ) async throws -> TimelineDocument
}

public extension TimelineSummarizer {
    func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent]
    ) async throws -> TimelineDocument {
        try await summarize(
            segment: segment,
            events: events,
            context: TimelineSummarizationContext()
        )
    }
}

public struct RuleBasedTimelineSummarizer: TimelineSummarizer {
    public init() {}

    public func summarize(
        segment: ClosedSegment,
        events: [HistoryEvent],
        context _: TimelineSummarizationContext
    ) async throws -> TimelineDocument {
        let applications = orderedApplications(events)
        let dominantWindow = dominantWindowTitle(events)
        let title = makeTitle(
            applications: applications,
            dominantWindow: dominantWindow
        )
        let description = makeDescription(
            events: events,
            applications: applications
        )
        let body = makeBody(events: events)
        let lifecycle = TimelineLifecycleDetector.detect(in: events)

        return TimelineDocument(
            sourceSegmentID: segment.metadata.id,
            startedAt: segment.metadata.startedAt,
            endedAt: segment.metadata.endedAt
                ?? segment.metadata.startedAt.addingTimeInterval(SegmentClock.duration),
            title: title,
            description: description,
            activityState: lifecycle.state,
            applications: applications,
            evidenceEventIDs: sampledEvidenceIDs(events),
            generator: .init(type: "rules", version: 1),
            body: body
        )
    }

    private func sampledEvidenceIDs(
        _ events: [HistoryEvent],
        limit: Int = 64
    ) -> [String] {
        let sorted = events.sorted { $0.timestamp < $1.timestamp }
        guard sorted.count > limit, limit > 1 else {
            return sorted.map { $0.id.uuidString.lowercased() }
        }
        return (0..<limit).map { index in
            let sourceIndex = index * (sorted.count - 1) / (limit - 1)
            return sorted[sourceIndex].id.uuidString.lowercased()
        }
    }

    private func orderedApplications(
        _ events: [HistoryEvent]
    ) -> [HistoryEvent.Application] {
        var counts: [HistoryEvent.Application: Int] = [:]
        for event in events {
            counts[event.application, default: 0] += 1
        }
        return counts.keys.sorted {
            let lhs = counts[$0, default: 0]
            let rhs = counts[$1, default: 0]
            if lhs == rhs { return $0.name < $1.name }
            return lhs > rhs
        }
    }

    private func dominantWindowTitle(_ events: [HistoryEvent]) -> String? {
        var counts: [String: Int] = [:]
        for title in events.compactMap({ normalized($0.window?.title) }) {
            counts[title, default: 0] += 1
        }
        return counts.max { lhs, rhs in lhs.value < rhs.value }?.key
    }

    private func makeTitle(
        applications: [HistoryEvent.Application],
        dominantWindow: String?
    ) -> String {
        if let dominantWindow {
            return String(dominantWindow.prefix(80))
        }
        if let application = applications.first {
            return "使用 \(application.name)"
        }
        return "计算机活动"
    }

    private func makeDescription(
        events: [HistoryEvent],
        applications: [HistoryEvent.Application]
    ) -> String {
        let names = applications.prefix(3).map(\.name)
        guard !names.isEmpty else {
            return "这个时间段没有可总结的活动。"
        }
        let appText = names.joined(separator: "、")
        return "在 \(appText) 中记录了 \(events.count) 个有效交互事件。"
    }

    private func makeBody(events: [HistoryEvent]) -> String {
        let runs = ActivityRun.make(from: events)
        guard !runs.isEmpty else {
            return "## 活动\n\n这个时间段没有可总结的活动。"
        }

        var lines = ["## 活动", ""]
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = .current
        formatter.dateFormat = "HH:mm"

        for run in runs {
            let start = formatter.string(from: run.startedAt)
            let end = formatter.string(from: run.endedAt)
            var detail = run.application.name
            if let title = normalized(run.windowTitle) {
                detail += "：\(title)"
            }
            lines.append("- \(start)–\(end)：\(detail)")
        }

        let references = uniqueReferences(events)
        if !references.isEmpty {
            lines.append(contentsOf: ["", "## 相关位置", ""])
            lines.append(contentsOf: references.map { "- \($0)" })
        }
        return lines.joined(separator: "\n")
    }

    private func uniqueReferences(_ events: [HistoryEvent]) -> [String] {
        var seen: Set<String> = []
        var values: [String] = []
        for value in events.compactMap({ normalized($0.window?.url) }) {
            guard !seen.contains(value) else { continue }
            seen.insert(value)
            values.append(value)
            if values.count == 8 { break }
        }
        return values
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct ActivityRun {
    let application: HistoryEvent.Application
    let windowTitle: String?
    let startedAt: Date
    var endedAt: Date

    static func make(
        from events: [HistoryEvent],
        idleBoundary: TimeInterval = 120
    ) -> [ActivityRun] {
        let sorted = events.sorted { $0.timestamp < $1.timestamp }
        var runs: [ActivityRun] = []

        for event in sorted {
            if var last = runs.last,
               event.timestamp.timeIntervalSince(last.endedAt) <= idleBoundary,
               last.application == event.application,
               last.windowTitle == event.window?.title {
                last.endedAt = event.timestamp
                runs[runs.count - 1] = last
            } else {
                runs.append(
                    ActivityRun(
                        application: event.application,
                        windowTitle: event.window?.title,
                        startedAt: event.timestamp,
                        endedAt: event.timestamp
                    )
                )
            }
        }
        return runs
    }
}
