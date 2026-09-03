import AppKit
import CoreGraphics
import DeskLoreNativeCore
import Foundation

@MainActor
final class WorkspaceMonitor: NSObject {
    var onApplicationActivated: ((NSRunningApplication) -> Void)?
    var onAvailabilityChanged: ((Bool, UsageStateEvent.Reason) -> Void)?

    private var availability = UsageAvailabilityGate()
    private var displayStateTimer: Timer?

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        let workspaceNotifications: [(
            Notification.Name,
            Selector
        )] = [
            (NSWorkspace.screensDidSleepNotification, #selector(screensDidSleep)),
            (NSWorkspace.screensDidWakeNotification, #selector(screensDidWake)),
            (NSWorkspace.willSleepNotification, #selector(systemWillSleep)),
            (NSWorkspace.didWakeNotification, #selector(systemDidWake)),
            (NSWorkspace.sessionDidResignActiveNotification, #selector(sessionDidResignActive)),
            (NSWorkspace.sessionDidBecomeActiveNotification, #selector(sessionDidBecomeActive)),
        ]
        for (name, selector) in workspaceNotifications {
            NSWorkspace.shared.notificationCenter.addObserver(
                self,
                selector: selector,
                name: name,
                object: nil
            )
        }
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screenSaverDidStart),
            name: Notification.Name("com.apple.screensaver.didstart"),
            object: nil
        )
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screenSaverDidStop),
            name: Notification.Name("com.apple.screensaver.didstop"),
            object: nil
        )

        pollDisplayState()
        displayStateTimer = Timer.scheduledTimer(
            timeInterval: 2,
            target: self,
            selector: #selector(pollDisplayState),
            userInfo: nil,
            repeats: true
        )

        if let application = NSWorkspace.shared.frontmostApplication {
            onApplicationActivated?(application)
        }
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        displayStateTimer?.invalidate()
        displayStateTimer = nil
        availability = UsageAvailabilityGate()
    }

    @objc
    private func applicationDidActivate(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else {
            return
        }
        updateAvailability(.applicationActivated, reason: .applicationActivation)
        onApplicationActivated?(application)
    }

    private func updateAvailability(
        _ signal: UsageAvailabilityGate.Signal,
        reason: UsageStateEvent.Reason
    ) {
        if let available = availability.handle(signal) {
            onAvailabilityChanged?(available, reason)
        }
    }

    @objc private func screensDidSleep() {
        updateAvailability(.screenSleep, reason: .screenSleep)
    }

    @objc private func screensDidWake() {
        updateAvailability(.screenWake, reason: .screenWake)
    }

    @objc private func pollDisplayState() {
        guard let displaysAsleep = Self.areAllOnlineDisplaysAsleep() else { return }
        if displaysAsleep {
            updateAvailability(.screenSleep, reason: .screenSleep)
        } else {
            updateAvailability(.screenWake, reason: .screenWake)
        }
    }

    @objc private func systemWillSleep() {
        updateAvailability(.systemSleep, reason: .systemSleep)
    }

    @objc private func systemDidWake() {
        updateAvailability(.systemWake, reason: .systemWake)
    }

    @objc private func sessionDidResignActive() {
        updateAvailability(.sessionInactive, reason: .sessionInactive)
    }

    @objc private func sessionDidBecomeActive() {
        updateAvailability(.sessionActive, reason: .sessionActive)
    }

    @objc private func screenSaverDidStart() {
        updateAvailability(.screenSaverStarted, reason: .screenSaverStarted)
    }

    @objc private func screenSaverDidStop() {
        updateAvailability(.screenSaverStopped, reason: .screenSaverStopped)
    }

    private static func areAllOnlineDisplaysAsleep() -> Bool? {
        var displayCount: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &displayCount) == .success,
              displayCount > 0 else {
            return nil
        }

        var displays = [CGDirectDisplayID](
            repeating: kCGNullDirectDisplay,
            count: Int(displayCount)
        )
        guard CGGetOnlineDisplayList(displayCount, &displays, &displayCount) == .success else {
            return nil
        }

        return displays.prefix(Int(displayCount)).allSatisfy {
            CGDisplayIsAsleep($0) != 0
        }
    }
}
