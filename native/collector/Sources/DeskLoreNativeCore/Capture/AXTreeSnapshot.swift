import Foundation

public struct AXTreeNode: Equatable, Identifiable, Sendable {
    public let id: String
    public let parentID: String?
    public let depth: Int
    public let siblingIndex: Int
    public let role: String
    public let subrole: String?
    public let identifier: String?
    public let title: String?
    public let description: String?
    public let help: String?
    public let placeholder: String?
    public let value: String?
    public let enabled: Bool?
    public let focused: Bool?
    public let selected: Bool?
    public let expanded: Bool?
    public let disclosureLevel: Int?
    public let childCount: Int

    public init(
        id: String,
        parentID: String? = nil,
        depth: Int,
        siblingIndex: Int,
        role: String,
        subrole: String? = nil,
        identifier: String? = nil,
        title: String? = nil,
        description: String? = nil,
        help: String? = nil,
        placeholder: String? = nil,
        value: String? = nil,
        enabled: Bool? = nil,
        focused: Bool? = nil,
        selected: Bool? = nil,
        expanded: Bool? = nil,
        disclosureLevel: Int? = nil,
        childCount: Int = 0
    ) {
        self.id = id
        self.parentID = parentID
        self.depth = depth
        self.siblingIndex = siblingIndex
        self.role = role
        self.subrole = subrole
        self.identifier = identifier
        self.title = title
        self.description = description
        self.help = help
        self.placeholder = placeholder
        self.value = value
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.expanded = expanded
        self.disclosureLevel = disclosureLevel
        self.childCount = childCount
    }

    fileprivate var contentSignature: ContentSignature {
        ContentSignature(
            role: role,
            subrole: subrole,
            identifier: identifier,
            title: title,
            description: description,
            help: help,
            placeholder: placeholder,
            value: value,
            enabled: enabled,
            focused: focused,
            selected: selected,
            expanded: expanded,
            disclosureLevel: disclosureLevel,
            childCount: childCount
        )
    }

    fileprivate struct ContentSignature: Equatable {
        let role: String
        let subrole: String?
        let identifier: String?
        let title: String?
        let description: String?
        let help: String?
        let placeholder: String?
        let value: String?
        let enabled: Bool?
        let focused: Bool?
        let selected: Bool?
        let expanded: Bool?
        let disclosureLevel: Int?
        let childCount: Int
    }
}

public struct AXTreeSnapshot: Equatable, Sendable {
    public let nodes: [AXTreeNode]
    public let visitedNodeCount: Int
    public let wasTruncated: Bool

    public init(
        nodes: [AXTreeNode],
        visitedNodeCount: Int? = nil,
        wasTruncated: Bool = false
    ) {
        self.nodes = nodes
        self.visitedNodeCount = visitedNodeCount ?? nodes.count
        self.wasTruncated = wasTruncated
    }
}

public struct AXTreeDelta: Equatable, Sendable {
    public let added: [AXTreeNode]
    public let removed: [AXTreeNode]
    public let updated: [AXTreeNode]
    public let moved: [AXTreeNode]

    public var changeCount: Int {
        added.count + removed.count + updated.count + moved.count
    }

    public var isEmpty: Bool { changeCount == 0 }

    public init(
        added: [AXTreeNode],
        removed: [AXTreeNode],
        updated: [AXTreeNode],
        moved: [AXTreeNode]
    ) {
        self.added = added
        self.removed = removed
        self.updated = updated
        self.moved = moved
    }
}

