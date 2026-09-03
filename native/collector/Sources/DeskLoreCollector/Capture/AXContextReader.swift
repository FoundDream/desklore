import AppKit
@preconcurrency import ApplicationServices
import DeskLoreNativeCore
import CryptoKit
import Foundation

struct InteractionCapture: Sendable {
    let screenLocation: CGPoint?
    let semanticTarget: HistoryEvent.Target?
    let text: String?
    let selectedText: String?
    let keyEquivalent: String?
    let modifiers: [String]?
    let mouseButton: String?
    let clickCount: Int?
    let mouseOrigin: CGPoint?
    let mouseDestination: CGPoint?

    init(
        screenLocation: CGPoint? = nil,
        semanticTarget: HistoryEvent.Target? = nil,
        text: String? = nil,
        selectedText: String? = nil,
        keyEquivalent: String? = nil,
        modifiers: [String]? = nil,
        mouseButton: String? = nil,
        clickCount: Int? = nil,
        mouseOrigin: CGPoint? = nil,
        mouseDestination: CGPoint? = nil
    ) {
        self.screenLocation = screenLocation
        self.semanticTarget = semanticTarget
        self.text = text
        self.selectedText = selectedText
        self.keyEquivalent = keyEquivalent
        self.modifiers = modifiers
        self.mouseButton = mouseButton
        self.clickCount = clickCount
        self.mouseOrigin = mouseOrigin
        self.mouseDestination = mouseDestination
    }
}

struct RunningApplicationContext: Sendable {
    let processIdentifier: pid_t
    let bundleIdentifier: String
    let name: String

    @MainActor
    init(_ application: NSRunningApplication) {
        processIdentifier = application.processIdentifier
        let resolvedName = application.localizedName ?? "Unknown application"
        name = resolvedName
        bundleIdentifier = application.bundleIdentifier
            ?? application.bundleURL.flatMap { Bundle(url: $0)?.bundleIdentifier }
            ?? Self.fallbackBundleIdentifier(for: resolvedName)
    }

    private static func fallbackBundleIdentifier(for name: String) -> String {
        let digest = SHA256.hash(data: Data(name.utf8))
        let suffix = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        return "local.unbundled.\(suffix)"
    }
}

struct AXCaptureResult: Sendable {
    let event: HistoryEvent
    let durationMilliseconds: Double
    /// True when this capture asked the application to expose its full Accessibility tree.
    let enhancedAccessibilityRequested: Bool
}

enum AXCaptureOutcome: Sendable {
    case captured(AXCaptureResult)
    case suppressed(activeDomain: String?)
}

actor AXCaptureCoordinator {
    private let reader = AXContextReader()

    func capture(
        application: RunningApplicationContext,
        kind: HistoryEvent.Kind,
        captureReason: HistoryEvent.CaptureReason,
        interaction: InteractionCapture?,
        includeRichSnapshot: Bool,
        observationPolicy: ObservationPolicy,
        timestamp: Date
    ) -> AXCaptureOutcome {
        reader.event(
            for: application,
            kind: kind,
            captureReason: captureReason,
            interaction: interaction,
            includeRichSnapshot: includeRichSnapshot,
            observationPolicy: observationPolicy,
            at: timestamp
        )
    }
}

final class AXContextReader {
    private struct AXSnapshotState {
        var snapshot: AXTreeSnapshot
        var segmentID: String
    }

    private struct AccessibilityCapture {
        let context: HistoryEvent.AccessibilityContext?
        let snapshot: AXTreeSnapshot
    }

    private struct PendingElement {
        let element: AXUIElement
        let parentID: String?
        let depth: Int
        let siblingIndex: Int
    }

    private struct NodeMetadata {
        let role: String
        let subrole: String?
        let identifier: String?
        let title: String?
        let description: String?
        let help: String?
        let placeholder: String?
        let enabled: Bool?
        let focused: Bool?
        let selected: Bool?
        let expanded: Bool?
        let disclosureLevel: Int?
    }

