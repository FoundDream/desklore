import AppKit
@preconcurrency import ApplicationServices
import ComputerHistoryCore
import Foundation

struct InteractionCapture: Sendable {
    let screenLocation: CGPoint?
    let keyEquivalent: String?
    let modifiers: [String]?
    let mouseButton: String?
    let clickCount: Int?
    let mouseOrigin: CGPoint?
    let mouseDestination: CGPoint?

    init(
        screenLocation: CGPoint? = nil,
        keyEquivalent: String? = nil,
        modifiers: [String]? = nil,
        mouseButton: String? = nil,
        clickCount: Int? = nil,
        mouseOrigin: CGPoint? = nil,
        mouseDestination: CGPoint? = nil
    ) {
        self.screenLocation = screenLocation
        self.keyEquivalent = keyEquivalent
        self.modifiers = modifiers
        self.mouseButton = mouseButton
        self.clickCount = clickCount
        self.mouseOrigin = mouseOrigin
        self.mouseDestination = mouseDestination
    }
}

@MainActor
final class AXContextReader {
    private struct AXSnapshotState {
        var text: String
        var segmentID: String
    }

    private var previousAXSnapshotByStream: [String: AXSnapshotState] = [:]

    func event(
        for application: NSRunningApplication,
        kind: HistoryEvent.Kind = .windowChanged,
        interaction capture: InteractionCapture? = nil,
        at timestamp: Date = Date()
    ) -> HistoryEvent {
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        let windowElement = element(
            attribute: kAXFocusedWindowAttribute as CFString,
            from: appElement
        )
        let focusedElement = element(
            attribute: kAXFocusedUIElementAttribute as CFString,
            from: appElement
        )
        let targetElement = capture?.screenLocation.flatMap(element(at:)) ?? focusedElement

        let windowTitle = windowElement.flatMap {
            string(attribute: kAXTitleAttribute as CFString, from: $0)
        }
        let url = windowElement.flatMap(urlString(from:))
        let target = targetElement.map(targetContext(from:))
        let selectedText = targetElement.flatMap {
            string(attribute: kAXSelectedTextAttribute as CFString, from: $0)
        }
        let resolvedKind: HistoryEvent.Kind
        if kind == .keyboardShortcut {
            resolvedKind = KeyboardEventClassifier.classify(
                keyEquivalent: capture?.keyEquivalent,
                modifiers: capture?.modifiers,
                target: target
            )
        } else {
            resolvedKind = kind
        }
        let interaction = interactionContext(
            kind: resolvedKind,
            target: target,
            selectedText: selectedText,
            capture: capture
        )
        let bundleIdentifier = application.bundleIdentifier
            ?? "pid.\(application.processIdentifier)"
        let accessibility = windowElement.flatMap {
            accessibilityContext(
                from: $0,
                bundleIdentifier: bundleIdentifier,
                windowTitle: windowTitle,
                url: url,
                timestamp: timestamp
            )
        }

        return HistoryEvent(
            timestamp: timestamp,
            kind: resolvedKind,
            application: .init(
                bundleIdentifier: bundleIdentifier,
                name: application.localizedName ?? "Unknown application"
            ),
            window: .init(
                title: windowTitle,
                url: url,
                isPrivateBrowsing: isPrivateBrowsing(
                    application: application,
                    windowTitle: windowTitle
                )
            ),
            target: target,
            interaction: interaction,
            accessibility: accessibility
        )
    }

    private func targetContext(from element: AXUIElement) -> HistoryEvent.Target {
        let role = string(attribute: kAXRoleAttribute as CFString, from: element)
        let subrole = string(attribute: kAXSubroleAttribute as CFString, from: element)
        let identifier = string(
            attribute: kAXIdentifierAttribute as CFString,
            from: element
        )
        let title = string(attribute: kAXTitleAttribute as CFString, from: element)
        let description = string(
            attribute: kAXDescriptionAttribute as CFString,
            from: element
        )
        let placeholder = string(
            attribute: kAXPlaceholderValueAttribute as CFString,
            from: element
        )
        let safeProbe = HistoryEvent.Target(
            role: role,
            subrole: subrole,
            identifier: identifier,
            title: title,
            description: description,
            placeholder: placeholder
        )
        let targetValue: String?
        if isTextRole(role), !PrivacySanitizer.isSensitiveTarget(safeProbe) {
            targetValue = string(attribute: kAXValueAttribute as CFString, from: element)
        } else {
            targetValue = nil
        }
        return HistoryEvent.Target(
            role: role,
            subrole: subrole,
            identifier: identifier,
            title: title,
            description: description,
            placeholder: placeholder,
            value: targetValue
        )
    }

