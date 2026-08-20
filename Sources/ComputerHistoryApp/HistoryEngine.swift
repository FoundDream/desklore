import AppKit
import Combine
import ComputerHistoryCore
import Foundation

/// Owns only the macOS-native capture boundary. Policy, coalescing, storage,
/// timeline generation and LLM work live in the Electron main process.
@MainActor
final class HistoryEngine: NSObject, ObservableObject {
    enum RecorderState: String {
        case stopped
        case running
        case paused
    }

    @Published private(set) var state: RecorderState = .stopped
    @Published private(set) var accessibilityGranted = false
    @Published private(set) var interactionMonitorActive = false
    @Published private(set) var returnKeyEventCount = 0
    @Published private(set) var keyboardSubmitCount = 0
    @Published private(set) var keyboardShortcutCount = 0
    @Published private(set) var textInputEventCount = 0
    @Published private(set) var selectionEventCount = 0
    @Published private(set) var axObserverActive = false
    @Published private(set) var axValueNotificationTargets = 0
    @Published private(set) var axSelectionNotificationTargets = 0
    @Published private(set) var lastAXSnapshotNodeCount = 0
    @Published private(set) var lastAXVisitedNodeCount = 0
    @Published private(set) var lastAXCaptureDurationMilliseconds = 0.0
    @Published private(set) var axSlowCaptureCount = 0
    @Published private(set) var axTruncatedCaptureCount = 0
    @Published private(set) var axCaptureBacklog = 0
    @Published private(set) var activeApplication: HistoryEvent.Application?
    @Published private(set) var activeDomain: String?
    @Published private(set) var lastError: String?

    var onEvent: ((HistoryEvent) -> Void)?

    private let workspaceMonitor = WorkspaceMonitor()
    private let axNotificationMonitor = AXNotificationMonitor()
    private let interactionMonitor = InteractionMonitor()
    private let axCaptureCoordinator = AXCaptureCoordinator()
    private var pollingTimer: Timer?
    private var started = false
    private var nextCaptureSequence = 0
    private var nextCaptureResultSequence = 0
    private var pendingCaptureResults: [Int: AXCaptureResult] = [:]
    private let hostBundleIdentifier = ProcessInfo.processInfo.environment[
        "COMPUTER_HISTORY_HOST_BUNDLE_ID"
    ]

    func start() {
        guard !started else {
            if state == .stopped { resume() }
            return
        }
        started = true
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: true)
        state = .running

        axNotificationMonitor.onContextChanged = { [weak self] kind in
            Task { @MainActor in
                self?.captureFrontmostApplication(kind: kind)
            }
        }
        interactionMonitor.onInteraction = { [weak self] kind, capture in
            if capture.keyEquivalent == "return"
                || capture.keyEquivalent == "numpad-enter" {
                self?.returnKeyEventCount += 1
                self?.axNotificationMonitor.flushPendingTextChange()
            }
            self?.captureFrontmostApplication(kind: kind, interaction: capture)
        }
        interactionMonitor.onBeforeFocusChangingInteraction = { [weak self] in
            self?.axNotificationMonitor.flushPendingChanges()
        }
        interactionMonitor.start()
        interactionMonitorActive = interactionMonitor.isActive

        workspaceMonitor.onApplicationActivated = { [weak self] application in
            self?.activeApplication = Self.application(from: application)
            self?.axNotificationMonitor.observe(application)
            self?.refreshSemanticListenerHealth()
            self?.capture(application, kind: .windowChanged)
        }
        workspaceMonitor.start()