    private var previousAXSnapshotByStream: [String: AXSnapshotState] = [:]
    private var enhancedAccessibilityRequestedProcesses: Set<pid_t> = []

    func event(
        for application: RunningApplicationContext,
        kind: HistoryEvent.Kind = .windowChanged,
        captureReason: HistoryEvent.CaptureReason = .windowFocus,
        interaction capture: InteractionCapture? = nil,
        includeRichSnapshot: Bool = true,
        observationPolicy: ObservationPolicy,
        at timestamp: Date = Date()
    ) -> AXCaptureOutcome {
        let captureStartedAt = ProcessInfo.processInfo.systemUptime
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        _ = AXUIElementSetMessagingTimeout(appElement, 0.25)
        let windowElement = element(
            attribute: kAXFocusedWindowAttribute as CFString,
            from: appElement
        )
        let windowTitle = windowElement.flatMap {
            string(attribute: kAXTitleAttribute as CFString, from: $0)
        }
        let url = windowElement.flatMap(urlString(from:))
        let privateBrowsing = isPrivateBrowsing(
            bundleIdentifier: application.bundleIdentifier,
            windowTitle: windowTitle
        )
        let decision = observationPolicy.decision(
            bundleIdentifier: application.bundleIdentifier,
            windowTitle: windowTitle,
            url: url,
            isPrivateBrowsing: privateBrowsing
        )
        guard decision.allowed else {
            return .suppressed(activeDomain: ObservationPolicy.domain(from: url))
        }

        let focusedElement = element(
            attribute: kAXFocusedUIElementAttribute as CFString,
            from: appElement
        )
        let targetElement = capture?.screenLocation.flatMap(element(at:)) ?? focusedElement
        let windowRuntimeIdentifier = includeRichSnapshot ? windowElement.flatMap {
            windowIdentifier(
                for: $0,
                processIdentifier: application.processIdentifier,
                title: windowTitle
            )
        } : nil
        let target = capture?.semanticTarget ?? targetElement.map(targetContext(from:))
        let selectedText = capture == nil
            ? targetElement.flatMap {
                PrivacySanitizer.clean(
                    string(attribute: kAXSelectedTextAttribute as CFString, from: $0),
                    limit: 4_096
                )
            }
            : capture?.selectedText
        let interaction = interactionContext(
            kind: kind,
            target: target,
            selectedText: selectedText,
            capture: capture
        )
        let accessibilityCapture = includeRichSnapshot ? windowElement.flatMap {
            accessibilityContext(
                from: $0,
                focusedElement: focusedElement,
                bundleIdentifier: application.bundleIdentifier,
                timestamp: timestamp
            )
        } : nil
        let enhancedAccessibilityRequested = accessibilityCapture.map { capture in
            requestEnhancedAccessibilityIfNeeded(
                for: appElement,
                processIdentifier: application.processIdentifier,
                bundleIdentifier: application.bundleIdentifier,
                snapshot: capture.snapshot
            )
        } ?? false

        let event = HistoryEvent(
            timestamp: timestamp,
            kind: kind,
            captureReason: captureReason,
            application: .init(
                bundleIdentifier: application.bundleIdentifier,
                name: application.name
            ),
            window: .init(
                title: windowTitle,
                url: url,
                isPrivateBrowsing: privateBrowsing,
                runtimeIdentifier: windowRuntimeIdentifier
            ),
            target: target,
            interaction: interaction,
            accessibility: accessibilityCapture?.context
        )
        return .captured(
            AXCaptureResult(
                event: event,
                durationMilliseconds: (
                    ProcessInfo.processInfo.systemUptime - captureStartedAt
                ) * 1_000,
                enhancedAccessibilityRequested: enhancedAccessibilityRequested
            )
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
        let text = kind == .keyboardTextInput
            ? (capture?.text ?? target?.value)
            : nil
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
        focusedElement: AXUIElement?,
        bundleIdentifier: String,
        timestamp: Date
    ) -> AccessibilityCapture? {
        let snapshot = snapshot(from: window, focusedElement: focusedElement)
        guard !snapshot.nodes.isEmpty else { return nil }
        let streamKey = "\(bundleIdentifier)\u{1f}\(elementID(window))"
        let segmentID = SegmentClock.identifier(for: timestamp)
        defer {
            previousAXSnapshotByStream[streamKey] = AXSnapshotState(
                snapshot: snapshot,
                segmentID: segmentID
            )
        }
        guard let previous = previousAXSnapshotByStream[streamKey],
              previous.segmentID == segmentID else {
            return AccessibilityCapture(
                context: .init(mode: .fullTree, tree: snapshot),
                snapshot: snapshot
            )
        }
        let delta = AXTreeDiffer.diff(previous: previous.snapshot, current: snapshot)
        guard !delta.isEmpty else {
            return AccessibilityCapture(context: nil, snapshot: snapshot)
        }
        let baselineNodeCount = max(previous.snapshot.nodes.count, snapshot.nodes.count, 1)
        if Double(delta.changeCount) / Double(baselineNodeCount) >= 0.65 {
            return AccessibilityCapture(
                context: .init(mode: .fullTree, tree: snapshot),
                snapshot: snapshot
            )
        }
        return AccessibilityCapture(
            context: .init(mode: .diffFromPrevious, delta: delta),
            snapshot: snapshot
        )
    }

    private func snapshot(
        from root: AXUIElement,
        focusedElement: AXUIElement?
    ) -> AXTreeSnapshot {
        let maximumVisitedNodes = 1_200
        let maximumOutputNodes = 800
        let maximumDepth = 20
        let deadline = ProcessInfo.processInfo.systemUptime + 0.7
        let focusedPath = focusedElement.map {
            focusedPathIDs(from: $0, deadline: deadline)
        } ?? []
        let focusedElementID = focusedElement.map(elementID)
        var metadataCache: [String: NodeMetadata] = [:]
        var stack = [
            PendingElement(
                element: root,
                parentID: nil,
                depth: 0,
                siblingIndex: 0
            ),
        ]
        var visitedIDs: Set<String> = []
        var nodes: [AXTreeNode] = []
        var visitedNodeCount = 0

        func metadata(for element: AXUIElement) -> NodeMetadata {
            let id = elementID(element)
            if let cached = metadataCache[id] { return cached }
            let loaded = nodeMetadata(from: element)
            metadataCache[id] = loaded
            return loaded
        }

        while let pending = stack.popLast(),
              visitedNodeCount < maximumVisitedNodes,
              nodes.count < maximumOutputNodes,
              ProcessInfo.processInfo.systemUptime < deadline {
            let id = elementID(pending.element)
            guard visitedIDs.insert(id).inserted else { continue }
            visitedNodeCount += 1
            let nodeMetadata = metadata(for: pending.element)
            let childElements = pending.depth < maximumDepth
                ? children(of: pending.element)
                : []
            let isOnFocusedPath = focusedPath.contains(id)
            let semanticValue = snapshotValue(
                from: pending.element,
                metadata: nodeMetadata
            )
            let hasSemanticContent = [
                nodeMetadata.identifier,
                nodeMetadata.title,
                nodeMetadata.description,
                nodeMetadata.help,
                nodeMetadata.placeholder,
                semanticValue,
            ].contains { !($0?.isEmpty ?? true) }
            if hasSemanticContent
                || !childElements.isEmpty
                || Self.structuralRoles.contains(nodeMetadata.role)
                || isOnFocusedPath {
                nodes.append(
                    AXTreeNode(
                        id: id,
                        parentID: pending.parentID,
                        depth: pending.depth,
                        siblingIndex: pending.siblingIndex,
                        role: nodeMetadata.role,
                        subrole: nodeMetadata.subrole,
                        identifier: nodeMetadata.identifier,
                        title: nodeMetadata.title,
                        description: nodeMetadata.description,
                        help: nodeMetadata.help,
                        placeholder: nodeMetadata.placeholder,
                        value: semanticValue,
                        enabled: nodeMetadata.enabled,
                        focused: nodeMetadata.focused
                            ?? (id == focusedElementID ? true : nil),
                        selected: nodeMetadata.selected,
                        expanded: nodeMetadata.expanded,
                        disclosureLevel: nodeMetadata.disclosureLevel,
                        childCount: childElements.count
                    )
                )
            }

            var prioritizedChildren: [(pending: PendingElement, priority: Int)] = []
            for (index, child) in childElements.enumerated() {
                guard ProcessInfo.processInfo.systemUptime < deadline else { break }
                prioritizedChildren.append((
                    pending: PendingElement(
                        element: child,
                        parentID: id,
                        depth: pending.depth + 1,
                        siblingIndex: index
                    ),
                    priority: traversalPriority(
                        metadata: metadata(for: child),
                        isOnFocusedPath: focusedPath.contains(elementID(child))
                    )
                ))
            }
            // The stack is LIFO, so append lower-priority nodes first.
            stack.append(contentsOf: prioritizedChildren
                .sorted { lhs, rhs in
                    if lhs.priority == rhs.priority {
                        return lhs.pending.siblingIndex > rhs.pending.siblingIndex
                    }
                    return lhs.priority < rhs.priority
                }
                .map(\.pending))
        }
        let wasTruncated = !stack.isEmpty
            || visitedNodeCount >= maximumVisitedNodes
            || nodes.count >= maximumOutputNodes
            || ProcessInfo.processInfo.systemUptime >= deadline
        return AXTreeSnapshot(
            nodes: nodes,
            visitedNodeCount: visitedNodeCount,
            wasTruncated: wasTruncated
        )
    }

    private func snapshotValue(
        from element: AXUIElement,
        metadata: NodeMetadata
    ) -> String? {
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
            "AXTextField",
            "AXTextArea",
            "AXSearchField",
            "AXComboBox",
        ]
        let target = HistoryEvent.Target(
            role: metadata.role,
            subrole: metadata.subrole,
            identifier: metadata.identifier,
            title: metadata.title,
            description: metadata.description,
            placeholder: metadata.placeholder
        )
        guard safeValueRoles.contains(metadata.role),
              !PrivacySanitizer.isSensitiveTarget(target) else {
            return nil
        }
        let raw = scalarString(attribute: kAXValueAttribute as CFString, from: element)
        return PrivacySanitizer.clean(raw, limit: 1_024)
    }

