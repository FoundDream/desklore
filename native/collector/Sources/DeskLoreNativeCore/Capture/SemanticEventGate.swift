import Foundation

public struct SemanticEventGate: Sendable {
    private struct SelectionState: Sendable {
        let selectedText: String?
        let acceptedAt: Date
    }

    private var selectionByStream: [String: SelectionState] = [:]

    public init() {}

    public mutating func acceptsSelection(
        streamID: String,
        selectedText: String?,
        at timestamp: Date = Date()
    ) -> Bool {
        let trimmedText = selectedText?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let normalizedText = trimmedText?.isEmpty == false ? trimmedText : nil
        if let previous = selectionByStream[streamID],
           previous.selectedText == normalizedText {
            let minimumInterval = normalizedText == nil ? 0.4 : 1.5
            if timestamp.timeIntervalSince(previous.acceptedAt) < minimumInterval {
                return false
            }
        }
        selectionByStream[streamID] = SelectionState(
            selectedText: normalizedText,
            acceptedAt: timestamp
        )
        return true
    }

    public mutating func reset() {
        selectionByStream.removeAll(keepingCapacity: true)
    }
}
