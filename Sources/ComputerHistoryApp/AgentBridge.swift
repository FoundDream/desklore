import AppKit
import Combine
import ComputerHistoryCore
import Foundation

private struct AgentCommand: Decodable {
    let id: String
    let command: String
    let documentID: String?
    let enabled: Bool?
    let model: String?
    let endpoint: String?
    let apiKey: String?
}

private struct AgentApplicationDTO: Encodable {
    let bundleIdentifier: String
    let name: String
}

private struct AgentTimelineDTO: Encodable {
    let id: String
    let startedAt: String
    let endedAt: String
    let title: String
    let description: String
    let activityState: String?
    let applications: [AgentApplicationDTO]
    let generatorType: String
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
}

private struct AgentLLMDTO: Encodable {
    let enabled: Bool
    let model: String
    let endpoint: String
    let apiKeyConfigured: Bool
}

private struct AgentSnapshotDTO: Encodable {
    let recorderState: String
    let storageRoot: String
    let activeApplication: AgentApplicationDTO?
    let activeApplicationAllowed: Bool?
    let activeDomain: String?
    let activeDomainAllowed: Bool?
    let documents: [AgentTimelineDTO]
    let health: AgentHealthDTO
    let llm: AgentLLMDTO
    let lastError: String?
}

private struct AgentSnapshotMessage: Encodable {
    let type = "snapshot"
    let requestID: String?
    let snapshot: AgentSnapshotDTO
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
        for line in lines where !line.isEmpty {
            onLine(line)
        }
    }
}

@MainActor
final class AgentBridge {
    private let engine: HistoryEngine
    private let encoder = JSONEncoder()
    private var cancellables: Set<AnyCancellable> = []
    private lazy var inputReader = AgentInputReader(
        onLine: { [weak self] data in
            Task { @MainActor [weak self] in
                self?.handle(data)
            }
        },
        onEOF: {
            Task { @MainActor in
                NSApplication.shared.terminate(nil)
            }
        }
    )

    init(engine: HistoryEngine) {
        self.engine = engine
    }

    func start() {
        engine.objectWillChange
            .debounce(for: .milliseconds(80), scheduler: RunLoop.main)
            .sink { [weak self] in self?.sendSnapshot() }
            .store(in: &cancellables)
        inputReader.start()
        sendSnapshot()
    }

    func stop() {
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
        case "allowActiveApplication":
            engine.allowActiveApplication()
        case "blockActiveApplication":
            engine.blockActiveApplication()
        case "allowActiveDomain":
            engine.allowActiveDomain()
        case "blockActiveDomain":
            engine.blockActiveDomain()
        case "configureLLM":
            guard let enabled = command.enabled,
                  let model = command.model,
                  let endpoint = command.endpoint else {
                sendError("Missing LLM configuration", requestID: command.id)
                return
            }
            engine.configureLLM(
                enabled: enabled,
                model: model,
                endpoint: endpoint,
                apiKey: command.apiKey ?? ""
            )
        case "removeLLMAPIKey":
            engine.removeLLMAPIKey()
        case "openDocument":
            guard let document = document(command.documentID) else {
                sendError("Timeline document not found", requestID: command.id)
                return
            }
            engine.openMarkdown(document)
        case "deleteDocument":
            guard let document = document(command.documentID) else {
                sendError("Timeline document not found", requestID: command.id)
                return
            }
            engine.delete(document)
        case "revealStorage":
            engine.revealStorageInFinder()
        case "quit":
            sendSnapshot(requestID: command.id)
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
            return
        default:
            sendError("Unsupported agent command", requestID: command.id)
            return
        }
        sendSnapshot(requestID: command.id)
    }

    private func document(_ id: String?) -> TimelineDocument? {
        guard let id else { return nil }
        return engine.documents.first { $0.id == id }
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
            storageRoot: engine.storageRoot.path,
            activeApplication: engine.activeApplication.map {
                AgentApplicationDTO(
                    bundleIdentifier: $0.bundleIdentifier,
                    name: $0.name
                )
            },
            activeApplicationAllowed: engine.activeApplication == nil
                ? nil
                : engine.isActiveApplicationAllowed(),
            activeDomain: engine.activeDomain,
            activeDomainAllowed: engine.activeDomain == nil
                ? nil
                : engine.isActiveDomainAllowed(),
            documents: engine.documents.map { document in
                AgentTimelineDTO(
                    id: document.id,
                    startedAt: Self.dateString(document.startedAt),
                    endedAt: Self.dateString(document.endedAt),
                    title: document.title,
                    description: document.description,
                    activityState: document.activityState?.rawValue,
                    applications: document.applications.map {
                        AgentApplicationDTO(
                            bundleIdentifier: $0.bundleIdentifier,
                            name: $0.name
                        )
                    },
                    generatorType: document.generator.type
                )
            },
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
                axCaptureBacklog: engine.axCaptureBacklog
            ),
            llm: AgentLLMDTO(
                enabled: engine.llmEnabled,
                model: engine.llmModel,
                endpoint: engine.llmEndpoint,
                apiKeyConfigured: engine.llmAPIKeyConfigured
            ),
            lastError: engine.lastError
        )
    }

    private static func dateString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