    private func focusedPathIDs(
        from focusedElement: AXUIElement,
        deadline: TimeInterval
    ) -> Set<String> {
        var result: Set<String> = []
        var current: AXUIElement? = focusedElement
        var depth = 0
        while let element = current,
              depth < 32,
              ProcessInfo.processInfo.systemUptime < deadline {
            let id = elementID(element)
            guard result.insert(id).inserted else { break }
            current = self.element(
                attribute: kAXParentAttribute as CFString,
                from: element
            )
            depth += 1
        }
        return result
    }

    private func traversalPriority(
        metadata: NodeMetadata,
        isOnFocusedPath: Bool
    ) -> Int {
        if isOnFocusedPath { return 1_000 }
        switch metadata.role {
        case "AXWebArea", "AXDocument":
            return 900
        case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
            return 850
        case "AXHeading", "AXStaticText", "AXParagraph", "AXLink":
            return 800
        case "AXButton", "AXMenuButton", "AXCheckBox", "AXRadioButton":
            return 750
        case "AXTable", "AXOutline", "AXList", "AXRow", "AXCell":
            return 700
        case "AXGroup", "AXSplitGroup", "AXScrollArea", "AXToolbar", "AXTabGroup":
            return 500
        default:
            return 300
        }
    }

    private func nodeMetadata(from element: AXUIElement) -> NodeMetadata {
        let attributes: [CFString] = [
            kAXRoleAttribute as CFString,
            kAXSubroleAttribute as CFString,
            kAXIdentifierAttribute as CFString,
            kAXTitleAttribute as CFString,
            kAXDescriptionAttribute as CFString,
            kAXHelpAttribute as CFString,
            kAXPlaceholderValueAttribute as CFString,
            kAXEnabledAttribute as CFString,
            kAXFocusedAttribute as CFString,
            kAXSelectedAttribute as CFString,
            kAXExpandedAttribute as CFString,
            kAXDisclosureLevelAttribute as CFString,
        ]
        let values = multipleAttributeValues(attributes, from: element)
        func cleaned(_ attribute: CFString, limit: Int = 512) -> String? {
            PrivacySanitizer.clean(
                scalarString(values[attribute as String]),
                limit: limit
            )
        }
        return NodeMetadata(
            role: scalarString(values[kAXRoleAttribute as String]) ?? "AXUnknown",
            subrole: cleaned(kAXSubroleAttribute as CFString, limit: 128),
            identifier: cleaned(kAXIdentifierAttribute as CFString, limit: 256),
            title: cleaned(kAXTitleAttribute as CFString),
            description: cleaned(kAXDescriptionAttribute as CFString),
            help: cleaned(kAXHelpAttribute as CFString),
            placeholder: cleaned(kAXPlaceholderValueAttribute as CFString),
            enabled: boolValue(values[kAXEnabledAttribute as String]),
            focused: boolValue(values[kAXFocusedAttribute as String]),
            selected: boolValue(values[kAXSelectedAttribute as String]),
            expanded: boolValue(values[kAXExpandedAttribute as String]),
            disclosureLevel: intValue(values[kAXDisclosureLevelAttribute as String])
        )
    }

