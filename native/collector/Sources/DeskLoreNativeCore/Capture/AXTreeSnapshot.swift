import Foundation

public struct AXTreeNode: Codable, Equatable, Identifiable, Sendable {
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

public struct AXTreeSnapshot: Codable, Equatable, Sendable {
    public let nodes: [AXTreeNode]
    public let visitedNodeCount: Int
    public let wasTruncated: Bool

    /// Chromium and Electron applications expose a handful of empty groups until an
    /// assistive client asks for the full tree. A tiny tree with at most one text-bearing
    /// node outside the window is the signal that such a request is worth making.
    public var isDegenerate: Bool {
        guard nodes.count <= 16 else { return false }
        let textBearing = nodes.filter { node in
            node.role != "AXWindow"
                && [node.value, node.title, node.description]
                    .contains { !($0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
        }
        return textBearing.count <= 1
    }

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

public struct AXTreeDelta: Codable, Equatable, Sendable {
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
