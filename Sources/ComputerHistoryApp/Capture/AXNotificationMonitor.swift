@preconcurrency import ApplicationServices
import AppKit
import ComputerHistoryCore
import Foundation

final class AXNotificationMonitor: @unchecked Sendable {
    var onContextChanged: (
        @Sendable (
            HistoryEvent.Kind,
            HistoryEvent.CaptureReason,
            InteractionCapture?
        ) -> Void
    )?

    private var observer: AXObserver?
    private var applicationElement: AXUIElement?
    private var valueElements: [AXUIElement] = []
    private var selectionElements: [AXUIElement] = []
    private var processIdentifier: pid_t?
    private var focusedElement: AXUIElement?
    private var fallbackTimer: Timer?
    private var lastFocusedValue: String?
    private var lastSelectedText: String?
    private var pendingTextChange: DispatchWorkItem?
    private var pendingSelectionChange: DispatchWorkItem?
    private var pendingTextCapture: InteractionCapture?
    private var pendingSelectionCapture: InteractionCapture?
    private var pendingTextStartedAt: Date?
    private var pendingSelectionStartedAt: Date?
    private var hasPendingTextChange = false
    private var hasPendingSelectionChange = false

    private static let selectionNotifications: [CFString] = [
        kAXSelectedTextChangedNotification as CFString,
        kAXSelectedChildrenChangedNotification as CFString,
        kAXSelectedRowsChangedNotification as CFString,
        kAXSelectedColumnsChangedNotification as CFString,
        kAXSelectedCellsChangedNotification as CFString,
    ]

    private(set) var valueNotificationTargetCount = 0
    private(set) var selectionNotificationTargetCount = 0
    var isObservingApplication: Bool { observer != nil }

