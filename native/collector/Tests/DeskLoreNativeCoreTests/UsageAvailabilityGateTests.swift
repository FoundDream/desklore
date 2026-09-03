import DeskLoreNativeCore
import Testing

@Test("Maintenance wake does not reopen foreground usage")
func maintenanceWakeRemainsUnavailable() {
    var gate = UsageAvailabilityGate()

    #expect(gate.handle(.systemSleep) == false)
    #expect(gate.handle(.systemWake) == nil)
    #expect(!gate.isAvailable)
    #expect(gate.handle(.systemSleep) == nil)
    #expect(gate.handle(.screenWake) == true)
    #expect(gate.isAvailable)
}

@Test("Application activation can recover when a screen wake notification is missed")
func applicationActivationRecoversSystemSleep() {
    var gate = UsageAvailabilityGate()

    #expect(gate.handle(.systemSleep) == false)
    #expect(gate.handle(.applicationActivated) == true)
    #expect(gate.isAvailable)
}

@Test("Polled display state closes and reopens foreground usage")
func polledDisplayStateChangesAvailability() {
    var gate = UsageAvailabilityGate()

    #expect(gate.handle(.screenSleep) == false)
    #expect(gate.handle(.screenSleep) == nil)
    #expect(!gate.isAvailable)
    #expect(gate.handle(.screenWake) == true)
    #expect(gate.handle(.screenWake) == nil)
    #expect(gate.isAvailable)
}

@Test("A remaining privacy blocker keeps usage unavailable after wake")
func wakePreservesOtherBlockers() {
    var gate = UsageAvailabilityGate()

    #expect(gate.handle(.screenSaverStarted) == false)
    #expect(gate.handle(.systemSleep) == nil)
    #expect(gate.handle(.screenWake) == nil)
    #expect(!gate.isAvailable)
    #expect(gate.handle(.screenSaverStopped) == true)
}
