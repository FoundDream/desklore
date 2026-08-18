import Foundation

public enum SegmentReader {
    public static func readEvents(from url: URL) throws -> [HistoryEvent] {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }

        let contents = try String(contentsOf: url, encoding: .utf8)
        let decoder = HistoryCoders.jsonDecoder()

        return try contents
            .split(separator: "\n")
            .map { line in
                guard let data = String(line).data(using: .utf8) else {
                    throw CocoaError(.fileReadInapplicableStringEncoding)
                }
                return try decoder.decode(HistoryEvent.self, from: data)
            }
    }
}