    private func interactionContext(
        kind: HistoryEvent.Kind,
        target: HistoryEvent.Target?,
        selectedText: String?,
        capture: InteractionCapture?
    ) -> HistoryEvent.Interaction? {
        let text = kind == .keyboardTextInput ? target?.value : nil
        let selection = kind == .selectionChanged ? selectedText : nil
        guard text != nil || selection != nil || capture != nil else { return nil }
        return HistoryEvent.Interaction(
            text: text,
            selectedText: selection,
            keyEquivalent: capture?.keyEquivalent,
            modifiers: capture?.modifiers,
            mouseButton: capture?.mouseButton,
            clickCount: capture?.clickCount,
            mouseOrigin: capture?.mouseOrigin.map {
                .init(x: Double($0.x), y: Double($0.y))
            },
            mouseDestination: capture?.mouseDestination.map {
                .init(x: Double($0.x), y: Double($0.y))
            }
        )
    }

    private func accessibilityContext(
        from window: AXUIElement,
        bundleIdentifier: String,
        windowTitle: String?,
        url: String?,
        timestamp: Date
    ) -> HistoryEvent.AccessibilityContext? {
        let snapshot = snapshotText(from: window)
        guard !snapshot.isEmpty else { return nil }
        let streamKey = [bundleIdentifier, windowTitle ?? "", url ?? ""]
            .joined(separator: "\u{1f}")
        let segmentID = SegmentClock.identifier(for: timestamp)
        defer {
            previousAXSnapshotByStream[streamKey] = AXSnapshotState(
                text: snapshot,
                segmentID: segmentID
            )
        }
        guard let previous = previousAXSnapshotByStream[streamKey],
              previous.segmentID == segmentID else {
            return .init(mode: .fullTree, text: snapshot)
        }
        guard previous.text != snapshot else { return nil }

        let previousLines = Set(previous.text.components(separatedBy: .newlines))
        let currentLines = Set(snapshot.components(separatedBy: .newlines))
        let removed = previousLines.subtracting(currentLines).sorted()
        let added = currentLines.subtracting(previousLines).sorted()
        let changedLineCount = removed.count + added.count
        let baselineLineCount = max(previousLines.count, currentLines.count, 1)
        if Double(changedLineCount) / Double(baselineLineCount) >= 0.65 {
            return .init(mode: .fullTree, text: snapshot)
        }
        let diff = removed.map { "- \($0)" } + added.map { "+ \($0)" }
        let boundedDiff = String(diff.joined(separator: "\n").prefix(12_000))
        return boundedDiff.isEmpty ? nil : .init(
            mode: .diffFromPrevious,
            text: boundedDiff
        )
    }

    private func snapshotText(from root: AXUIElement) -> String {
        var lines: [String] = []
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var index = 0

        while index < queue.count, index < 500, lines.count < 240 {
            let (candidate, depth) = queue[index]
            index += 1
            let role = string(attribute: kAXRoleAttribute as CFString, from: candidate)
                ?? "AXUnknown"
            let title = string(attribute: kAXTitleAttribute as CFString, from: candidate)
            let description = string(
                attribute: kAXDescriptionAttribute as CFString,
                from: candidate
            )
            let help = string(attribute: kAXHelpAttribute as CFString, from: candidate)
            let semanticValue = snapshotValue(from: candidate, role: role)
            let detail = [title, description, help, semanticValue]
                .compactMap { PrivacySanitizer.clean($0, limit: 320) }
                .filter { !$0.isEmpty }
                .uniqued()
                .joined(separator: " | ")
            let indentation = String(repeating: "  ", count: depth)
            if !detail.isEmpty || Self.structuralRoles.contains(role) {
                lines.append(
                    "\(indentation)\(role)\(detail.isEmpty ? "" : ": \(detail)")"
                )
            }

            if depth < 8 {
                queue.append(
                    contentsOf: children(of: candidate).prefix(80).map { ($0, depth + 1) }
                )
            }
        }
        return String(lines.joined(separator: "\n").prefix(12_000))
    }

