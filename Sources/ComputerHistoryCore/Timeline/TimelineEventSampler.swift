import Foundation

/// Selects a compact but semantically representative event set. Application
/// presence and rare action kinds are guaranteed before the remaining budget
/// is used for app transitions and uniform timeline coverage.
public enum TimelineEventSampler {
    public static func sample(
        _ events: [HistoryEvent],
        limit: Int
    ) -> [HistoryEvent] {
        let sorted = events.sorted {
            if $0.timestamp == $1.timestamp {
                return $0.id.uuidString < $1.id.uuidString
            }
            return $0.timestamp < $1.timestamp
        }
        let limit = max(1, limit)
        guard sorted.count > limit else { return sorted }
        guard limit > 1 else { return [sorted[0]] }

        var selectedIDs: Set<UUID> = []
        var selected: [HistoryEvent] = []
        func add(_ event: HistoryEvent) {
            guard selected.count < limit,
                  selectedIDs.insert(event.id).inserted else {
                return
            }
            selected.append(event)
        }

        add(sorted[0])
        add(sorted[sorted.count - 1])

        // Progress and validation evidence must survive high-volume click or
        // window-change streams, otherwise a summary can regress a completed
        // implementation back to "planning".
        let milestoneBudget = max(2, min(24, limit / 4))
        let milestoneEvents = sorted
            .filter { TimelineLifecycleDetector.milestoneScore(for: $0) >= 3 }
            .sorted {
                let lhs = TimelineLifecycleDetector.milestoneScore(for: $0)
                let rhs = TimelineLifecycleDetector.milestoneScore(for: $1)
                if lhs == rhs { return $0.timestamp < $1.timestamp }
                return lhs > rhs
            }
        for event in milestoneEvents.prefix(milestoneBudget) { add(event) }

        // Rich AX snapshots often hold the only semantic account of what was
        // visible, especially for browser and editor content.
        let accessibilityBudget = max(2, min(16, limit / 8))
        let accessibilityEvents = sorted
            .filter { !($0.accessibility?.text.isEmpty ?? true) }
            .sorted {
                ($0.accessibility?.text.count ?? 0) > ($1.accessibility?.text.count ?? 0)
            }
        for event in accessibilityEvents.prefix(accessibilityBudget) { add(event) }

        let applicationGroups = orderedGroups(
            sorted,
            key: { $0.application.bundleIdentifier }
        )
        // Every briefly visited app gets evidence before dominant apps consume
        // the input budget.
        for group in applicationGroups { if let first = group.first { add(first) } }
        for group in applicationGroups { if let last = group.last { add(last) } }
        for group in applicationGroups {
            if let semantic = group.max(by: {
                eventPriority($0) < eventPriority($1)
            }) {
                add(semantic)
            }
        }

        let kindGroups = orderedGroups(sorted, key: { $0.kind.rawValue })
        for group in kindGroups {
            if let first = group.first { add(first) }
            if let last = group.last { add(last) }
        }

        let transitions = sorted.enumerated().compactMap { index, event -> HistoryEvent? in
            guard index > 0,
                  sorted[index - 1].application.bundleIdentifier
                    != event.application.bundleIdentifier else {
                return nil
            }
            return event
        }
        addEvenly(transitions, into: &selected, ids: &selectedIDs, limit: limit)
        addEvenly(sorted, into: &selected, ids: &selectedIDs, limit: limit)

        return selected.sorted {
            if $0.timestamp == $1.timestamp {
                return $0.id.uuidString < $1.id.uuidString
            }
            return $0.timestamp < $1.timestamp
        }
    }

    private static func orderedGroups<Key: Hashable>(
        _ events: [HistoryEvent],
        key: (HistoryEvent) -> Key
    ) -> [[HistoryEvent]] {
        var order: [Key] = []
        var groups: [Key: [HistoryEvent]] = [:]
        for event in events {
            let value = key(event)
            if groups[value] == nil { order.append(value) }
            groups[value, default: []].append(event)
        }
        return order.compactMap { groups[$0] }
    }

    private static func addEvenly(
        _ source: [HistoryEvent],
        into selected: inout [HistoryEvent],
        ids: inout Set<UUID>,
        limit: Int
    ) {
        guard !source.isEmpty, selected.count < limit else { return }
        let remaining = limit - selected.count
        let count = min(source.count, remaining)
        for index in 0..<count {
            let sourceIndex = count == 1
                ? source.count / 2
                : index * (source.count - 1) / (count - 1)
            let event = source[sourceIndex]
            if ids.insert(event.id).inserted { selected.append(event) }
        }
        // Even samples may overlap already selected events. Fill any unused
        // budget deterministically without losing the chronological tail.
        if selected.count < limit {
            for event in source where selected.count < limit {
                if ids.insert(event.id).inserted { selected.append(event) }
            }
        }
    }

    private static func semanticPriority(_ kind: HistoryEvent.Kind) -> Int {
        switch kind {
        case .keyboardSubmit: 8
        case .keyboardShortcut: 7
        case .keyboardTextInput: 6
        case .selectionChanged: 5
        case .mouseDrag: 4
        case .mouseContextMenu: 4
        case .mouseClick: 3
        case .windowChanged: 1
        }
    }

    private static func eventPriority(_ event: HistoryEvent) -> Int {
        let accessibilitySize = min(9, (event.accessibility?.text.count ?? 0) / 512)
        return TimelineLifecycleDetector.milestoneScore(for: event) * 100
            + semanticPriority(event.kind) * 10
            + accessibilitySize
    }
}