    private func multipleAttributeValues(
        _ attributes: [CFString],
        from element: AXUIElement
    ) -> [String: Any] {
        var copiedValues: CFArray?
        let result = AXUIElementCopyMultipleAttributeValues(
            element,
            attributes as CFArray,
            AXCopyMultipleAttributeOptions(rawValue: 0),
            &copiedValues
        )
        guard result == .success,
              let values = copiedValues as? [Any],
              values.count == attributes.count else {
            return [:]
        }
        var mapped: [String: Any] = [:]
        for (attribute, value) in zip(attributes, values) {
            let reference = value as CFTypeRef
            guard CFGetTypeID(reference) != CFNullGetTypeID() else { continue }
            mapped[attribute as String] = value
        }
        return mapped
    }

    private func scalarString(_ value: Any?) -> String? {
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        if let number = value as? NSNumber { return number.stringValue }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    private func boolValue(_ value: Any?) -> Bool? {
        (value as? NSNumber)?.boolValue
    }

    private func intValue(_ value: Any?) -> Int? {
        (value as? NSNumber)?.intValue
    }

    private func elementID(_ element: AXUIElement) -> String {
        "e" + String(CFHash(element), radix: 36)
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
        let childAttributes: [CFString] = [
            kAXChildrenAttribute as CFString,
            kAXVisibleChildrenAttribute as CFString,
            kAXRowsAttribute as CFString,
            kAXContentsAttribute as CFString,
        ]
        var result: [AXUIElement] = []
        for attribute in childAttributes {
            guard let value = value(attribute: attribute, from: element),
                  let children = value as? [AXUIElement] else {
                continue
            }
            for child in children where !result.contains(where: { CFEqual($0, child) }) {
                result.append(child)
            }
        }
        return result
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

    private func windowIdentifier(
        for window: AXUIElement,
        processIdentifier: pid_t,
        title: String?
    ) -> UInt32? {
        let bounds = windowBounds(window)
        guard let values = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[CFString: Any]] else {
            return nil
        }
        let candidates = values.compactMap { value -> (UInt32, Double)? in
            guard (value[kCGWindowOwnerPID] as? NSNumber)?.int32Value == processIdentifier,
                  let number = (value[kCGWindowNumber] as? NSNumber)?.uint32Value else {
                return nil
            }
            var score = 0.0
            if (value[kCGWindowLayer] as? NSNumber)?.intValue == 0 { score += 2 }
            if let title,
               !title.isEmpty,
               (value[kCGWindowName] as? String) == title {
                score += 4
            }
            if let bounds,
               let rawBounds = value[kCGWindowBounds] {
                let reference = rawBounds as CFTypeRef
                guard CFGetTypeID(reference) == CFDictionaryGetTypeID(),
                      let candidateBounds = CGRect(
                          dictionaryRepresentation: unsafeDowncast(
                              reference,
                              to: CFDictionary.self
                          )
                      ) else {
                    return (number, score)
                }
                let intersection = bounds.intersection(candidateBounds)
                if !intersection.isNull {
                    let unionArea = bounds.union(candidateBounds).width
                        * bounds.union(candidateBounds).height
                    if unionArea > 0 {
                        score += 6.0 * Double(
                            intersection.width * intersection.height / unionArea
                        )
                    }
                }
            }
            return (number, score)
        }
        let sorted = candidates.sorted { $0.1 > $1.1 }
        guard let best = sorted.first else { return nil }
        if best.1 >= 4 {
            if let runnerUp = sorted.dropFirst().first,
               abs(best.1 - runnerUp.1) < 0.5 {
                return nil
            }
            return best.0
        }
        return sorted.count == 1 && best.1 >= 2 ? best.0 : nil
    }

    private func windowBounds(_ window: AXUIElement) -> CGRect? {
        guard let positionValue = value(
            attribute: kAXPositionAttribute as CFString,
            from: window
        ),
        let sizeValue = value(
            attribute: kAXSizeAttribute as CFString,
            from: window
        ),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
            return nil
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(
            unsafeDowncast(positionValue, to: AXValue.self),
            .cgPoint,
            &position
        ),
        AXValueGetValue(
            unsafeDowncast(sizeValue, to: AXValue.self),
            .cgSize,
            &size
        ) else {
            return nil
        }
        return CGRect(origin: position, size: size)
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

    private static let chromiumBrowserBundleIdentifiers: Set<String> = [
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.vivaldi.Vivaldi",
        "company.thebrowser.Browser",
        "com.operasoftware.Opera",
        "org.chromium.Chromium",
    ]

    /// Chromium builds its Accessibility tree lazily. Electron applications expose a settable
    /// `AXManualAccessibility` attribute and honor it as the request to build the tree; Chromium
    /// browsers honor `AXEnhancedUserInterface` for the web content area. Each process is asked
    /// at most once, and only when the observed tree shows the request is needed, because the
    /// enhanced mode can slow window animations in some applications.
    ///
    /// Returns true when a request was made during this capture.
    private func requestEnhancedAccessibilityIfNeeded(
        for application: AXUIElement,
        processIdentifier: pid_t,
        bundleIdentifier: String,
        snapshot: AXTreeSnapshot
    ) -> Bool {
        guard !enhancedAccessibilityRequestedProcesses.contains(processIdentifier) else {
            return false
        }
        let isElectron = isAttributeSettable("AXManualAccessibility", on: application)
        let isChromiumBrowser = Self.chromiumBrowserBundleIdentifiers.contains(bundleIdentifier)
        let needsRequest = snapshot.isDegenerate
            || (isElectron && !snapshot.containsWebArea)
            || (isChromiumBrowser && !snapshot.containsWebArea)
        guard needsRequest else { return false }
        enhancedAccessibilityRequestedProcesses.insert(processIdentifier)
        let attributes = isElectron
            ? ["AXManualAccessibility", "AXEnhancedUserInterface"]
            : ["AXEnhancedUserInterface"]
        for attribute in attributes where isAttributeSettable(attribute, on: application) {
            if AXUIElementSetAttributeValue(
                application,
                attribute as CFString,
                kCFBooleanTrue
            ) == .success {
                return true
            }
        }
        return false
    }

    private func isAttributeSettable(_ attribute: String, on element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
            && settable.boolValue
    }

    private func isPrivateBrowsing(
        bundleIdentifier: String,
        windowTitle: String?
    ) -> Bool {
        let browserBundles = [
            "com.apple.Safari",
            "com.google.Chrome",
            "com.brave.Browser",
            "org.mozilla.firefox",
            "com.microsoft.edgemac",
        ]
        guard browserBundles.contains(bundleIdentifier) else {
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
