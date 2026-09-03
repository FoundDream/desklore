package struct UsageAvailabilityGate: Sendable {
    package enum Signal: Sendable {
        case applicationActivated
        case screenSleep
        case screenWake
        case systemSleep
        case systemWake
        case sessionInactive
        case sessionActive
        case screenSaverStarted
        case screenSaverStopped
    }

    private enum Blocker: Hashable, Sendable {
        case screenSleep
        case systemSleep
        case sessionInactive
        case screenSaver
    }

    private var blockers: Set<Blocker> = []

    package init() {}

    package var isAvailable: Bool {
        blockers.isEmpty
    }

    /// Returns the new availability only when the externally visible state changes.
    @discardableResult
    package mutating func handle(_ signal: Signal) -> Bool? {
        let wasAvailable = isAvailable
        switch signal {
        case .applicationActivated:
            // Treat an app activation as user-visible recovery; maintenance DarkWake
            // does not normally activate an application.
            blockers.remove(.systemSleep)
        case .screenSleep:
            blockers.insert(.screenSleep)
        case .screenWake:
            blockers.remove(.screenSleep)
            blockers.remove(.systemSleep)
        case .systemSleep:
            blockers.insert(.systemSleep)
        case .systemWake:
            // NSWorkspace also posts didWake during maintenance DarkWake. Wait for a
            // user-visible signal before reopening foreground usage.
            break
        case .sessionInactive:
            blockers.insert(.sessionInactive)
        case .sessionActive:
            blockers.remove(.sessionInactive)
            blockers.remove(.systemSleep)
        case .screenSaverStarted:
            blockers.insert(.screenSaver)
        case .screenSaverStopped:
            blockers.remove(.screenSaver)
        }
        return wasAvailable == isAvailable ? nil : isAvailable
    }
}