        pollingTimer = Timer.scheduledTimer(
            timeInterval: 2,
            target: self,
            selector: #selector(pollFrontmostApplication),
            userInfo: nil,
            repeats: true
        )
    }

    func pause() {
        guard state == .running else { return }
        state = .paused
    }

    func resume() {
        guard state != .running else { return }
        state = .running
        pollFrontmostApplication()
    }

    func requestAccessibilityPermission() {
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: true)
        if accessibilityGranted { restartInteractionMonitor() }
    }

    func refreshCapturePermissions() {
        let wasGranted = accessibilityGranted
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: false)
        if accessibilityGranted, !wasGranted {
            restartInteractionMonitor()
        } else {
            interactionMonitorActive = interactionMonitor.isActive
        }
    }

    @objc
    private func pollFrontmostApplication() {
        guard state == .running,
              let application = NSWorkspace.shared.frontmostApplication else {
            return
        }
        activeApplication = Self.application(from: application)
        capture(application, kind: .windowChanged, includeRichSnapshot: false)
    }

    private func captureFrontmostApplication(
        kind: HistoryEvent.Kind,
        interaction: InteractionCapture? = nil
    ) {
        guard state == .running,
              let application = NSWorkspace.shared.frontmostApplication else {
            return
        }
        capture(application, kind: kind, interaction: interaction)
    }

    private func capture(
        _ application: NSRunningApplication,
        kind: HistoryEvent.Kind,
        interaction: InteractionCapture? = nil,
        includeRichSnapshot: Bool = true
    ) {
        guard state == .running else { return }
        let context = RunningApplicationContext(application)
        let timestamp = Date()
        let sequence = nextCaptureSequence
        nextCaptureSequence += 1
        axCaptureBacklog = nextCaptureSequence - nextCaptureResultSequence
        let coordinator = axCaptureCoordinator
        let shouldIncludeRichSnapshot = includeRichSnapshot
            && application.bundleIdentifier != hostBundleIdentifier
        Task { [weak self] in
            let result = await coordinator.capture(
                application: context,
                kind: kind,
                interaction: interaction,
                includeRichSnapshot: shouldIncludeRichSnapshot,
                timestamp: timestamp
            )
            self?.receiveCaptureResult(result, sequence: sequence)
        }
    }

    private func receiveCaptureResult(_ result: AXCaptureResult, sequence: Int) {
        pendingCaptureResults[sequence] = result
        while let ready = pendingCaptureResults.removeValue(
            forKey: nextCaptureResultSequence
        ) {
            processCapturedEvent(ready)
            nextCaptureResultSequence += 1
        }
        axCaptureBacklog = nextCaptureSequence - nextCaptureResultSequence
    }

    private func processCapturedEvent(_ result: AXCaptureResult) {
        lastAXCaptureDurationMilliseconds = result.durationMilliseconds
        lastAXSnapshotNodeCount = result.snapshotNodeCount
        lastAXVisitedNodeCount = result.visitedNodeCount
        if result.durationMilliseconds > 250 { axSlowCaptureCount += 1 }
        if result.snapshotWasTruncated { axTruncatedCaptureCount += 1 }
        activeDomain = result.event.window?.url.flatMap(Self.domain(from:))
        recordSemanticCaptureHealth(result.event)
        refreshSemanticListenerHealth()
        onEvent?(result.event)
    }

    private func restartInteractionMonitor() {
        interactionMonitor.stop()
        interactionMonitor.start()
        interactionMonitorActive = interactionMonitor.isActive
    }

    private func recordSemanticCaptureHealth(_ event: HistoryEvent) {
        switch event.kind {
        case .keyboardSubmit:
            keyboardSubmitCount += 1
        case .keyboardShortcut:
            keyboardShortcutCount += 1
        case .keyboardTextInput:
            textInputEventCount += 1
        case .selectionChanged:
            selectionEventCount += 1
        case .windowChanged, .mouseClick, .mouseContextMenu, .mouseDrag:
            break
        }
    }

    private func refreshSemanticListenerHealth() {
        axObserverActive = axNotificationMonitor.isObservingApplication
        axValueNotificationTargets = axNotificationMonitor.valueNotificationTargetCount
        axSelectionNotificationTargets = axNotificationMonitor
            .selectionNotificationTargetCount
    }

    private static func application(
        from application: NSRunningApplication
    ) -> HistoryEvent.Application {
        .init(
            bundleIdentifier: application.bundleIdentifier
                ?? "pid.\(application.processIdentifier)",
            name: application.localizedName ?? "Unknown application"
        )
    }

    private static func domain(from value: String) -> String? {
        let candidate = value.contains("://") ? value : "https://\(value)"
        return URL(string: candidate)?.host?.lowercased()
    }
}
