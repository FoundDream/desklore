import Foundation

public enum TimelineMarkdownCodecError: Error, Equatable {
    case missingFrontmatter
    case missingField(String)
    case invalidField(String)
    case unsupportedSchemaVersion(Int)
}

public enum TimelineMarkdownCodec {
    public static func encode(_ document: TimelineDocument) -> String {
        var lines = [
            "---",
            "schema_version: \(document.schemaVersion)",
            "id: \(quoted(document.id))",
            "source_segment_id: \(quoted(document.sourceSegmentID))",
            "started_at: \(quoted(DateCoding.string(from: document.startedAt)))",
            "ended_at: \(quoted(DateCoding.string(from: document.endedAt)))",
            "title: \(quoted(document.title))",
            "description: \(quoted(document.description))",
        ]
        if let activityState = document.activityState {
            lines.append("activity_state: \(quoted(activityState.rawValue))")
        }
        lines.append("applications:")

        if document.applications.isEmpty {
            lines.append("  []")
        } else {
            for application in document.applications {
                lines.append("  - bundle_id: \(quoted(application.bundleIdentifier))")
                lines.append("    name: \(quoted(application.name))")
            }
        }

        lines.append("evidence_event_ids:")
        if document.evidenceEventIDs.isEmpty {
            lines.append("  []")
        } else {
            lines.append(contentsOf: document.evidenceEventIDs.map { "  - \(quoted($0))" })
        }

        lines.append(contentsOf: [
            "generator:",
            "  type: \(quoted(document.generator.type))",
            "  version: \(document.generator.version)",
        ])
        if let model = document.generator.model {
            lines.append("  model: \(quoted(model))")
        }
        lines.append(contentsOf: [
            "created_at: \(quoted(DateCoding.string(from: document.createdAt)))",
            "---",
            "",
            document.body.trimmingCharacters(in: .whitespacesAndNewlines),
            "",
        ])
        return lines.joined(separator: "\n")
    }

    public static func decode(_ markdown: String, fileURL: URL? = nil) throws -> TimelineDocument {
        let lines = markdown.components(separatedBy: .newlines)
        guard lines.first == "---",
              let closingIndex = lines.dropFirst().firstIndex(of: "---") else {
            throw TimelineMarkdownCodecError.missingFrontmatter
        }

        let frontmatter = Array(lines[1..<closingIndex])
        let body = lines[(closingIndex + 1)...]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let scalars = parseTopLevelScalars(frontmatter)

        let schemaVersion = try integer("schema_version", from: scalars)
        guard schemaVersion == TimelineDocument.currentSchemaVersion else {
            throw TimelineMarkdownCodecError.unsupportedSchemaVersion(schemaVersion)
        }
        let id = try required("id", from: scalars)
        let sourceSegmentID = try required("source_segment_id", from: scalars)
        let startedAt = try date("started_at", from: scalars)
        let endedAt = try date("ended_at", from: scalars)
        let title = try required("title", from: scalars)
        let description = try required("description", from: scalars)
        let activityState: TimelineActivityState?
        if let rawActivityState = scalars["activity_state"] {
            guard let parsed = TimelineActivityState(rawValue: rawActivityState) else {
                throw TimelineMarkdownCodecError.invalidField("activity_state")
            }
            activityState = parsed
        } else {
            activityState = nil
        }
        let createdAt = try date("created_at", from: scalars)
        let applications = parseApplications(frontmatter)
        let evidenceEventIDs = parseStringList(
            named: "evidence_event_ids",
            from: frontmatter
        )
        let generator = try parseGenerator(frontmatter)

        return TimelineDocument(
            schemaVersion: schemaVersion,
            id: id,
            sourceSegmentID: sourceSegmentID,
            startedAt: startedAt,
            endedAt: endedAt,
            title: title,
            description: description,
            activityState: activityState,
            applications: applications,
            evidenceEventIDs: evidenceEventIDs,
            generator: generator,
            createdAt: createdAt,
            body: body,
            fileURL: fileURL
        )
    }

