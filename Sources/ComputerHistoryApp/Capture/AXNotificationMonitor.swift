@preconcurrency import ApplicationServices
import AppKit
import ComputerHistoryCore
import Foundation

final class AXNotificationMonitor: @unchecked Sendable {
    private struct NotificationSubscription {
        let element: AXUIElement
        let notification: CFString
    }

    var onContextChanged: (
        @Sendable (
            HistoryEvent.Kind,
            HistoryEvent.CaptureReason,
            InteractionCapture?
        ) -> Void
    )?

    private var observer: AXObserver?
    private var applicationElement: AXUIElement?
    private var valueSubscriptions: [NotificationSubscription] = []
    private var selectionSubscriptions: [NotificationSubscription] = []
    private var processIdentifier: pid_t?
    private var focusedElement: AXUIElement?
    private var fallbackTimer: Timer?
    private var lastFocusedValue: String?
    private var lastSelectedText: String?
    private var pendingTextChange: DispatchWorkItem?
    private var pendingSelectionChange: DispatchWorkItem?
    private var pendingTitleChange: DispatchWorkItem?
    private var pendingTextCapture: InteractionCapture?
    private var pendingSelectionCapture: InteractionCapture?
    private var pendingTextStartedAt: Date?
    private var pendingSelectionStartedAt: Date?
    private var pendingTitleStartedAt: Date?
    private var hasPendingTextChange = false
    private var hasPendingSelectionChange = false
    private var hasPendingTitleChange = false
    private var lastTypingActivityAt: Date?
    private var semanticEventGate = SemanticEventGate()

