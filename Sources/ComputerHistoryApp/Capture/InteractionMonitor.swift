import AppKit
import ComputerHistoryCore
import Foundation

@MainActor
final class InteractionMonitor {
    var onInteraction: ((HistoryEvent.Kind, InteractionCapture) -> Void)?
    var onBeforeFocusChangingInteraction: (() -> Void)?
    private var monitor: Any?
    private var pendingLeftMouse: PendingLeftMouse?

    var isActive: Bool { monitor != nil }

    private struct PendingLeftMouse {
        let origin: CGPoint
        let clickCount: Int
        let modifiers: [String]
        var destination: CGPoint
        var didDrag: Bool
    }

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(
            matching: [
                .leftMouseDown,
                .leftMouseDragged,
                .leftMouseUp,
                .rightMouseDown,
                .keyDown,
            ]
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        pendingLeftMouse = nil
    }

    private func handle(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            onBeforeFocusChangingInteraction?()
            let location = event.cgEvent?.location ?? event.locationInWindow
            pendingLeftMouse = PendingLeftMouse(
                origin: location,
                clickCount: event.clickCount,
                modifiers: modifierNames(event.modifierFlags),
                destination: location,
                didDrag: false
            )
        case .rightMouseDown:
            onBeforeFocusChangingInteraction?()
            emitMouse(event, kind: .mouseContextMenu, button: "right")
        case .leftMouseDragged:
            guard var pending = pendingLeftMouse else { return }
            pending.destination = event.cgEvent?.location ?? event.locationInWindow
            pending.didDrag = true
            pendingLeftMouse = pending
        case .leftMouseUp:
            finishLeftMouse(event)
        case .keyDown:
            handleKeyDown(event)
        default:
            break
        }
    }

    private func emitMouse(
        _ event: NSEvent,
        kind: HistoryEvent.Kind,
        button: String
    ) {
        onInteraction?(
            kind,
            InteractionCapture(
                screenLocation: event.cgEvent?.location,
                modifiers: modifierNames(event.modifierFlags),
                mouseButton: button,
                clickCount: event.clickCount
            )
        )
    }

    private func finishLeftMouse(_ event: NSEvent) {
        let destination = event.cgEvent?.location ?? event.locationInWindow
        guard var pending = pendingLeftMouse else {
            emitMouse(event, kind: .mouseClick, button: "left")
            return
        }
        pendingLeftMouse = nil
        pending.destination = destination
        let distance = hypot(
            pending.destination.x - pending.origin.x,
            pending.destination.y - pending.origin.y
        )
        guard pending.didDrag, distance >= 3 else {
            let isContextMenu = pending.modifiers.contains("ctrl")
            onInteraction?(
                isContextMenu ? .mouseContextMenu : .mouseClick,
                InteractionCapture(
                    screenLocation: destination,
                    modifiers: pending.modifiers,
                    mouseButton: "left",
                    clickCount: pending.clickCount
                )
            )
            return
        }

        onInteraction?(
            .mouseDrag,
            InteractionCapture(
                screenLocation: destination,
                modifiers: pending.modifiers,
                mouseButton: "left",
                clickCount: pending.clickCount,
                mouseOrigin: pending.origin,
                mouseDestination: pending.destination
            )
        )
    }

    private func handleKeyDown(_ event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 {
            onInteraction?(
                .keyboardShortcut,
                InteractionCapture(
                    keyEquivalent: event.keyCode == 76 ? "numpad-enter" : "return",
                    modifiers: modifierNames(event.modifierFlags)
                )
            )
            return
        }

        let modifiers = event.modifierFlags.intersection([.command, .control, .option])
        guard !modifiers.isEmpty else { return }
        var components = modifierNames(event.modifierFlags)
        if let key = event.charactersIgnoringModifiers?.lowercased(), !key.isEmpty {
            components.append(key)
        }
        onInteraction?(
            .keyboardShortcut,
            InteractionCapture(
                keyEquivalent: components.joined(separator: "+"),
                modifiers: modifierNames(event.modifierFlags)
            )
        )
    }

    private func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String] {
        var names: [String] = []
        if flags.contains(.command) { names.append("cmd") }
        if flags.contains(.control) { names.append("ctrl") }
        if flags.contains(.option) { names.append("option") }
        if flags.contains(.shift) { names.append("shift") }
        return names
    }
}