    private func snapshotValue(from element: AXUIElement, role: String) -> String? {
        let safeValueRoles: Set<String> = [
            "AXStaticText",
            "AXHeading",
            "AXParagraph",
            "AXLink",
            "AXButton",
            "AXMenuItem",
            "AXMenuButton",
            "AXCell",
            "AXRow",
            "AXListItem",
            "AXOutlineRow",
            "AXStatusItem",
            "AXProgressIndicator",
            "AXDocument",
            "AXWebArea",
        ]
        guard safeValueRoles.contains(role) else { return nil }
        return scalarString(attribute: kAXValueAttribute as CFString, from: element)
    }

    private static let structuralRoles: Set<String> = [
        "AXWindow",
        "AXSheet",
        "AXDialog",
        "AXWebArea",
        "AXDocument",
        "AXToolbar",
        "AXTabGroup",
        "AXList",
        "AXTable",
        "AXOutline",
    ]

    private func urlString(from window: AXUIElement) -> String? {
        if let direct = directURLString(from: window) { return direct }

        var queue: [(AXUIElement, Int)] = children(of: window).map { ($0, 1) }
        var index = 0
        while index < queue.count, index < 80 {
            let (candidate, depth) = queue[index]
            index += 1
            let role = string(attribute: kAXRoleAttribute as CFString, from: candidate)
            if role == "AXWebArea" || role == "AXDocument",
               let value = directURLString(from: candidate) {
                return value
            }
            if depth < 4 {
                queue.append(contentsOf: children(of: candidate).map { ($0, depth + 1) })
            }
        }
        return nil
    }

    private func directURLString(from element: AXUIElement) -> String? {
        if let value = value(attribute: kAXURLAttribute as CFString, from: element) {
            if let url = value as? URL { return url.absoluteString }
            if let string = value as? String { return string }
        }
        return string(attribute: kAXDocumentAttribute as CFString, from: element)
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        guard let value = value(attribute: kAXChildrenAttribute as CFString, from: element),
              let children = value as? [AXUIElement] else {
            return []
        }
        return children
    }

    private func element(at point: CGPoint) -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        var result: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            system,
            Float(point.x),
            Float(point.y),
            &result
        ) == .success else {
            return nil
        }
        return result
    }

    private func string(
        attribute: CFString,
        from element: AXUIElement
    ) -> String? {
        guard let value = value(attribute: attribute, from: element) else { return nil }
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        return nil
    }

    private func scalarString(
        attribute: CFString,
        from element: AXUIElement
    ) -> String? {
        guard let value = value(attribute: attribute, from: element) else { return nil }
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        if let number = value as? NSNumber { return number.stringValue }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    private func element(
        attribute: CFString,
        from element: AXUIElement
    ) -> AXUIElement? {
        guard let value = value(attribute: attribute, from: element),
              CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private func value(
        attribute: CFString,
        from element: AXUIElement
    ) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &result) == .success else {
            return nil
        }
        return result
    }

    private func isTextRole(_ role: String?) -> Bool {
        guard let role else { return false }
        return [
            kAXTextFieldRole as String,
            kAXTextAreaRole as String,
            kAXComboBoxRole as String,
            "AXSearchField",
        ].contains(role)
    }

    private func isPrivateBrowsing(
        application: NSRunningApplication,
        windowTitle: String?
    ) -> Bool {
        let browserBundles = [
            "com.apple.Safari",
            "com.google.Chrome",
            "com.brave.Browser",
            "org.mozilla.firefox",
            "com.microsoft.edgemac",
        ]
        guard let bundleIdentifier = application.bundleIdentifier,
              browserBundles.contains(bundleIdentifier) else {
            return false
        }

        let title = windowTitle?.lowercased() ?? ""
        let privateMarkers = [
            "private browsing", "private window", "incognito", "隐私浏览", "无痕",
        ]
        return privateMarkers.contains { title.contains($0) }
    }
}

private extension Array where Element == String {
    func uniqued() -> [String] {
        var seen: Set<String> = []
        return filter { seen.insert($0).inserted }
    }
}
