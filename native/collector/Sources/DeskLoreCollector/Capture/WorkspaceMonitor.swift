import AppKit
import DeskLoreNativeCore
import Foundation

@MainActor
final class WorkspaceMonitor: NSObject {
    var onApplicationActivated: ((NSRunningApplication) -> Void)?
    var onAvailabilityChanged: ((Bool, UsageStateEvent.Reason) -> Void)?

    private enum AvailabilityBlocker: Hashable {
        case screenSleep
        case systemSleep
        case sessionInactive
        case screenSaver
    }

    private var blockers: Set<AvailabilityBlocker> = []

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

        if let application = NSWorkspace.shared.frontmostApplication {
            onApplicationActivated?(application)
        }
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        blockers.removeAll()
    }

    @objc
    private func applicationDidActivate(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else {
            return
        }
        onApplicationActivated?(application)
    }

    private func block(_ blocker: AvailabilityBlocker, reason: UsageStateEvent.Reason) {
        let wasAvailable = blockers.isEmpty
        blockers.insert(blocker)
        if wasAvailable { onAvailabilityChanged?(false, reason) }
    }

    private func unblock(_ blocker: AvailabilityBlocker, reason: UsageStateEvent.Reason) {
        let wasAvailable = blockers.isEmpty
        blockers.remove(blocker)
        if !wasAvailable, blockers.isEmpty { onAvailabilityChanged?(true, reason) }
    }

    @objc private func screensDidSleep() {
        block(.screenSleep, reason: .screenSleep)
    }

    @objc private func screensDidWake() {
        unblock(.screenSleep, reason: .screenWake)
    }

    @objc private func systemWillSleep() {
        block(.systemSleep, reason: .systemSleep)
    }

    @objc private func systemDidWake() {
        unblock(.systemSleep, reason: .systemWake)
    }

    @objc private func sessionDidResignActive() {
        block(.sessionInactive, reason: .sessionInactive)
    }

    @objc private func sessionDidBecomeActive() {
        unblock(.sessionInactive, reason: .sessionActive)
    }

    @objc private func screenSaverDidStart() {
        block(.screenSaver, reason: .screenSaverStarted)
    }

    @objc private func screenSaverDidStop() {
        unblock(.screenSaver, reason: .screenSaverStopped)
    }
}
