import Foundation

public struct UsageStateEvent: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case foreground
        case excluded
        case unavailable
    }

    public enum Reason: String, Codable, Sendable {
        case applicationActivation = "application_activation"
        case policyChanged = "policy_changed"
        case pause
        case resume
        case screenSleep = "screen_sleep"
        case screenWake = "screen_wake"
        case systemSleep = "system_sleep"
        case systemWake = "system_wake"
        case sessionInactive = "session_inactive"
        case sessionActive = "session_active"
        case screenSaverStarted = "screen_saver_started"
        case screenSaverStopped = "screen_saver_stopped"
    }

    public let timestamp: Date
    public let state: State
    public let reason: Reason
    public let application: HistoryEvent.Application?

    public init(
        timestamp: Date = Date(),
        state: State,
        reason: Reason,
        application: HistoryEvent.Application? = nil
    ) {
        self.timestamp = timestamp
        self.state = state
        self.reason = reason
        self.application = state == .foreground ? application : nil
    }
}
