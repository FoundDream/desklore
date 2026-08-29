import DeskLoreNativeCore
import Foundation
import Testing

@Test("Structural selection repeats wait four hundred milliseconds")
func structuralSelectionDebounce() {
    var gate = SemanticEventGate()
    let start = Date(timeIntervalSince1970: 1_000)

    let first = gate.acceptsSelection(
        streamID: "outline",
        selectedText: nil,
        at: start
    )
    let repeated = gate.acceptsSelection(
        streamID: "outline",
        selectedText: nil,
        at: start.addingTimeInterval(0.39)
    )
    let later = gate.acceptsSelection(
        streamID: "outline",
        selectedText: nil,
        at: start.addingTimeInterval(0.401)
    )

    #expect(first)
    #expect(!repeated)
    #expect(later)
}

@Test("Text selection changes pass immediately while repeats debounce")
func textSelectionDebounce() {
    var gate = SemanticEventGate()
    let start = Date(timeIntervalSince1970: 2_000)

    let first = gate.acceptsSelection(
        streamID: "editor",
        selectedText: "first",
        at: start
    )
    let repeated = gate.acceptsSelection(
        streamID: "editor",
        selectedText: " first ",
        at: start.addingTimeInterval(1)
    )
    let changed = gate.acceptsSelection(
        streamID: "editor",
        selectedText: "second",
        at: start.addingTimeInterval(1.1)
    )

    #expect(first)
    #expect(!repeated)
    #expect(changed)
}

@Test("Empty selected text uses the structural debounce window")
func emptySelectionUsesStructuralDebounce() {
    var gate = SemanticEventGate()
    let start = Date(timeIntervalSince1970: 2_500)
    let first = gate.acceptsSelection(streamID: "editor", selectedText: "", at: start)
    let repeated = gate.acceptsSelection(
        streamID: "editor",
        selectedText: "   ",
        at: start.addingTimeInterval(0.3)
    )

    #expect(first)
    #expect(!repeated)
}

@Test("Selection streams remain independent")
func selectionStreamsRemainIndependent() {
    var gate = SemanticEventGate()
    let start = Date(timeIntervalSince1970: 3_000)

    let first = gate.acceptsSelection(
        streamID: "first-row",
        selectedText: nil,
        at: start
    )
    let second = gate.acceptsSelection(
        streamID: "second-row",
        selectedText: nil,
        at: start
    )

    #expect(first)
    #expect(second)
}
