import ComputerHistoryCore
import Foundation

@main
enum ComputerHistoryEval {
    static func main() {
        do {
            let arguments = CommandLine.arguments.dropFirst()
            guard arguments.count == 2 else {
                throw EvaluationCLIError.usage
            }
            let eventsURL = URL(fileURLWithPath: String(arguments[arguments.startIndex]))
            let markdownIndex = arguments.index(after: arguments.startIndex)
            let markdownURL = URL(fileURLWithPath: String(arguments[markdownIndex]))
            let events = try SegmentReader.readEvents(from: eventsURL)
            let markdown = try String(contentsOf: markdownURL, encoding: .utf8)
            let document = try TimelineMarkdownCodec.decode(
                markdown,
                fileURL: markdownURL
            )
            let report = TimelineSummaryEvaluator.evaluate(
                document: document,
                events: events
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(report)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            if !report.passesIntegrityGate {
                Foundation.exit(EXIT_FAILURE)
            }
        } catch {
            let message = "\(error.localizedDescription)\n"
            FileHandle.standardError.write(Data(message.utf8))
            Foundation.exit(EXIT_FAILURE)
        }
    }
}

private enum EvaluationCLIError: LocalizedError {
    case usage

    var errorDescription: String? {
        "Usage: ComputerHistoryEval <events.jsonl> <timeline.md>"
    }
}
