import AppKit
import Combine
import DeskLoreNativeCore
import Foundation

/// Owns only the macOS-native capture boundary. Policy, coalescing, storage,
/// timeline generation and model work live in the ServerCore utility process.
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
    var onUsageState: ((UsageStateEvent) -> Void)?

    private let workspaceMonitor = WorkspaceMonitor()
    private let axNotificationMonitor = AXNotificationMonitor()
    private let interactionMonitor = InteractionMonitor()
    private let axCaptureCoordinator = AXCaptureCoordinator()
    private var pollingTimer: Timer?
    private var started = false
    private var nextCaptureSequence = 0
    private var nextCaptureResultSequence = 0
    private var pendingCaptureResults: [Int: AXCaptureOutcome] = [:]
    private var lastNativeWindowCaptureByStream: [String: Date] = [:]
    private var observationPolicy: ObservationPolicy?
    private var activeContextAllowed = false
    private var usageAvailable = true
    private let hostBundleIdentifier = ProcessInfo.processInfo.environment[
        "DESKLORE_HOST_BUNDLE_ID"
    ]
    private let blockedSystemBundleIdentifiers: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.SecurityAgent",
        "com.apple.ScreenSaver.Engine",
    ]

    func start() {
        guard observationPolicy != nil else {
            lastError = "Observation policy must be configured before capture starts"
            return
        }
        guard !started else {
            if state == .stopped { resume() }
            return
        }
        started = true
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: true)
        state = .running

        axNotificationMonitor.onContextChanged = { [weak self] kind, reason, interaction in
            Task { @MainActor in
                self?.captureFrontmostApplication(
                    kind: kind,
                    reason: reason,
                    interaction: interaction
                )
            }
        }
        interactionMonitor.onInteraction = { [weak self] kind, capture in
            if capture.keyEquivalent == "return"
                || capture.keyEquivalent == "numpad-enter" {
                self?.returnKeyEventCount += 1
                self?.axNotificationMonitor.flushPendingTextChange()
            }
            let reason: HistoryEvent.CaptureReason = kind == .keyboardShortcut
                ? .keyboard
                : .mouse
            self?.captureFrontmostApplication(
                kind: kind,
                reason: reason,
                interaction: capture
            )
        }
        interactionMonitor.onBeforeFocusChangingInteraction = { [weak self] in
            self?.axNotificationMonitor.flushPendingChanges()
        }
        interactionMonitor.onTypingActivity = { [weak self] in
            self?.axNotificationMonitor.noteTypingActivity()
        }
        interactionMonitor.start()
        interactionMonitorActive = interactionMonitor.isActive

        workspaceMonitor.onApplicationActivated = { [weak self] application in
            guard let self else { return }
            self.activeApplication = Self.application(from: application)
            self.activeDomain = nil
            self.activeContextAllowed = false
            if self.allowsApplication(application) {
                self.axNotificationMonitor.observe(
                    application,
                    semanticCaptureEnabled: false
                )
            } else {
                self.axNotificationMonitor.stop()
            }
            self.refreshSemanticListenerHealth()
            self.emitUsageState(
                for: application,
                reason: .applicationActivation
            )
            self.capture(
                application,
                kind: .windowChanged,
                reason: .applicationActivation
            )
        }
        workspaceMonitor.onAvailabilityChanged = { [weak self] available, reason in
            guard let self else { return }
            self.usageAvailable = available
            if available {
                self.emitCurrentUsageState(reason: reason)
            } else if self.state == .running {
                self.onUsageState?(
                    UsageStateEvent(state: .unavailable, reason: reason)
                )
            }
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

    func configureObservationPolicy(_ policy: ObservationPolicy) throws {
        observationPolicy = try policy.validated()
        lastError = nil
        activeContextAllowed = false
        axNotificationMonitor.setSemanticCaptureEnabled(false)
        if state == .running {
            pollFrontmostApplication()
            emitCurrentUsageState(reason: .policyChanged)
            captureFrontmostApplication(kind: .windowChanged, reason: .poll)
        }
    }

    func pause() {
        guard state == .running else { return }
        onUsageState?(UsageStateEvent(state: .unavailable, reason: .pause))
        state = .paused
        activeContextAllowed = false
        axNotificationMonitor.setSemanticCaptureEnabled(false)
        refreshSemanticListenerHealth()
    }

    func resume() {
        guard state != .running else { return }
        state = .running
        activeContextAllowed = false
        pollFrontmostApplication()
        emitCurrentUsageState(reason: .resume)
        captureFrontmostApplication(kind: .windowChanged, reason: .poll)
    }

    func allowsVisualCapture(
        _ intent: VisualCaptureIntent,
        currentWindowTitle: String?
    ) -> Bool {
        guard state == .running,
              let observationPolicy,
              let frontmostApplication = NSWorkspace.shared.frontmostApplication,
              Self.application(from: frontmostApplication).bundleIdentifier
                == intent.bundleIdentifier else {
            return false
        }
        let currentURL = activeApplication?.bundleIdentifier == intent.bundleIdentifier
            ? activeDomain ?? intent.url
            : intent.url
        return observationPolicy.decision(
            bundleIdentifier: intent.bundleIdentifier,
            windowTitle: currentWindowTitle ?? intent.windowTitle,
            url: currentURL,
            isPrivateBrowsing: intent.isPrivateBrowsing
        ).allowed
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
        let nextApplication = Self.application(from: application)
        if activeApplication?.bundleIdentifier != nextApplication.bundleIdentifier {
            activeDomain = nil
            activeContextAllowed = false
        }
        activeApplication = nextApplication
        if allowsApplication(application) {
            axNotificationMonitor.observe(
                application,
                semanticCaptureEnabled: activeContextAllowed
            )
        } else {
            activeContextAllowed = false
            axNotificationMonitor.stop()
        }
        refreshSemanticListenerHealth()
    }

    private func captureFrontmostApplication(
        kind: HistoryEvent.Kind,
        reason: HistoryEvent.CaptureReason,
        interaction: InteractionCapture? = nil
    ) {
        guard state == .running,
              let application = NSWorkspace.shared.frontmostApplication else {
            return
        }
        capture(application, kind: kind, reason: reason, interaction: interaction)
    }

    private func capture(
        _ application: NSRunningApplication,
        kind: HistoryEvent.Kind,
        reason: HistoryEvent.CaptureReason,
        interaction: InteractionCapture? = nil,
        includeRichSnapshot: Bool = true
    ) {
        guard let observationPolicy,
              state == .running,
              application.bundleIdentifier != hostBundleIdentifier,
              !blockedSystemBundleIdentifiers.contains(
                  application.bundleIdentifier ?? ""
              ),
              observationPolicy.allowsApplication(
                  Self.application(from: application).bundleIdentifier
              ) else {
            return
        }
        let timestamp = Date()
        if shouldSuppressBeforeAXCapture(
            application: application,
            kind: kind,
            reason: reason,
            timestamp: timestamp
        ) {
            return
        }
        let context = RunningApplicationContext(application)
        let sequence = nextCaptureSequence
        nextCaptureSequence += 1
        axCaptureBacklog = nextCaptureSequence - nextCaptureResultSequence
        let coordinator = axCaptureCoordinator
        Task { [weak self] in
            let result = await coordinator.capture(
                application: context,
                kind: kind,
                captureReason: reason,
                interaction: interaction,
                includeRichSnapshot: includeRichSnapshot
                    && Self.requiresRichSnapshot(for: kind),
                observationPolicy: observationPolicy,
                timestamp: timestamp
            )
            self?.receiveCaptureResult(result, sequence: sequence)
        }
    }

    private func shouldSuppressBeforeAXCapture(
        application: NSRunningApplication,
        kind: HistoryEvent.Kind,
        reason: HistoryEvent.CaptureReason,
        timestamp: Date
    ) -> Bool {
        guard kind == .windowChanged,
              reason != .applicationActivation else {
            return false
        }
        let key = [
            application.bundleIdentifier ?? "pid.\(application.processIdentifier)",
            reason.rawValue,
        ].joined(separator: "\u{1f}")
        defer { lastNativeWindowCaptureByStream[key] = timestamp }
        guard let previous = lastNativeWindowCaptureByStream[key] else { return false }
        return timestamp.timeIntervalSince(previous) < 0.25
    }

    private static func requiresRichSnapshot(for kind: HistoryEvent.Kind) -> Bool {
        switch kind {
        case .windowChanged,
             .mouseClick,
             .mouseContextMenu,
             .mouseDrag,
             .keyboardSubmit:
            return true
        case .keyboardTextInput, .keyboardShortcut, .selectionChanged:
            return false
        }
    }

    private func receiveCaptureResult(_ result: AXCaptureOutcome, sequence: Int) {
        pendingCaptureResults[sequence] = result
        while let ready = pendingCaptureResults.removeValue(
            forKey: nextCaptureResultSequence
        ) {
            processCaptureOutcome(
                ready,
                mayEnableSemanticCapture:
                    nextCaptureResultSequence == nextCaptureSequence - 1
            )
            nextCaptureResultSequence += 1
        }
        axCaptureBacklog = nextCaptureSequence - nextCaptureResultSequence
    }

    private func processCaptureOutcome(
        _ outcome: AXCaptureOutcome,
        mayEnableSemanticCapture: Bool
    ) {
        switch outcome {
        case let .captured(result):
            let decision = observationPolicy?.decision(
                bundleIdentifier: result.event.application.bundleIdentifier,
                windowTitle: result.event.window?.title,
                url: result.event.window?.url,
                isPrivateBrowsing: result.event.window?.isPrivateBrowsing == true
            )
            guard decision?.allowed == true else {
                activeContextAllowed = false
                axNotificationMonitor.setSemanticCaptureEnabled(false)
                refreshSemanticListenerHealth()
                return
            }
            if mayEnableSemanticCapture,
               activeApplication?.bundleIdentifier
                == result.event.application.bundleIdentifier {
                activeContextAllowed = true
                axNotificationMonitor.setSemanticCaptureEnabled(true)
            }
            processCapturedEvent(result)
        case let .suppressed(activeDomain):
            self.activeDomain = activeDomain
            activeContextAllowed = false
            axNotificationMonitor.setSemanticCaptureEnabled(false)
            refreshSemanticListenerHealth()
        }
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

    private func emitCurrentUsageState(reason: UsageStateEvent.Reason) {
        guard state == .running else { return }
        guard usageAvailable,
              let application = NSWorkspace.shared.frontmostApplication else {
            onUsageState?(UsageStateEvent(state: .unavailable, reason: reason))
            return
        }
        emitUsageState(for: application, reason: reason)
    }

    private func emitUsageState(
        for application: NSRunningApplication,
        reason: UsageStateEvent.Reason
    ) {
        guard state == .running, usageAvailable else { return }
        let value = Self.application(from: application)
        if allowsApplication(application) {
            onUsageState?(
                UsageStateEvent(
                    state: .foreground,
                    reason: reason,
                    application: value
                )
            )
        } else {
            onUsageState?(UsageStateEvent(state: .excluded, reason: reason))
        }
    }

    private func allowsApplication(_ application: NSRunningApplication) -> Bool {
        guard let observationPolicy else { return false }
        let bundleIdentifier = Self.application(from: application).bundleIdentifier
        return bundleIdentifier != hostBundleIdentifier
            && !blockedSystemBundleIdentifiers.contains(bundleIdentifier)
            && observationPolicy.allowsApplication(bundleIdentifier)
    }

    private static func domain(from value: String) -> String? {
        let candidate = value.contains("://") ? value : "https://\(value)"
        return URL(string: candidate)?.host?.lowercased()
    }
}