    private static func parseStringList(named key: String, from lines: [String]) -> [String] {
        guard let start = lines.firstIndex(of: "\(key):") else { return [] }
        var values: [String] = []
        for line in lines[(start + 1)...] {
            if !line.hasPrefix(" ") { break }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("-") else { continue }
            let value = unquoted(
                String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
            )
            if !value.isEmpty { values.append(value) }
        }
        return values
    }

    private static func parseTopLevelScalars(_ lines: [String]) -> [String: String] {
        var values: [String: String] = [:]
        for line in lines where !line.hasPrefix(" ") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon])
            let value = String(line[line.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            if !value.isEmpty {
                values[key] = unquoted(value)
            }
        }
        return values
    }

    private static func parseApplications(_ lines: [String]) -> [HistoryEvent.Application] {
        guard let start = lines.firstIndex(of: "applications:") else { return [] }
        var applications: [HistoryEvent.Application] = []
        var bundleIdentifier: String?
        var name: String?

        for line in lines[(start + 1)...] {
            if !line.hasPrefix(" ") { break }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("- bundle_id:") {
                if let bundleIdentifier, let name {
                    applications.append(.init(bundleIdentifier: bundleIdentifier, name: name))
                }
                bundleIdentifier = value(after: ":", in: trimmed)
                name = nil
            } else if trimmed.hasPrefix("name:") {
                name = value(after: ":", in: trimmed)
            }
        }

        if let bundleIdentifier, let name {
            applications.append(.init(bundleIdentifier: bundleIdentifier, name: name))
        }
        return applications
    }

    private static func parseGenerator(_ lines: [String]) throws -> TimelineDocument.Generator {
        guard let start = lines.firstIndex(of: "generator:") else {
            throw TimelineMarkdownCodecError.missingField("generator")
        }
        var type: String?
        var version: Int?
        var model: String?

        for line in lines[(start + 1)...] {
            if !line.hasPrefix(" ") { break }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("type:") {
                type = value(after: ":", in: trimmed)
            } else if trimmed.hasPrefix("version:") {
                version = Int(value(after: ":", in: trimmed))
            } else if trimmed.hasPrefix("model:") {
                model = value(after: ":", in: trimmed)
            }
        }

        guard let type else {
            throw TimelineMarkdownCodecError.missingField("generator.type")
        }
        guard let version else {
            throw TimelineMarkdownCodecError.missingField("generator.version")
        }
        return .init(type: type, version: version, model: model)
    }

    private static func required(
        _ key: String,
        from values: [String: String]
    ) throws -> String {
        guard let value = values[key], !value.isEmpty else {
            throw TimelineMarkdownCodecError.missingField(key)
        }
        return value
    }

    private static func integer(
        _ key: String,
        from values: [String: String]
    ) throws -> Int {
        let value = try required(key, from: values)
        guard let integer = Int(value) else {
            throw TimelineMarkdownCodecError.invalidField(key)
        }
        return integer
    }

    private static func date(
        _ key: String,
        from values: [String: String]
    ) throws -> Date {
        let value = try required(key, from: values)
        guard let date = DateCoding.date(from: value) else {
            throw TimelineMarkdownCodecError.invalidField(key)
        }
        return date
    }

    private static func value(after separator: Character, in line: String) -> String {
        guard let index = line.firstIndex(of: separator) else { return "" }
        return unquoted(
            String(line[line.index(after: index)...])
                .trimmingCharacters(in: .whitespaces)
        )
    }

    private static func quoted(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }

    private static func unquoted(_ value: String) -> String {
        guard value.count >= 2, value.first == "\"", value.last == "\"" else {
            return value
        }
        let inner = value.dropFirst().dropLast()
        var result = ""
        var escaping = false
        for character in inner {
            if escaping {
                switch character {
                case "n": result.append("\n")
                case "\"": result.append("\"")
                case "\\": result.append("\\")
                default: result.append(character)
                }
                escaping = false
            } else if character == "\\" {
                escaping = true
            } else {
                result.append(character)
            }
        }
        if escaping { result.append("\\") }
        return result
    }
}

private enum DateCoding {
    static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }
        return ISO8601DateFormatter().date(from: value)
    }
}