    func observe(_ application: NSRunningApplication) {
        guard processIdentifier != application.processIdentifier else { return }
        stop()

        var createdObserver: AXObserver?
        let result = AXObserverCreate(
            application.processIdentifier,
            Self.callback,
            &createdObserver
        )
        guard result == .success, let createdObserver else { return }

        let applicationElement = AXUIElementCreateApplication(
            application.processIdentifier
        )
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let notifications: [CFString] = [
            kAXFocusedWindowChangedNotification as CFString,
            kAXFocusedUIElementChangedNotification as CFString,
            kAXWindowCreatedNotification as CFString,
            kAXTitleChangedNotification as CFString,
            kAXValueChangedNotification as CFString,
        ] + Self.selectionNotifications

        for notification in notifications {
            _ = AXObserverAddNotification(
                createdObserver,
                applicationElement,
                notification,
                refcon
            )
        }

        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(createdObserver),
            .defaultMode
        )
        observer = createdObserver
        self.applicationElement = applicationElement
        processIdentifier = application.processIdentifier
        refreshFocusedElementSubscriptions()
        fallbackTimer = Timer.scheduledTimer(
            withTimeInterval: 1,
            repeats: true
        ) { [weak self] _ in
            self?.pollFocusedSemantics()
        }
    }

    func stop() {
        pendingTextChange?.cancel()
        pendingTextChange = nil
        pendingTextCapture = nil
        pendingTextStartedAt = nil
        hasPendingTextChange = false
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
        pendingSelectionCapture = nil
        pendingSelectionStartedAt = nil
        hasPendingSelectionChange = false
        fallbackTimer?.invalidate()
        fallbackTimer = nil
        removeFocusedElementSubscriptions()
        if let observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
        }
        observer = nil
        applicationElement = nil
        valueElements = []
        selectionElements = []
        valueNotificationTargetCount = 0
        selectionNotificationTargetCount = 0
        processIdentifier = nil
        focusedElement = nil
        lastFocusedValue = nil
        lastSelectedText = nil
    }

    private func refreshFocusedElementSubscriptions() {
        removeFocusedElementSubscriptions()
        guard let observer, let applicationElement else { return }

        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            applicationElement,
            kAXFocusedUIElementAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return
        }

        let element = unsafeDowncast(value, to: AXUIElement.self)
        focusedElement = element
        lastFocusedValue = safeValue(from: element)
        lastSelectedText = string(
            attribute: kAXSelectedTextAttribute as CFString,
            from: element
        )
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let semanticElements = elementAndAncestors(
            startingAt: element,
            maximumDepth: 12
        )
        var valueElements: [AXUIElement] = []
        var selectionElements: [AXUIElement] = []
        for semanticElement in semanticElements {
            if AXObserverAddNotification(
                observer,
                semanticElement,
                kAXValueChangedNotification as CFString,
                refcon
            ) == .success {
                valueElements.append(semanticElement)
            }
            var observesSelection = false
            for notification in Self.selectionNotifications where AXObserverAddNotification(
                observer,
                semanticElement,
                notification,
                refcon
            ) == .success {
                observesSelection = true
            }
            if observesSelection {
                selectionElements.append(semanticElement)
            }
        }
        self.valueElements = valueElements
        self.selectionElements = selectionElements
        valueNotificationTargetCount = valueElements.count
        selectionNotificationTargetCount = selectionElements.count
    }

    private func removeFocusedElementSubscriptions() {
        guard let observer else {
            valueElements = []
            selectionElements = []
            valueNotificationTargetCount = 0
            selectionNotificationTargetCount = 0
            return
        }
        for valueElement in valueElements {
            _ = AXObserverRemoveNotification(
                observer,
                valueElement,
                kAXValueChangedNotification as CFString
            )
        }
        for selectionElement in selectionElements {
            for notification in Self.selectionNotifications {
                _ = AXObserverRemoveNotification(
                    observer,
                    selectionElement,
                    notification
                )
            }
        }
        valueElements = []
        selectionElements = []
        valueNotificationTargetCount = 0
        selectionNotificationTargetCount = 0
    }

    private func elementAndAncestors(
        startingAt element: AXUIElement,
        maximumDepth: Int = 3
    ) -> [AXUIElement] {
        var result: [AXUIElement] = []
        var current: AXUIElement? = element
        var depth = 0

        while let candidate = current, depth <= maximumDepth {
            if !result.contains(where: { CFEqual($0, candidate) }) {
                result.append(candidate)
            }
            current = parent(of: candidate)
            depth += 1
        }
        return result
    }

    private func parent(of element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXParentAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private func handle(element: AXUIElement, notification: CFString) {
        let name = notification as String
        if name == kAXFocusedUIElementChangedNotification as String {
            flushPendingChanges()
            refreshFocusedElementSubscriptions()
            return
        }

        if Self.selectionNotifications.contains(where: { ($0 as String) == name }) {
            let semanticElement = normalizedSemanticElement(element)
            let selection = selectedText(from: semanticElement)
            if let focusedElement, CFEqual(semanticElement, focusedElement) {
                lastSelectedText = selection
            }
            debounceSelectionChange(
                capture: semanticCapture(
                    from: semanticElement,
                    selectedText: selection
                )
            )
        } else if name == kAXValueChangedNotification as String {
            let semanticElement = normalizedSemanticElement(element)
            let value = safeValue(from: semanticElement)
            if let focusedElement, CFEqual(semanticElement, focusedElement) {
                lastFocusedValue = value
            }
            guard value != nil else { return }
            debounceTextChange(
                capture: semanticCapture(from: semanticElement, text: value)
            )
        } else if name == kAXTitleChangedNotification as String {
            onContextChanged?(.windowChanged, .titleChange, nil)
        } else if name == kAXFocusedWindowChangedNotification as String
                    || name == kAXWindowCreatedNotification as String {
            onContextChanged?(.windowChanged, .windowFocus, nil)
        } else {
            return
        }
    }

    private func debounceTextChange(capture: InteractionCapture) {
        let now = Date()
        pendingTextCapture = capture
        if pendingTextStartedAt == nil { pendingTextStartedAt = now }
        if let startedAt = pendingTextStartedAt,
           now.timeIntervalSince(startedAt) >= 0.75 {
            flushPendingTextChange()
            return
        }
        pendingTextChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.flushPendingTextChange()
        }
        hasPendingTextChange = true
        pendingTextChange = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 0.25,
            execute: workItem
        )
    }

    private func debounceSelectionChange(capture: InteractionCapture) {
        let now = Date()
        pendingSelectionCapture = capture
        if pendingSelectionStartedAt == nil { pendingSelectionStartedAt = now }
        if let startedAt = pendingSelectionStartedAt,
           now.timeIntervalSince(startedAt) >= 0.35 {
            flushPendingSelectionChange()
            return
        }
        pendingSelectionChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.flushPendingSelectionChange()
        }
        hasPendingSelectionChange = true
        pendingSelectionChange = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 0.08,
            execute: workItem
        )
    }

    func flushPendingChanges() {
        flushPendingTextChange()
        flushPendingSelectionChange()
    }

    func flushPendingTextChange() {
        guard hasPendingTextChange else { return }
        pendingTextChange?.cancel()
        pendingTextChange = nil
        let capture = pendingTextCapture
        pendingTextCapture = nil
        pendingTextStartedAt = nil
        hasPendingTextChange = false
        onContextChanged?(.keyboardTextInput, .axValue, capture)
    }

    private func flushPendingSelectionChange() {
        guard hasPendingSelectionChange else { return }
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
        let capture = pendingSelectionCapture
        pendingSelectionCapture = nil
        pendingSelectionStartedAt = nil
        hasPendingSelectionChange = false
        onContextChanged?(.selectionChanged, .axSelection, capture)
    }

    private func pollFocusedSemantics() {
        guard let focusedElement else { return }
        let value = safeValue(from: focusedElement)
        if value != lastFocusedValue {
            lastFocusedValue = value
            if let value {
                debounceTextChange(
                    capture: semanticCapture(from: focusedElement, text: value)
                )
            }
        }
        let selection = selectedText(from: focusedElement)
        if selection != lastSelectedText {
            lastSelectedText = selection
            debounceSelectionChange(
                capture: semanticCapture(
                    from: focusedElement,
                    selectedText: selection
                )
            )
        }
    }

    private func normalizedSemanticElement(_ element: AXUIElement) -> AXUIElement {
        let role = string(attribute: kAXRoleAttribute as CFString, from: element)
        if role == "AXApplication", let focusedElement { return focusedElement }
        return element
    }

    private func semanticCapture(
        from element: AXUIElement,
        text: String? = nil,
        selectedText: String? = nil
    ) -> InteractionCapture {
        InteractionCapture(
            semanticTarget: targetContext(from: element),
            text: PrivacySanitizer.clean(text, limit: 4_096),
            selectedText: PrivacySanitizer.clean(selectedText, limit: 4_096)
        )
    }

    private func targetContext(from element: AXUIElement) -> HistoryEvent.Target {
        let target = HistoryEvent.Target(
            role: clean(kAXRoleAttribute as CFString, from: element, limit: 128),
            subrole: clean(kAXSubroleAttribute as CFString, from: element, limit: 128),
            identifier: clean(kAXIdentifierAttribute as CFString, from: element, limit: 256),
            title: clean(kAXTitleAttribute as CFString, from: element, limit: 512),
            description: clean(
                kAXDescriptionAttribute as CFString,
                from: element,
                limit: 512
            ),
            placeholder: clean(
                kAXPlaceholderValueAttribute as CFString,
                from: element,
                limit: 512
            )
        )
        guard !PrivacySanitizer.isSensitiveTarget(target) else { return target }
        return HistoryEvent.Target(
            role: target.role,
            subrole: target.subrole,
            identifier: target.identifier,
            title: target.title,
            description: target.description,
            placeholder: target.placeholder,
            value: safeValue(from: element)
        )
    }

    private func selectedText(from element: AXUIElement) -> String? {
        for candidate in elementAndAncestors(startingAt: element, maximumDepth: 12) {
            if let value = string(
                attribute: kAXSelectedTextAttribute as CFString,
                from: candidate
            ) {
                return PrivacySanitizer.clean(value, limit: 4_096)
            }
        }
        return nil
    }

    private func safeValue(from element: AXUIElement) -> String? {
        let role = string(attribute: kAXRoleAttribute as CFString, from: element)
        let target = HistoryEvent.Target(
            role: role,
            identifier: string(attribute: kAXIdentifierAttribute as CFString, from: element),
            title: string(attribute: kAXTitleAttribute as CFString, from: element),
            description: string(
                attribute: kAXDescriptionAttribute as CFString,
                from: element
            ),
            placeholder: string(
                attribute: kAXPlaceholderValueAttribute as CFString,
                from: element
            )
        )
        guard !PrivacySanitizer.isSensitiveTarget(target) else { return nil }
        return PrivacySanitizer.clean(
            string(attribute: kAXValueAttribute as CFString, from: element),
            limit: 4_096
        )
    }

    private func clean(
        _ attribute: CFString,
        from element: AXUIElement,
        limit: Int
    ) -> String? {
        PrivacySanitizer.clean(string(attribute: attribute, from: element), limit: limit)
    }

    private func string(attribute: CFString, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value else {
            return nil
        }
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        return nil
    }

    private static let callback: AXObserverCallback = {
        _, element, notification, refcon in
        guard let refcon else { return }
        let monitor = Unmanaged<AXNotificationMonitor>
            .fromOpaque(refcon)
            .takeUnretainedValue()
        monitor.handle(element: element, notification: notification)
    }
}
