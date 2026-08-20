@preconcurrency import ApplicationServices
import AppKit
import ComputerHistoryCore
import Foundation

final class AXNotificationMonitor: @unchecked Sendable {
    var onContextChanged: (
        @Sendable (HistoryEvent.Kind, HistoryEvent.CaptureReason) -> Void
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
    private var hasPendingTextChange = false
    private var hasPendingSelectionChange = false

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
        hasPendingTextChange = false
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
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
            maximumDepth: 6
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
            if AXObserverAddNotification(
                observer,
                semanticElement,
                kAXSelectedTextChangedNotification as CFString,
                refcon
            ) == .success {
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
            _ = AXObserverRemoveNotification(
                observer,
                selectionElement,
                kAXSelectedTextChangedNotification as CFString
            )
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

    private func handle(notification: CFString) {
        let name = notification as String
        if name == kAXFocusedUIElementChangedNotification as String {
            pendingTextChange?.cancel()
            pendingTextChange = nil
            hasPendingTextChange = false
            pendingSelectionChange?.cancel()
            pendingSelectionChange = nil
            hasPendingSelectionChange = false
            refreshFocusedElementSubscriptions()
            onContextChanged?(.windowChanged, .focusChange)
            return
        }

        if name == kAXSelectedTextChangedNotification as String {
            if let focusedElement {
                lastSelectedText = string(
                    attribute: kAXSelectedTextAttribute as CFString,
                    from: focusedElement
                )
            }
            debounceSelectionChange()
        } else if name == kAXValueChangedNotification as String {
            if let focusedElement {
                lastFocusedValue = safeValue(from: focusedElement)
            }
            debounceTextChange()
        } else if name == kAXTitleChangedNotification as String {
            onContextChanged?(.windowChanged, .titleChange)
        } else if name == kAXFocusedWindowChangedNotification as String
                    || name == kAXWindowCreatedNotification as String {
            onContextChanged?(.windowChanged, .windowFocus)
        } else {
            return
        }
    }

    private func debounceTextChange() {
        pendingTextChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.hasPendingTextChange = false
            self?.pendingTextChange = nil
            self?.onContextChanged?(.keyboardTextInput, .axValue)
        }
        hasPendingTextChange = true
        pendingTextChange = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 0.65,
            execute: workItem
        )
    }

    private func debounceSelectionChange() {
        pendingSelectionChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.hasPendingSelectionChange = false
            self?.pendingSelectionChange = nil
            self?.onContextChanged?(.selectionChanged, .axSelection)
        }
        hasPendingSelectionChange = true
        pendingSelectionChange = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 0.15,
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
        hasPendingTextChange = false
        onContextChanged?(.keyboardTextInput, .axValue)
    }

    private func flushPendingSelectionChange() {
        guard hasPendingSelectionChange else { return }
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
        hasPendingSelectionChange = false
        onContextChanged?(.selectionChanged, .axSelection)
    }

    private func pollFocusedSemantics() {
        guard let focusedElement else { return }
        let value = safeValue(from: focusedElement)
        if value != lastFocusedValue {
            lastFocusedValue = value
            if value != nil { debounceTextChange() }
        }
        let selection = string(
            attribute: kAXSelectedTextAttribute as CFString,
            from: focusedElement
        )
        if selection != lastSelectedText {
            lastSelectedText = selection
            if let selection, !selection.isEmpty { debounceSelectionChange() }
        }
    }

    private func safeValue(from element: AXUIElement) -> String? {
        let role = string(attribute: kAXRoleAttribute as CFString, from: element)
        guard role != "AXSecureTextField" else { return nil }
        return string(attribute: kAXValueAttribute as CFString, from: element)
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
        _, _, notification, refcon in
        guard let refcon else { return }
        let monitor = Unmanaged<AXNotificationMonitor>
            .fromOpaque(refcon)
            .takeUnretainedValue()
        monitor.handle(notification: notification)
    }
}
