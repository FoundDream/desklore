import AppKit
import Foundation

@main
@MainActor
struct DeskLoreCollector {
    static func main() {
        let application = NSApplication.shared
        let delegate = CollectorAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.prohibited)
        application.run()
    }
}

@MainActor
private final class CollectorAppDelegate: NSObject, NSApplicationDelegate {
    private let engine = HistoryEngine()
    private var bridge: CollectorBridge?

    func applicationDidFinishLaunching(_ notification: Notification) {
        bridge = CollectorBridge(engine: engine)
        bridge?.start()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        engine.refreshCapturePermissions()
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.stop()
    }
}
