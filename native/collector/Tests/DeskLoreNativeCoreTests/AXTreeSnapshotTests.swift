import Foundation
import XCTest
@testable import DeskLoreNativeCore

final class AXTreeSnapshotTests: XCTestCase {
    func testNodeIdentityKeepsDuplicateLabelsSeparateInDiff() {
        let previous = AXTreeSnapshot(nodes: [
            node(id: "1", depth: 0, role: "AXWindow", childCount: 2),
            node(id: "2", parentID: "1", depth: 1, role: "AXButton", title: "Open"),
            node(id: "3", parentID: "1", depth: 1, role: "AXButton", title: "Open"),
        ])
        let current = AXTreeSnapshot(nodes: [
            node(id: "1", depth: 0, role: "AXWindow", childCount: 2),
            node(id: "2", parentID: "1", depth: 1, role: "AXButton", title: "Opened"),
            node(id: "3", parentID: "1", depth: 1, role: "AXButton", title: "Open"),
        ])

        let delta = AXTreeDiffer.diff(previous: previous, current: current)

        XCTAssertEqual(delta.updated.map(\.id), ["2"])
        XCTAssertTrue(delta.added.isEmpty)
        XCTAssertTrue(delta.removed.isEmpty)
        XCTAssertTrue(delta.moved.isEmpty)
    }

    func testDiffReportsMovesAddsAndRemovals() {
        let previous = AXTreeSnapshot(nodes: [
            node(id: "1", depth: 0, role: "AXWindow", childCount: 2),
            node(id: "2", parentID: "1", depth: 1, role: "AXGroup", childCount: 1),
            node(id: "3", parentID: "2", depth: 2, role: "AXButton"),
            node(id: "4", parentID: "1", depth: 1, role: "AXStaticText"),
        ])
        let current = AXTreeSnapshot(nodes: [
            node(id: "1", depth: 0, role: "AXWindow", childCount: 2),
            node(id: "2", parentID: "1", depth: 1, role: "AXGroup", childCount: 1),
            node(id: "3", parentID: "1", depth: 1, siblingIndex: 1, role: "AXButton"),
            node(id: "5", parentID: "2", depth: 2, role: "AXLink"),
        ])

        let delta = AXTreeDiffer.diff(previous: previous, current: current)

        XCTAssertEqual(delta.added.map(\.id), ["5"])
        XCTAssertEqual(delta.removed.map(\.id), ["4"])
        XCTAssertEqual(delta.moved.map(\.id), ["3"])
    }

    func testAccessibilityContextEncodesStructuredTreeAndOmitsNilFields() throws {
        let snapshot = AXTreeSnapshot(
            nodes: [
                node(id: "1", depth: 0, role: "AXWindow", childCount: 1),
                node(
                    id: "2",
                    parentID: "1",
                    depth: 1,
                    role: "AXStaticText",
                    value: "Visible body",
                    focused: true
                ),
            ],
            visitedNodeCount: 3,
            wasTruncated: true
        )
        let context = HistoryEvent.AccessibilityContext(mode: .fullTree, tree: snapshot)

        let data = try JSONEncoder().encode(context)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let tree = try XCTUnwrap(object["tree"] as? [String: Any])
        let nodes = try XCTUnwrap(tree["nodes"] as? [[String: Any]])

        XCTAssertEqual(object["mode"] as? String, "fullTree")
        XCTAssertNil(object["delta"])
        XCTAssertEqual(tree["visitedNodeCount"] as? Int, 3)
        XCTAssertEqual(tree["wasTruncated"] as? Bool, true)
        XCTAssertEqual(nodes.count, 2)
        XCTAssertEqual(nodes[1]["parentID"] as? String, "1")
        XCTAssertEqual(nodes[1]["value"] as? String, "Visible body")
        XCTAssertEqual(nodes[1]["focused"] as? Bool, true)
        XCTAssertNil(nodes[0]["title"])

        let decoded = try JSONDecoder().decode(
            HistoryEvent.AccessibilityContext.self,
            from: data
        )
        XCTAssertEqual(decoded, context)
    }

    func testAccessibilityContextEncodesDeltaGroups() throws {
        let delta = AXTreeDelta(
            added: [node(id: "5", parentID: "2", depth: 2, role: "AXLink")],
            removed: [node(id: "4", parentID: "1", depth: 1, role: "AXStaticText")],
            updated: [],
            moved: []
        )
        let context = HistoryEvent.AccessibilityContext(mode: .diffFromPrevious, delta: delta)

        let data = try JSONEncoder().encode(context)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let encodedDelta = try XCTUnwrap(object["delta"] as? [String: Any])

        XCTAssertEqual(object["mode"] as? String, "diffFromPrevious")
        XCTAssertNil(object["tree"])
        XCTAssertEqual((encodedDelta["added"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((encodedDelta["removed"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((encodedDelta["updated"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual((encodedDelta["moved"] as? [[String: Any]])?.count, 0)
    }

    private func node(
        id: String,
        parentID: String? = nil,
        depth: Int,
        siblingIndex: Int = 0,
        role: String,
        title: String? = nil,
        value: String? = nil,
        focused: Bool? = nil,
        expanded: Bool? = nil,
        childCount: Int = 0
    ) -> AXTreeNode {
        AXTreeNode(
            id: id,
            parentID: parentID,
            depth: depth,
            siblingIndex: siblingIndex,
            role: role,
            title: title,
            value: value,
            focused: focused,
            expanded: expanded,
            childCount: childCount
        )
    }
}
