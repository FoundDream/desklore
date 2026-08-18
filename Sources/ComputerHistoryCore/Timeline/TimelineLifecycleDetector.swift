import Foundation

public enum TimelineActivityState: String, Codable, CaseIterable, Sendable {
    case researching
    case planning
    case implementationStarted = "implementation_started"
    case implementationCompleted = "implementation_completed"
    case validated
    case blocked
    case unknown
}

public struct TimelineLifecycleDetection: Equatable, Sendable {
    public let state: TimelineActivityState
    public let milestoneEventIDs: [UUID]

    public init(state: TimelineActivityState, milestoneEventIDs: [UUID]) {
        self.state = state
        self.milestoneEventIDs = milestoneEventIDs
    }
}

/// Detects coarse task progression from the evidence already captured in a
/// segment. This is intentionally deterministic: it provides a guardrail for
/// both the local rules summary and the LLM summary.
public enum TimelineLifecycleDetector {
    public static func detect(in events: [HistoryEvent]) -> TimelineLifecycleDetection {
        let scored = events.map { event in
            (event: event, state: state(for: event), score: milestoneScore(for: event))
        }
        let strongest = scored.max { lhs, rhs in
            if lhs.score == rhs.score {
                return lhs.event.timestamp < rhs.event.timestamp
            }
            return lhs.score < rhs.score
        }
        let milestones = scored
            .filter { $0.score >= rank(.implementationStarted) }
            .sorted { $0.event.timestamp < $1.event.timestamp }
            .map { $0.event.id }

        return TimelineLifecycleDetection(
            state: strongest?.state ?? .unknown,
            milestoneEventIDs: milestones
        )
    }

    public static func milestoneScore(for event: HistoryEvent) -> Int {
        rank(state(for: event))
    }

    public static func supports(
        observed: TimelineActivityState,
        summarized: TimelineActivityState
    ) -> Bool {
        // The deterministic detector is a floor, not a ceiling. The model can
        // infer a stronger state from nuanced evidence that lacks our explicit
        // markers, but it cannot regress a strong observed milestone.
        switch observed {
        case .validated:
            return summarized == .validated
        case .implementationCompleted:
            return summarized == .implementationCompleted || summarized == .validated
        case .implementationStarted:
            return summarized == .implementationStarted
                || summarized == .implementationCompleted
                || summarized == .validated
        case .blocked:
            return summarized == .blocked
        case .researching, .planning, .unknown:
            return true
        }
    }

    private static func state(for event: HistoryEvent) -> TimelineActivityState {
        let text = semanticText(for: event).lowercased()
        guard !text.isEmpty else { return .unknown }

        if containsAny(text, markers: validatedMarkers) { return .validated }
        if containsAny(text, markers: completedMarkers) { return .implementationCompleted }
        if containsAny(text, markers: startedMarkers) { return .implementationStarted }
        if containsAny(text, markers: blockedMarkers) { return .blocked }
        if containsAny(text, markers: planningMarkers) { return .planning }
        if containsAny(text, markers: researchingMarkers) { return .researching }
        return .unknown
    }

    private static func semanticText(for event: HistoryEvent) -> String {
        [
            event.window?.title,
            event.target?.identifier,
            event.target?.title,
            event.target?.description,
            event.target?.placeholder,
            event.target?.value,
            event.interaction?.text,
            event.interaction?.selectedText,
            event.accessibility?.text,
        ]
        .compactMap { $0 }
        .joined(separator: "\n")
    }

    private static func containsAny(_ text: String, markers: [String]) -> Bool {
        markers.contains { text.contains($0) }
    }

    private static func rank(_ state: TimelineActivityState) -> Int {
        switch state {
        case .researching, .unknown: 0
        case .planning: 1
        case .blocked: 2
        case .implementationStarted: 3
        case .implementationCompleted: 4
        case .validated: 5
        }
    }

    private static let validatedMarkers = [
        "tests passed", "test passed", "checks passed", "build complete",
        "build succeeded", "smoke test", "validation", "ready signal",
        "验证通过", "测试通过", "构建成功", "检查通过", "全部通过", "成功运行",
    ]
    private static let completedMarkers = [
        "implementation complete", "implemented", "completed", "finished",
        "created successfully", "已完成", "完成了", "实现了", "已经实现",
        "创建完成", "改动完成",
    ]
    private static let startedMarkers = [
        "implementation started", "started working", "in progress", "files changed",
        "step 1", "step 2", "step 3", "step 4", "step 5", "step 6",
        "开始实现", "开始执行", "正在实现", "进行中", "已启动", "你做吧",
    ]
    private static let blockedMarkers = [
        " blocked", "failed", "failure", "error:", "阻塞", "失败", "报错",
    ]
    private static let planningMarkers = [
        " plan", "planning", "proposal", "roadmap", "计划", "方案", "构想",
    ]
    private static let researchingMarkers = [
        "research", "investigat", "调研", "研究", "分析一下", "对比一下",
    ]
}
