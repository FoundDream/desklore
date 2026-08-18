import Foundation

/// Reduces noisy OS callbacks into semantic events before they reach storage or
/// the timeline model. State is kept per app/field so unrelated activity never
/// suppresses a meaningful transition.
public struct EventCoalescer: Sendable {
    public let duplicateWindow: TimeInterval
    public let unchangedHeartbeatWindow: TimeInterval
    public let textInputWindow: TimeInterval
    public let selectionWindow: TimeInterval

    private var lastAcceptedByStream: [String: HistoryEvent] = [:]
    private var lastAcceptedTextByStream: [String: String] = [:]

    public init(
        duplicateWindow: TimeInterval = 0.4,
        unchangedHeartbeatWindow: TimeInterval = .infinity,
        textInputWindow: TimeInterval = 0.35,
        selectionWindow: TimeInterval = 0.2
    ) {
        self.duplicateWindow = duplicateWindow
        self.unchangedHeartbeatWindow = unchangedHeartbeatWindow
        self.textInputWindow = textInputWindow
        self.selectionWindow = selectionWindow
    }

    /// Returns the normalized event to persist, or `nil` when the callback is
    /// redundant. Text-field snapshots are converted to changes and the full
    /// field value is removed from the target payload.
    public mutating func process(_ event: HistoryEvent) -> HistoryEvent? {
        let stream = streamKey(for: event)
        let previous = lastAcceptedByStream[stream]
        let elapsed = previous.map {
            event.timestamp.timeIntervalSince($0.timestamp)
        } ?? .infinity

        if event.kind == .selectionChanged {
            let selection = event.interaction?.selectedText?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let selection, !selection.isEmpty else { return nil }
            if elapsed < selectionWindow { return nil }
            if previous?.interaction?.selectedText == event.interaction?.selectedText {
                return nil
            }
        }

        if event.kind == .windowChanged, let previous {
            let sameWindow = event.application == previous.application
                && event.window == previous.window
            if sameWindow {
                if elapsed <= duplicateWindow { return nil }
                let hasNewAXContext = event.accessibility != nil
                    && event.accessibility != previous.accessibility
                if !hasNewAXContext, elapsed < unchangedHeartbeatWindow {
                    return nil
                }
            }
        }

        var normalized = event
        if event.kind == .keyboardTextInput {
            guard let currentText = event.interaction?.text ?? event.target?.value else {
                return nil
            }
            if elapsed < textInputWindow { return nil }
            let previousText = lastAcceptedTextByStream[stream]
            guard previousText != currentText else { return nil }
            normalized = replacingText(
                in: event,
                with: textDelta(from: previousText, to: currentText)
            )
            lastAcceptedTextByStream[stream] = currentText
        }

        if event.kind != .mouseClick,
           event.kind != .windowChanged,
           let previous,
           elapsed <= duplicateWindow,
           samePayload(normalized, previous) {
            return nil
        }

        lastAcceptedByStream[stream] = normalized
        return normalized
    }

    /// Compatibility helper for callers that only need a decision.
    public mutating func accept(_ event: HistoryEvent) -> Bool {
        process(event) != nil
    }

    private func streamKey(for event: HistoryEvent) -> String {
        var components = [
            event.kind.rawValue,
            event.application.bundleIdentifier,
        ]
        if event.kind == .keyboardTextInput || event.kind == .selectionChanged {
            components.append(event.window?.title ?? "")
            components.append(event.target?.identifier ?? "")
            components.append(event.target?.role ?? "")
            components.append(event.target?.title ?? "")
            components.append(event.target?.description ?? "")
            components.append(event.target?.placeholder ?? "")
        }
        return String(components.joined(separator: "\u{1f}").prefix(768))
    }

    private func samePayload(_ lhs: HistoryEvent, _ rhs: HistoryEvent) -> Bool {
        lhs.kind == rhs.kind
            && lhs.application == rhs.application
            && lhs.window == rhs.window
            && lhs.target == rhs.target
            && lhs.interaction == rhs.interaction
            && (lhs.accessibility == nil || lhs.accessibility == rhs.accessibility)
    }

    private func replacingText(
        in event: HistoryEvent,
        with text: String
    ) -> HistoryEvent {
        let target = event.target.map {
            HistoryEvent.Target(
                role: $0.role,
                subrole: $0.subrole,
                identifier: $0.identifier,
                title: $0.title,
                description: $0.description,
                placeholder: $0.placeholder,
                value: nil
            )
        }
        let oldInteraction = event.interaction
        let interaction = HistoryEvent.Interaction(
            text: text,
            selectedText: oldInteraction?.selectedText,
            keyEquivalent: oldInteraction?.keyEquivalent,
            modifiers: oldInteraction?.modifiers,
            mouseButton: oldInteraction?.mouseButton,
            clickCount: oldInteraction?.clickCount,
            mouseOrigin: oldInteraction?.mouseOrigin,
            mouseDestination: oldInteraction?.mouseDestination
        )
        return HistoryEvent(
            id: event.id,
            timestamp: event.timestamp,
            kind: event.kind,
            occurrenceCount: event.occurrenceCount,
            application: event.application,
            window: event.window,
            target: target,
            interaction: interaction,
            accessibility: event.accessibility
        )
    }

    private func textDelta(from previous: String?, to current: String) -> String {
        guard let previous else { return current }
        if current.hasPrefix(previous) {
            let suffix = current.dropFirst(previous.count)
            return suffix.isEmpty ? current : String(suffix)
        }
        if previous.hasPrefix(current) {
            return "<deleted:\(previous.count - current.count)>"
        }
        return current
    }
}
