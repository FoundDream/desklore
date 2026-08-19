import Foundation

/// Buffers high-frequency click and window callbacks for a short period. The
/// latest semantic state is preserved while occurrenceCount records the number
/// of callbacks represented by the stored event.
public struct EventBurstCoalescer: Sendable {
    public let clickWindow: TimeInterval
    public let windowChangeWindow: TimeInterval

    private var pendingByStream: [String: HistoryEvent] = [:]

    public init(
        clickWindow: TimeInterval = 0.8,
        windowChangeWindow: TimeInterval = 0.75
    ) {
        self.clickWindow = clickWindow
        self.windowChangeWindow = windowChangeWindow
    }

    public mutating func ingest(_ event: HistoryEvent) -> [HistoryEvent] {
        guard let window = burstWindow(for: event.kind) else { return [event] }
        let key = streamKey(for: event)
        guard let previous = pendingByStream[key] else {
            pendingByStream[key] = event
            return []
        }

        if event.timestamp.timeIntervalSince(previous.timestamp) <= window {
            pendingByStream[key] = merge(previous, event)
            return []
        }

        pendingByStream[key] = event
        return [previous]
    }

    public mutating func flushExpired(at date: Date) -> [HistoryEvent] {
        var ready: [HistoryEvent] = []
        for (key, event) in pendingByStream {
            guard let window = burstWindow(for: event.kind),
                  date.timeIntervalSince(event.timestamp) >= window else {
                continue
            }
            ready.append(event)
            pendingByStream[key] = nil
        }
        return ready.sorted { $0.timestamp < $1.timestamp }
    }

    public mutating func flushAll() -> [HistoryEvent] {
        let ready = pendingByStream.values.sorted { $0.timestamp < $1.timestamp }
        pendingByStream.removeAll()
        return ready
    }

    private func burstWindow(for kind: HistoryEvent.Kind) -> TimeInterval? {
        switch kind {
        case .mouseClick: clickWindow
        case .windowChanged: windowChangeWindow
        default: nil
        }
    }

    private func streamKey(for event: HistoryEvent) -> String {
        var components = [
            event.kind.rawValue,
            event.application.bundleIdentifier,
            event.window?.title ?? "",
            event.window?.url ?? "",
        ]
        if event.kind == .mouseClick {
            components.append(contentsOf: [
                event.target?.role ?? "",
                event.target?.subrole ?? "",
                event.target?.identifier ?? "",
                event.target?.title ?? "",
                event.target?.description ?? "",
                event.interaction?.mouseButton ?? "",
            ])
        }
        return String(components.joined(separator: "\u{1f}").prefix(1_024))
    }

    private func merge(_ previous: HistoryEvent, _ latest: HistoryEvent) -> HistoryEvent {
        let occurrenceCount = (previous.occurrenceCount ?? 1)
            + (latest.occurrenceCount ?? 1)
        return HistoryEvent(
            id: latest.id,
            timestamp: latest.timestamp,
            kind: latest.kind,
            occurrenceCount: occurrenceCount,
            application: latest.application,
            window: latest.window,
            target: latest.target,
            interaction: latest.interaction,
            accessibility: mergedAccessibility(
                previous.accessibility,
                latest.accessibility
            )
        )
    }

    private func mergedAccessibility(
        _ previous: HistoryEvent.AccessibilityContext?,
        _ latest: HistoryEvent.AccessibilityContext?
    ) -> HistoryEvent.AccessibilityContext? {
        guard let previous else { return latest }
        guard let latest else { return previous }
        guard previous != latest else { return latest }
        // AXTree v2 lines carry stable IDs and hierarchy. De-duplicating lines
        // would corrupt that structure, so retain the two chronological views.
        let text = String(
            (previous.text + "\n" + latest.text).prefix(48_000)
        )
        let mode: HistoryEvent.AccessibilityContext.Mode =
            previous.mode == .fullTree || latest.mode == .fullTree
                ? .fullTree
                : .diffFromPrevious
        return .init(mode: mode, text: text)
    }
}
