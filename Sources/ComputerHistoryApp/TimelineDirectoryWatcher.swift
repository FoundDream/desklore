import Darwin
import Foundation

@MainActor
final class TimelineDirectoryWatcher {
    private var source: DispatchSourceFileSystemObject?

    func start(
        directory: URL,
        onChange: @escaping @MainActor @Sendable () -> Void
    ) throws {
        stop()
        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else {
            throw CocoaError(.fileReadNoPermission)
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler {
            Task { @MainActor in
                onChange()
            }
        }
        source.setCancelHandler {
            close(descriptor)
        }
        source.resume()
        self.source = source
    }

    func stop() {
        source?.cancel()
        source = nil
    }
}
