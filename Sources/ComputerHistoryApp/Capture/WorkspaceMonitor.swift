import AppKit
import Foundation

@MainActor
final class WorkspaceMonitor: NSObject {
    var onApplicationActivated: ((NSRunningApplication) -> Void)?

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )

        if let application = NSWorkspace.shared.frontmostApplication {
            onApplicationActivated?(application)
        }
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc
    private func applicationDidActivate(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else {
            return
        }
        onApplicationActivated?(application)
    }
}
