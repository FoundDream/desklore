import AppKit
import Combine
import ComputerHistoryCore
import Foundation

private struct AgentCommand: Decodable {
    let id: String
    let command: String
    let bundleIdentifiers: [String]?
    let visualRequest: AgentVisualCaptureRequest?
}

private struct AgentVisualCaptureRequest: Decodable {
    let requestID: String
    let eventID: String
    let bundleIdentifier: String
    let windowRuntimeIdentifier: UInt32?
    let windowTitle: String?
    let expiresAt: String
    let includeImage: Bool
}

private struct AgentApplicationDTO: Encodable {
    let bundleIdentifier: String
    let name: String
    let iconPath: String?
}

private struct AgentHealthDTO: Encodable {
    let accessibilityGranted: Bool
    let interactionMonitorActive: Bool
    let axObserverActive: Bool
    let axValueNotificationTargets: Int
    let axSelectionNotificationTargets: Int
    let returnKeyEventCount: Int
    let keyboardSubmitCount: Int
    let keyboardShortcutCount: Int
    let textInputEventCount: Int
    let selectionEventCount: Int
    let lastAXSnapshotNodeCount: Int
    let lastAXVisitedNodeCount: Int
    let lastAXCaptureDurationMilliseconds: Double
    let axSlowCaptureCount: Int
    let axTruncatedCaptureCount: Int
    let axCaptureBacklog: Int
    let screenCaptureGranted: Bool
}

private struct AgentSnapshotDTO: Encodable {
    let recorderState: String
    let activeApplication: AgentApplicationDTO?
    let activeDomain: String?
    let health: AgentHealthDTO
    let lastError: String?
}

private struct AgentSnapshotMessage: Encodable {
    let type = "snapshot"
    let requestID: String?
    let snapshot: AgentSnapshotDTO
}

private struct AgentEventMessage: Encodable {
    let type = "event"
    let event: HistoryEvent
}

private struct AgentIconPayload: Encodable {
    let iconPaths: [String: String]
}

private struct AgentIconResponse: Encodable {
    let type = "response"
    let requestID: String
    let payload: AgentIconPayload
}

private struct AgentVisualCaptureResponse: Encodable {
    let type = "response"
    let requestID: String
    let payload: VisualCaptureResult
}

private struct AgentErrorMessage: Encodable {
    let type = "error"
    let requestID: String?
    let error: String
}

private final class AgentInputReader: @unchecked Sendable {
    private let input = FileHandle.standardInput
    private let lock = NSLock()
    private var buffer = Data()
    private let onLine: @Sendable (Data) -> Void
    private let onEOF: @Sendable () -> Void

    init(
        onLine: @escaping @Sendable (Data) -> Void,
        onEOF: @escaping @Sendable () -> Void
    ) {
        self.onLine = onLine
        self.onEOF = onEOF
    }

    func start() {
        input.readabilityHandler = { [weak self] handle in
            self?.consume(handle.availableData)
        }
    }

    func stop() {
        input.readabilityHandler = nil
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else {
            stop()
            onEOF()
            return
        }
        lock.lock()
        buffer.append(data)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(Data(buffer[..<newline]))
            buffer.removeSubrange(...newline)
        }
        lock.unlock()
        for line in lines where !line.isEmpty { onLine(line) }
    }
}

@MainActor
final class AgentBridge {
    private let engine: HistoryEngine
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private var cancellables: Set<AnyCancellable> = []
    private var applicationIconPaths: [String: String] = [:]
    private var unresolvedApplicationIconIdentifiers: Set<String> = []
    private let visualCaptureProvider = VisualCaptureProvider()
    private lazy var inputReader = AgentInputReader(
        onLine: { [weak self] data in
            Task { @MainActor [weak self] in self?.handle(data) }
        },
        onEOF: {
            Task { @MainActor in NSApplication.shared.terminate(nil) }
        }
    )

    init(engine: HistoryEngine) {
        self.engine = engine
    }

    func start() {
        engine.onEvent = { [weak self] event in
            self?.write(AgentEventMessage(event: event))
        }
        engine.objectWillChange
            .debounce(for: .milliseconds(120), scheduler: RunLoop.main)
            .sink { [weak self] in self?.sendSnapshot() }
            .store(in: &cancellables)
        inputReader.start()
        sendSnapshot()
    }

    func stop() {
        engine.onEvent = nil
        inputReader.stop()
        cancellables.removeAll()
    }

