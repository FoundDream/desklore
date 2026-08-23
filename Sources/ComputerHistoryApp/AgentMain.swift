import AppKit
import Foundation

@main
@MainActor
struct DeskLoreCollector {
    static func main() {
        let application = NSApplication.shared
        let delegate = AgentAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.prohibited)
        application.run()
    }
}

@MainActor
private final class AgentAppDelegate: NSObject, NSApplicationDelegate {
    private let engine = HistoryEngine()
    private var bridge: AgentBridge?

    func applicationDidFinishLaunching(_ notification: Notification) {
        bridge = AgentBridge(engine: engine)
        bridge?.start()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        engine.refreshCapturePermissions()
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.stop()
    }
}