    private static let selectionNotifications: [CFString] = [
        kAXSelectedTextChangedNotification as CFString,
        kAXSelectedChildrenChangedNotification as CFString,
        kAXSelectedRowsChangedNotification as CFString,
        kAXSelectedColumnsChangedNotification as CFString,
        kAXSelectedCellsChangedNotification as CFString,
    ]
    private static let selectionNotificationAttributes: [(CFString, CFString)] = [
        (
            kAXSelectedTextChangedNotification as CFString,
            kAXSelectedTextAttribute as CFString
        ),
        (
            kAXSelectedChildrenChangedNotification as CFString,
            kAXSelectedChildrenAttribute as CFString
        ),
        (
            kAXSelectedRowsChangedNotification as CFString,
            kAXSelectedRowsAttribute as CFString
        ),
        (
            kAXSelectedColumnsChangedNotification as CFString,
            kAXSelectedColumnsAttribute as CFString
        ),
        (
            kAXSelectedCellsChangedNotification as CFString,
            kAXSelectedCellsAttribute as CFString
        ),
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
        ]

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
        pendingTitleChange?.cancel()
        pendingTitleChange = nil
        pendingTitleStartedAt = nil
        hasPendingTitleChange = false
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
        valueSubscriptions = []
        selectionSubscriptions = []
        valueNotificationTargetCount = 0
        selectionNotificationTargetCount = 0
        processIdentifier = nil
        focusedElement = nil
        lastFocusedValue = nil
        lastSelectedText = nil
        lastTypingActivityAt = nil
        semanticEventGate.reset()
    }

    func noteTypingActivity() {
        lastTypingActivityAt = Date()
        if valueSubscriptions.isEmpty {
            refreshFocusedElementSubscriptions()
        }
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
        lastSelectedText = string(
            attribute: kAXSelectedTextAttribute as CFString,
            from: element
        )
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let semanticElements = elementAndAncestors(
            startingAt: element,
            maximumDepth: 12
        )
        let candidates = semanticElements.map { element in
            (element: element, attributes: attributeNames(from: element))
        }
        let valueNotification = kAXValueChangedNotification as CFString
        let valueTarget = candidates.first {
            $0.attributes.contains(kAXValueAttribute as String)
                && isEditableTextElement($0.element)
        }?.element
        lastFocusedValue = valueTarget.flatMap(safeValue)
        let registeredValueTarget = valueTarget.flatMap {
            register(
                notification: valueNotification,
                preferredElement: $0,
                fallbackElement: applicationElement,
                observer: observer,
                refcon: refcon
            )
        }
        valueSubscriptions = registeredValueTarget.map {
            [NotificationSubscription(element: $0, notification: valueNotification)]
        } ?? []

        selectionSubscriptions = Self.selectionNotificationAttributes.compactMap {
            notification, attribute in
            guard let preferredElement = candidates.first(where: {
                $0.attributes.contains(attribute as String)
            })?.element else {
                return nil
            }
            return register(
                notification: notification,
                preferredElement: preferredElement,
                fallbackElement: applicationElement,
                observer: observer,
                refcon: refcon
            ).map {
                NotificationSubscription(element: $0, notification: notification)
            }
        }
        valueNotificationTargetCount = uniqueElementCount(
            valueSubscriptions.map(\.element)
        )
        selectionNotificationTargetCount = uniqueElementCount(
            selectionSubscriptions.map(\.element)
        )
    }

    private func removeFocusedElementSubscriptions() {
        guard let observer else {
            valueSubscriptions = []
            selectionSubscriptions = []
            valueNotificationTargetCount = 0
            selectionNotificationTargetCount = 0
            return
        }
        for subscription in valueSubscriptions {
            _ = AXObserverRemoveNotification(
                observer,
                subscription.element,
                subscription.notification
            )
        }
        for subscription in selectionSubscriptions {
            _ = AXObserverRemoveNotification(
                observer,
                subscription.element,
                subscription.notification
            )
        }
        valueSubscriptions = []
        selectionSubscriptions = []
        valueNotificationTargetCount = 0
        selectionNotificationTargetCount = 0
    }

    private func register(
        notification: CFString,
        preferredElement: AXUIElement?,
        fallbackElement: AXUIElement,
        observer: AXObserver,
        refcon: UnsafeMutableRawPointer
    ) -> AXUIElement? {
        if let preferredElement,
           AXObserverAddNotification(
               observer,
               preferredElement,
               notification,
               refcon
           ) == .success {
            return preferredElement
        }
        guard AXObserverAddNotification(
            observer,
            fallbackElement,
            notification,
            refcon
        ) == .success else {
            return nil
        }
        return fallbackElement
    }

    private func attributeNames(from element: AXUIElement) -> Set<String> {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success,
              let names else {
            return []
        }
        return Set((names as? [String]) ?? [])
    }

    private func uniqueElementCount(_ elements: [AXUIElement]) -> Int {
        elements.reduce(into: [AXUIElement]()) { unique, element in
            if !unique.contains(where: { CFEqual($0, element) }) {
                unique.append(element)
            }
        }.count
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
            let capture = semanticCapture(
                from: semanticElement,
                selectedText: selection
            )
            guard semanticEventGate.acceptsSelection(
                streamID: selectionStreamID(notification: name, capture: capture),
                selectedText: selection
            ) else { return }
            debounceSelectionChange(capture: capture)
        } else if name == kAXValueChangedNotification as String {
            let semanticElement = normalizedSemanticElement(element)
            guard isEditableTextElement(semanticElement), hasRecentTypingActivity else { return }
            let value = safeValue(from: semanticElement)
            guard value != nil else { return }
            let previousValue = lastFocusedValue
            guard value != previousValue else { return }
            lastFocusedValue = value
            if previousValue == nil, value?.isEmpty == true { return }
            debounceTextChange(
                capture: semanticCapture(from: semanticElement, text: value)
            )
        } else if name == kAXTitleChangedNotification as String {
            debounceTitleChange()
        } else if name == kAXFocusedWindowChangedNotification as String
                    || name == kAXWindowCreatedNotification as String {
            discardPendingTitleChange()
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
           now.timeIntervalSince(startedAt) >= 1 {
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
            deadline: .now() + 0.35,
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

    private func debounceTitleChange() {
        let now = Date()
        if pendingTitleStartedAt == nil { pendingTitleStartedAt = now }
        if let startedAt = pendingTitleStartedAt,
           now.timeIntervalSince(startedAt) >= 20 {
            flushPendingTitleChange()
            return
        }
        pendingTitleChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.flushPendingTitleChange()
        }
        hasPendingTitleChange = true
        pendingTitleChange = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 1,
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

    private func flushPendingTitleChange() {
        guard hasPendingTitleChange else { return }
        pendingTitleChange?.cancel()
        pendingTitleChange = nil
        pendingTitleStartedAt = nil
        hasPendingTitleChange = false
        onContextChanged?(.windowChanged, .titleChange, nil)
    }

    private func discardPendingTitleChange() {
        pendingTitleChange?.cancel()
        pendingTitleChange = nil
        pendingTitleStartedAt = nil
        hasPendingTitleChange = false
    }

    private func pollFocusedSemantics() {
        guard let focusedElement else { return }
        let value = isEditableTextElement(focusedElement) && hasRecentTypingActivity
            ? safeValue(from: focusedElement)
            : nil
        if value != lastFocusedValue {
            let previousValue = lastFocusedValue
            lastFocusedValue = value
            if let value, previousValue != nil || !value.isEmpty {
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

    private func selectionStreamID(
        notification: String,
        capture: InteractionCapture
    ) -> String {
        let target = capture.semanticTarget
        return [
            notification,
            target?.role,
            target?.subrole,
            target?.identifier,
            target?.title,
            target?.description,
            target?.placeholder,
        ]
        .map { $0 ?? "" }
        .joined(separator: "\u{1f}")
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
            value: isEditableTextElement(element) && hasRecentTypingActivity
                ? safeValue(from: element)
                : nil
        )
    }

    private func isEditableTextElement(_ element: AXUIElement) -> Bool {
        let role = string(attribute: kAXRoleAttribute as CFString, from: element)
        if role == "AXSecureTextField" { return false }
        let explicitTextRoles: Set<String> = [
            "AXTextField",
            "AXTextArea",
            "AXSearchField",
            "AXComboBox",
        ]
        if let role, explicitTextRoles.contains(role) { return true }

        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(
            element,
            kAXValueAttribute as CFString,
            &settable
        ) == .success,
        settable.boolValue else {
            return false
        }
        return true
    }

    private var hasRecentTypingActivity: Bool {
        guard let lastTypingActivityAt else { return false }
        return Date().timeIntervalSince(lastTypingActivityAt) <= 2
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
