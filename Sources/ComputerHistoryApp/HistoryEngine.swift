import AppKit
import Combine
import ComputerHistoryCore
import Foundation

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
    @Published private(set) var lastKeyboardEventAt: Date?
    @Published private(set) var activeApplication: HistoryEvent.Application?
    @Published private(set) var activeDomain: String?
    @Published private(set) var documents: [TimelineDocument] = []
    @Published private(set) var lastError: String?
    @Published private(set) var storageRoot: URL
    @Published private(set) var policy: ObservationPolicy
    @Published private(set) var llmEnabled: Bool
    @Published private(set) var llmModel: String
    @Published private(set) var llmEndpoint: String
    @Published private(set) var llmAPIKeyConfigured: Bool

    private let layout: StorageLayout
    private let segmentWriter: SegmentWriter
    private let timelineRepository: TimelineRepository
    private let workspaceMonitor = WorkspaceMonitor()
    private let axNotificationMonitor = AXNotificationMonitor()
    private let interactionMonitor = InteractionMonitor()
    private let contextReader = AXContextReader()
    private let timelineDirectoryWatcher = TimelineDirectoryWatcher()
    private var coalescer = EventCoalescer()
    private var burstCoalescer = EventBurstCoalescer()
    private var pollingTimer: Timer?
    private var burstFlushTimer: Timer?
    private var maintenanceTimer: Timer?
    private var started = false

    override init() {
        let llmSettings = TimelineLLMSettings.load()
        let llmAPIKey = TimelineLLMSettings.resolvedAPIKey()
        let resolvedLayout: StorageLayout
        do {
            resolvedLayout = try StorageLayout.applicationSupport()
        } catch {
            resolvedLayout = StorageLayout(
                root: FileManager.default.temporaryDirectory
                    .appendingPathComponent("ComputerHistory", isDirectory: true)
            )
        }
        layout = resolvedLayout
        storageRoot = resolvedLayout.root
        segmentWriter = SegmentWriter(layout: resolvedLayout)
        timelineRepository = TimelineRepository(
            layout: resolvedLayout,
            summarizer: llmSettings.makeSummarizer(apiKey: llmAPIKey)
        )
        policy = Self.loadPolicy()
        llmEnabled = llmSettings.enabled
        llmModel = llmSettings.model
        llmEndpoint = llmSettings.endpoint
        llmAPIKeyConfigured = llmAPIKey != nil
        super.init()
    }

    func start() {
        guard !started else {
            if state == .stopped { resume() }
            return
        }
        started = true
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: true)
        state = .running

        do {
            try layout.ensureDirectories()
            try timelineDirectoryWatcher.start(directory: layout.timeline) { [weak self] in
                guard let self else { return }
                Task { await self.refreshTimeline() }
            }
        } catch {
            lastError = error.localizedDescription
        }

        axNotificationMonitor.onContextChanged = { [weak self] kind in
            Task { @MainActor in
                self?.captureFrontmostApplication(kind: kind)
            }
        }

        interactionMonitor.onInteraction = { [weak self] kind, capture in
            if capture.keyEquivalent == "return"
                || capture.keyEquivalent == "numpad-enter" {
                self?.axNotificationMonitor.flushPendingTextChange()
            }
            if kind == .keyboardShortcut || kind == .keyboardSubmit {
                self?.lastKeyboardEventAt = Date()
            }
            self?.captureFrontmostApplication(kind: kind, interaction: capture)
        }
        interactionMonitor.onBeforeFocusChangingInteraction = { [weak self] in
            self?.axNotificationMonitor.flushPendingChanges()
        }
        interactionMonitor.start()
        interactionMonitorActive = interactionMonitor.isActive

        workspaceMonitor.onApplicationActivated = { [weak self] application in
            self?.activeApplication = .init(
                bundleIdentifier: application.bundleIdentifier
                    ?? "pid.\(application.processIdentifier)",
                name: application.localizedName ?? "Unknown application"
            )
            self?.axNotificationMonitor.observe(application)
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
        burstFlushTimer = Timer.scheduledTimer(
            timeInterval: 0.25,
            target: self,
            selector: #selector(flushExpiredBursts),
            userInfo: nil,
            repeats: true
        )
        maintenanceTimer = Timer.scheduledTimer(
            timeInterval: 30,
            target: self,
            selector: #selector(runMaintenance),
            userInfo: nil,
            repeats: true
        )

        Task {
            await recoverPendingSegments()
            await refreshTimeline()
        }
    }

    func pause() {
        guard state == .running else { return }
        flushAllBursts()
        state = .paused
    }

    func resume() {
        guard state != .running else { return }
        state = .running
        pollFrontmostApplication()
    }

    func requestAccessibilityPermission() {
        accessibilityGranted = AccessibilityPermission.isTrusted(prompt: true)
        if accessibilityGranted {
            restartInteractionMonitor()
        }
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

    func allowActiveApplication() {
        guard let activeApplication else { return }
        policy.allowedBundleIdentifiers.insert(activeApplication.bundleIdentifier)
        policy.blockedBundleIdentifiers.remove(activeApplication.bundleIdentifier)
        savePolicy()
        pollFrontmostApplication()
    }

    func blockActiveApplication() {
        guard let activeApplication else { return }
        policy.allowedBundleIdentifiers.remove(activeApplication.bundleIdentifier)
        policy.blockedBundleIdentifiers.insert(activeApplication.bundleIdentifier)
        savePolicy()
    }

    func allowActiveDomain() {
        guard let activeDomain else { return }
        policy.allowedDomains.insert(activeDomain)
        policy.blockedDomains.remove(activeDomain)
        savePolicy()
        pollFrontmostApplication()
    }

    func blockActiveDomain() {
        guard let activeDomain else { return }
        policy.allowedDomains.remove(activeDomain)
        policy.blockedDomains.insert(activeDomain)
        savePolicy()
    }

    func isActiveDomainAllowed() -> Bool {
        guard let activeDomain else { return false }
        return policy.allowsDomain(activeDomain)
    }

    func isActiveApplicationAllowed() -> Bool {
        guard let activeApplication else { return false }
        return policy.allowsApplication(activeApplication.bundleIdentifier)
    }

    func configureLLM(
        enabled: Bool,
        model: String,
        endpoint: String,
        apiKey: String
    ) {
        let normalizedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard TimelineLLMSettings.validate(
            endpoint: normalizedEndpoint,
            model: normalizedModel
        ) else {
            lastError = "模型名称或 Endpoint 无效；远程地址必须使用 HTTPS。"
            return
        }

        do {
            let normalizedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedKey.isEmpty {
                try KeychainSecretStore.saveAPIKey(normalizedKey)
            }
            let settings = TimelineLLMSettings(
                enabled: enabled,
                model: normalizedModel,
                endpoint: normalizedEndpoint
            )
            settings.save()
            let resolvedKey = TimelineLLMSettings.resolvedAPIKey()
            llmEnabled = enabled
            llmModel = normalizedModel
            llmEndpoint = normalizedEndpoint
            llmAPIKeyConfigured = resolvedKey != nil
            lastError = nil
            Task {
                await timelineRepository.setSummarizer(
                    settings.makeSummarizer(apiKey: resolvedKey)
                )
                do {
                    let segments = try await segmentWriter.pendingClosedSegments()
                    _ = try await timelineRepository.retryFallbackDocuments(
                        segments: segments,
                        cooldown: 0
                    )
                    await refreshTimeline()
                } catch {
                    lastError = error.localizedDescription
                }
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func removeLLMAPIKey() {
        do {
            try KeychainSecretStore.deleteAPIKey()
            let settings = TimelineLLMSettings.load()
            let environmentKey = ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
            llmAPIKeyConfigured = environmentKey != nil
            Task {
                await timelineRepository.setSummarizer(
                    settings.makeSummarizer(apiKey: environmentKey)
                )
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func delete(_ document: TimelineDocument) {
        Task {
            do {
                try await timelineRepository.delete(document: document)
                await refreshTimeline()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func revealStorageInFinder() {
        do {
            try layout.ensureDirectories()
            NSWorkspace.shared.activateFileViewerSelecting([layout.timeline])
        } catch {
            lastError = error.localizedDescription
        }
    }

    func openMarkdown(_ document: TimelineDocument) {
        guard let fileURL = document.fileURL else {
            revealStorageInFinder()
            return
        }
        if !NSWorkspace.shared.open(fileURL) {
            lastError = "无法打开 Markdown 文件。"
        }
    }

    @objc
    private func pollFrontmostApplication() {
        guard state == .running,
              let application = NSWorkspace.shared.frontmostApplication else {
            return
        }
        activeApplication = .init(
            bundleIdentifier: application.bundleIdentifier
                ?? "pid.\(application.processIdentifier)",
            name: application.localizedName ?? "Unknown application"
        )
        capture(application, kind: .windowChanged)
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
        interaction: InteractionCapture? = nil
    ) {
        guard state == .running else { return }
        let bundleIdentifier = application.bundleIdentifier
            ?? "pid.\(application.processIdentifier)"
        guard TimelineActivityFilter.shouldRecord(
            bundleIdentifier: bundleIdentifier
        ) else {
            activeDomain = nil
            return
        }
        let event = contextReader.event(
            for: application,
            kind: kind,
            interaction: interaction
        )
        activeDomain = event.window?.url.flatMap(Self.domain(from:))
        guard let sanitized = policy.sanitized(event) else {
            Task {
                do {
                    if let closed = try await segmentWriter.recordSuppressed(
                        at: event.timestamp
                    ) {
                        try await generateTimeline(for: closed)
                    }
                } catch {
                    lastError = error.localizedDescription
                }
            }
            return
        }
        guard let normalized = coalescer.process(sanitized) else { return }
        for ready in burstCoalescer.ingest(normalized) {
            persist(ready)
        }
    }

    private func persist(_ event: HistoryEvent) {
        Task {
            do {
                if let closed = try await segmentWriter.append(event) {
                    try await generateTimeline(for: closed)
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    @objc
    private func flushExpiredBursts() {
        for event in burstCoalescer.flushExpired(at: Date()) {
            persist(event)
        }
    }

    private func flushAllBursts() {
        for event in burstCoalescer.flushAll() {
            persist(event)
        }
    }

    @objc
    private func runMaintenance() {
        guard state != .stopped else { return }
        refreshCapturePermissions()
        Task {
            do {
                if let closed = try await segmentWriter.closeExpired(at: Date()) {
                    try await generateTimeline(for: closed)
                }
                let completed = try await segmentWriter.pendingClosedSegments()
                _ = try await timelineRepository.retryFallbackDocuments(
                    segments: completed
                )
                _ = try await segmentWriter.pruneSegments(
                    olderThan: Date().addingTimeInterval(-48 * 60 * 60)
                )
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func generateTimeline(for segment: ClosedSegment) async throws {
        _ = try await timelineRepository.generateIfNeeded(for: segment)
        await refreshTimeline()
    }

    private func recoverPendingSegments() async {
        do {
            let recovered = try await segmentWriter.recoverExpiredSegments(at: Date())
            let completed = try await segmentWriter.pendingClosedSegments()
            var byID: [String: ClosedSegment] = [:]
            for segment in recovered + completed {
                byID[segment.metadata.id] = segment
            }
            _ = try await timelineRepository.generatePending(
                segments: byID.values.sorted {
                    $0.metadata.startedAt < $1.metadata.startedAt
                }
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func refreshTimeline() async {
        do {
            documents = try await timelineRepository.loadDocuments()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func savePolicy() {
        do {
            let data = try JSONEncoder().encode(policy)
            UserDefaults.standard.set(data, forKey: Self.policyKey)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func restartInteractionMonitor() {
        interactionMonitor.stop()
        interactionMonitor.start()
        interactionMonitorActive = interactionMonitor.isActive
    }

    private static let policyKey = "observation-policy-v1"

    private static func loadPolicy() -> ObservationPolicy {
        guard let data = UserDefaults.standard.data(forKey: policyKey),
              var policy = try? JSONDecoder().decode(ObservationPolicy.self, from: data) else {
            return ObservationPolicy()
        }
        // v1 shipped as default-deny. Preserve explicit exclusions while migrating
        // existing installations to the new default-allow behavior.
        policy.defaultApplicationBehavior = .observe
        policy.defaultURLBehavior = .observe
        return policy
    }

    private static func domain(from value: String) -> String? {
        let candidate = value.contains("://") ? value : "https://\(value)"
        return URL(string: candidate)?.host?.lowercased()
    }
}
