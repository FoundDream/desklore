import AppKit
import Combine
import SwiftUI

@MainActor
final class ComputerHistoryAppDelegate: NSObject, NSApplicationDelegate {
    let engine = HistoryEngine()

    private let statusItem = NSStatusBar.system.statusItem(
        withLength: NSStatusItem.variableLength
    )
    private let popover = NSPopover()
    private var timelineWindowController: NSWindowController?
    private var cancellables: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        configureStatusItem()
        configurePopover()
        observeEngineState()
        engine.start()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        engine.refreshCapturePermissions()
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(togglePopover(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.toolTip = "Computer History"
        updateStatusItem(for: engine.state)
    }

    private func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 348, height: 520)
        popover.contentViewController = NSHostingController(
            rootView: MenuBarView(
                engine: engine,
                onOpenTimeline: { [weak self] in
                    self?.popover.performClose(nil)
                    self?.showTimeline()
                }
            )
        )
    }

    private func observeEngineState() {
        engine.$state
            .receive(on: RunLoop.main)
            .sink { [weak self] state in
                self?.updateStatusItem(for: state)
            }
            .store(in: &cancellables)
    }

    private func updateStatusItem(for state: HistoryEngine.RecorderState) {
        let symbolName = state == .running
            ? "clock.badge.checkmark"
            : "clock.badge.pause"
        statusItem.button?.image = NSImage(
            systemSymbolName: symbolName,
            accessibilityDescription: "Computer History"
        )
    }

    @objc
    private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(
                relativeTo: sender.bounds,
                of: sender,
                preferredEdge: .minY
            )
        }
    }

    private func showTimeline() {
        if timelineWindowController == nil {
            let hostingController = NSHostingController(
                rootView: TimelineView(engine: engine)
            )
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 980, height: 760),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = "Computer History"
            window.contentViewController = hostingController
            window.center()
            window.setFrameAutosaveName("ComputerHistoryTimelineWindow")
            timelineWindowController = NSWindowController(window: window)
        }

        timelineWindowController?.showWindow(nil)
        timelineWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
