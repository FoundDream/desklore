@preconcurrency import ApplicationServices
import AppKit
import ComputerHistoryCore
import Foundation

final class AXNotificationMonitor: @unchecked Sendable {
    var onContextChanged: (@Sendable (HistoryEvent.Kind) -> Void)?

    private var observer: AXObserver?
    private var applicationElement: AXUIElement?
    private var focusedElement: AXUIElement?
    private var selectionElements: [AXUIElement] = []
    private var processIdentifier: pid_t?
    private var pendingTextChange: DispatchWorkItem?
    private var pendingSelectionChange: DispatchWorkItem?
    private var hasPendingTextChange = false
    private var hasPendingSelectionChange = false

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
    }

    func stop() {
        pendingTextChange?.cancel()
        pendingTextChange = nil
        hasPendingTextChange = false
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
        hasPendingSelectionChange = false
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
        focusedElement = nil
        processIdentifier = nil
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
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        _ = AXObserverAddNotification(
            observer,
            element,
            kAXValueChangedNotification as CFString,
            refcon
        )

        let selectionElements = elementAndAncestors(startingAt: element)
        for selectionElement in selectionElements {
            _ = AXObserverAddNotification(
                observer,
                selectionElement,
                kAXSelectedTextChangedNotification as CFString,
                refcon
            )
        }
        focusedElement = element
        self.selectionElements = selectionElements
    }

    private func removeFocusedElementSubscriptions() {
        guard let observer else {
            focusedElement = nil
            selectionElements = []
            return
        }
        if let focusedElement {
            _ = AXObserverRemoveNotification(
                observer,
                focusedElement,
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
        focusedElement = nil
        selectionElements = []
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
        }

        if name == kAXSelectedTextChangedNotification as String {
            debounceSelectionChange()
        } else if name == kAXValueChangedNotification as String {
            debounceTextChange()
        } else {
            onContextChanged?(.windowChanged)
        }
    }

    private func debounceTextChange() {
        pendingTextChange?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.hasPendingTextChange = false
            self?.pendingTextChange = nil
            self?.onContextChanged?(.keyboardTextInput)
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
            self?.onContextChanged?(.selectionChanged)
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
        onContextChanged?(.keyboardTextInput)
    }

    private func flushPendingSelectionChange() {
        guard hasPendingSelectionChange else { return }
        pendingSelectionChange?.cancel()
        pendingSelectionChange = nil
        hasPendingSelectionChange = false
        onContextChanged?(.selectionChanged)
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