    private func handle(_ data: Data) {
        let command: AgentCommand
        do {
            command = try JSONDecoder().decode(AgentCommand.self, from: data)
        } catch {
            sendError("Invalid agent command: \(error.localizedDescription)")
            return
        }

        switch command.command {
        case "snapshot":
            break
        case "pause":
            engine.pause()
        case "resume":
            engine.resume()
        case "refreshPermissions":
            engine.refreshCapturePermissions()
        case "requestPermissions":
            engine.requestAccessibilityPermission()
        case "requestScreenCapturePermission":
            _ = visualCaptureProvider.requestScreenCapturePermission()
        case "captureVisualEvidence":
            guard let request = command.visualRequest else {
                sendError("Invalid visual capture request", requestID: command.id)
                return
            }
            guard let expiresAt = WireDateParser.parseISO8601(request.expiresAt) else {
                sendError("Invalid visual capture expiry", requestID: command.id)
                return
            }
            let intent = VisualCaptureIntent(
                requestID: request.requestID,
                eventID: request.eventID,
                bundleIdentifier: request.bundleIdentifier,
                windowRuntimeIdentifier: request.windowRuntimeIdentifier,
                windowTitle: request.windowTitle,
                expiresAt: expiresAt,
                includeImage: request.includeImage
            )
            Task { @MainActor [weak self] in
                guard let self else { return }
                let result = await visualCaptureProvider.capture(intent)
                write(
                    AgentVisualCaptureResponse(
                        requestID: command.id,
                        payload: result
                    )
                )
            }
            return
        case "resolveApplicationIcons":
            let identifiers = command.bundleIdentifiers ?? []
            let paths = Dictionary(uniqueKeysWithValues: identifiers.compactMap { identifier in
                applicationIconPath(for: identifier).map { (identifier, $0) }
            })
            write(
                AgentIconResponse(
                    requestID: command.id,
                    payload: AgentIconPayload(iconPaths: paths)
                )
            )
            return
        case "quit":
            sendSnapshot(requestID: command.id)
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            return
        default:
            sendError("Unsupported agent command", requestID: command.id)
            return
        }
        sendSnapshot(requestID: command.id)
    }

    private func sendSnapshot(requestID: String? = nil) {
        write(AgentSnapshotMessage(requestID: requestID, snapshot: snapshot()))
    }

    private func sendError(_ error: String, requestID: String? = nil) {
        write(AgentErrorMessage(requestID: requestID, error: error))
    }

    private func write<T: Encodable>(_ value: T) {
        guard var data = try? encoder.encode(value) else { return }
        data.append(0x0A)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }

    private func snapshot() -> AgentSnapshotDTO {
        AgentSnapshotDTO(
            recorderState: engine.state.rawValue,
            activeApplication: engine.activeApplication.map(applicationDTO),
            activeDomain: engine.activeDomain,
            health: AgentHealthDTO(
                accessibilityGranted: engine.accessibilityGranted,
                interactionMonitorActive: engine.interactionMonitorActive,
                axObserverActive: engine.axObserverActive,
                axValueNotificationTargets: engine.axValueNotificationTargets,
                axSelectionNotificationTargets: engine.axSelectionNotificationTargets,
                returnKeyEventCount: engine.returnKeyEventCount,
                keyboardSubmitCount: engine.keyboardSubmitCount,
                keyboardShortcutCount: engine.keyboardShortcutCount,
                textInputEventCount: engine.textInputEventCount,
                selectionEventCount: engine.selectionEventCount,
                lastAXSnapshotNodeCount: engine.lastAXSnapshotNodeCount,
                lastAXVisitedNodeCount: engine.lastAXVisitedNodeCount,
                lastAXCaptureDurationMilliseconds:
                    engine.lastAXCaptureDurationMilliseconds,
                axSlowCaptureCount: engine.axSlowCaptureCount,
                axTruncatedCaptureCount: engine.axTruncatedCaptureCount,
                axCaptureBacklog: engine.axCaptureBacklog,
                screenCaptureGranted: visualCaptureProvider.isScreenCaptureGranted
            ),
            lastError: engine.lastError
        )
    }

    private func applicationDTO(
        _ application: HistoryEvent.Application
    ) -> AgentApplicationDTO {
        AgentApplicationDTO(
            bundleIdentifier: application.bundleIdentifier,
            name: application.name,
            iconPath: applicationIconPath(for: application.bundleIdentifier)
        )
    }

    private func applicationIconPath(for bundleIdentifier: String) -> String? {
        if let cached = applicationIconPaths[bundleIdentifier] { return cached }
        guard !unresolvedApplicationIconIdentifiers.contains(bundleIdentifier),
              let bundleURL = NSWorkspace.shared.urlForApplication(
                  withBundleIdentifier: bundleIdentifier
              ),
              let bundle = Bundle(url: bundleURL),
              let iconName = bundle.object(
                  forInfoDictionaryKey: "CFBundleIconFile"
              ) as? String else {
            unresolvedApplicationIconIdentifiers.insert(bundleIdentifier)
            return nil
        }
        let iconExtension = (iconName as NSString).pathExtension
        let iconResource = (iconName as NSString).deletingPathExtension
        guard let iconURL = bundle.url(
            forResource: iconResource,
            withExtension: iconExtension.isEmpty ? "icns" : iconExtension
        ) else {
            unresolvedApplicationIconIdentifiers.insert(bundleIdentifier)
            return nil
        }
        applicationIconPaths[bundleIdentifier] = iconURL.path
        return iconURL.path
    }
}