public enum AXTreeDiffer {
    public static func diff(
        previous: AXTreeSnapshot,
        current: AXTreeSnapshot
    ) -> AXTreeDelta {
        let previousByID = Dictionary(
            uniqueKeysWithValues: previous.nodes.map { ($0.id, $0) }
        )
        let currentByID = Dictionary(
            uniqueKeysWithValues: current.nodes.map { ($0.id, $0) }
        )

        let added = current.nodes.filter { previousByID[$0.id] == nil }
        let removed = previous.nodes.filter { currentByID[$0.id] == nil }
        let updated = current.nodes.filter { node in
            guard let old = previousByID[node.id] else { return false }
            return old.contentSignature != node.contentSignature
        }
        let moved = current.nodes.filter { node in
            guard let old = previousByID[node.id] else { return false }
            return old.parentID != node.parentID
                || old.depth != node.depth
                || old.siblingIndex != node.siblingIndex
        }
        return AXTreeDelta(
            added: added,
            removed: removed,
            updated: updated,
            moved: moved
        )
    }
}

public enum AXTreeRenderer {
    public static func fullText(
        _ snapshot: AXTreeSnapshot,
        characterLimit: Int = 48_000
    ) -> String {
        let header = "AXTree v2 nodes=\(snapshot.nodes.count) "
            + "visited=\(snapshot.visitedNodeCount) "
            + "truncated=\(snapshot.wasTruncated)"
        let lines = [header] + snapshot.nodes.map { render($0) }
        return bounded(lines: lines, characterLimit: characterLimit)
    }

    public static func diffText(
        previous: AXTreeSnapshot,
        current: AXTreeSnapshot,
        characterLimit: Int = 48_000
    ) -> String? {
        let delta = AXTreeDiffer.diff(previous: previous, current: current)
        guard !delta.isEmpty else { return nil }
        var lines = [
            "AXTreeDiff v2 added=\(delta.added.count) "
                + "removed=\(delta.removed.count) "
                + "updated=\(delta.updated.count) "
                + "moved=\(delta.moved.count)",
        ]
        lines.append(contentsOf: delta.removed.map {
            "- \($0.id) \($0.role) parent=\($0.parentID ?? "root")"
        })
        lines.append(contentsOf: delta.added.map { "+ " + render($0) })
        lines.append(contentsOf: delta.updated.map { "~ " + render($0) })
        lines.append(contentsOf: delta.moved.map { "> " + render($0) })
        return bounded(lines: lines, characterLimit: characterLimit)
    }

    private static func render(_ node: AXTreeNode) -> String {
        let indentation = String(repeating: "  ", count: min(node.depth, 24))
        var components = ["\(node.id) \(node.role)"]
        if let subrole = node.subrole { components.append("subrole=\(quoted(subrole))") }
        if let identifier = node.identifier {
            components.append("identifier=\(quoted(identifier))")
        }
        if node.childCount > 0 { components.append("children=\(node.childCount)") }
        if node.enabled == false { components.append("disabled") }
        if node.focused == true { components.append("focused") }
        if node.selected == true { components.append("selected") }
        if let expanded = node.expanded {
            components.append(expanded ? "expanded" : "collapsed")
        }
        if let disclosureLevel = node.disclosureLevel {
            components.append("level=\(disclosureLevel)")
        }
        if let title = node.title { components.append("title=\(quoted(title))") }
        if let description = node.description {
            components.append("description=\(quoted(description))")
        }
        if let placeholder = node.placeholder {
            components.append("placeholder=\(quoted(placeholder))")
        }
        if let help = node.help { components.append("help=\(quoted(help))") }
        if let value = node.value { components.append("value=\(quoted(value))") }
        if let parentID = node.parentID { components.append("parent=\(parentID)") }
        return indentation + components.joined(separator: " ")
    }

    private static func quoted(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }

    private static func bounded(lines: [String], characterLimit: Int) -> String {
        guard characterLimit > 0 else { return "" }
        var result = ""
        var omitted = 0
        for (index, line) in lines.enumerated() {
            let candidate = result.isEmpty ? line : "\n" + line
            guard result.count + candidate.count <= characterLimit else {
                omitted = lines.count - index
                break
            }
            result += candidate
        }
        guard omitted > 0 else { return result }
        let marker = "\n… truncated \(omitted) AX tree lines"
        if result.count + marker.count <= characterLimit {
            result += marker
        }
        return result
    }
}
