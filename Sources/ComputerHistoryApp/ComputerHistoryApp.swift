import SwiftUI

@main
@MainActor
struct ComputerHistoryApp: App {
    @NSApplicationDelegateAdaptor(ComputerHistoryAppDelegate.self)
    private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
