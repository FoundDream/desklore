import XCTest
@testable import DeskLoreNativeCore

final class AXTreeSnapshotTests: XCTestCase {
    func testFullRendererPreservesContainerHierarchyAndState() {
        let snapshot = AXTreeSnapshot(
            nodes: [
                node(id: "1", depth: 0, role: "AXWindow", childCount: 1),
                node(
                    id: "2",
                    parentID: "1",
                    depth: 1,
                    role: "AXGroup",
                    focused: true,
                    expanded: false,
                    childCount: 1
                ),
                node(
                    id: "3",
                    parentID: "2",
                    depth: 2,
                    role: "AXStaticText",
                    value: "Visible body"
                ),
            ],
            visitedNodeCount: 4,
            wasTruncated: true
        )

        let rendered = AXTreeRenderer.fullText(snapshot)

        XCTAssertTrue(rendered.contains("AXTree v2 nodes=3 visited=4 truncated=true"))
        XCTAssertTrue(rendered.contains("2 AXGroup children=1 focused collapsed"))
        XCTAssertTrue(rendered.contains("3 AXStaticText value=\"Visible body\" parent=2"))
    }

    func testNodeIdentityKeepsDuplicateLabelsSeparateInDiff() throws {
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
        let rendered = try XCTUnwrap(
            AXTreeRenderer.diffText(previous: previous, current: current)
        )

        XCTAssertEqual(delta.updated.map(\.id), ["2"])
        XCTAssertTrue(rendered.contains("~   2 AXButton title=\"Opened\" parent=1"))
        XCTAssertFalse(rendered.contains("~   3 AXButton"))
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

    func testRendererTruncatesAtLineBoundary() {
        let snapshot = AXTreeSnapshot(nodes: (0..<20).map {
            node(
                id: "\($0)",
                depth: 0,
                role: "AXStaticText",
                value: String(repeating: "x", count: 30)
            )
        })

        let rendered = AXTreeRenderer.fullText(snapshot, characterLimit: 180)

        XCTAssertLessThanOrEqual(rendered.count, 180)
        XCTAssertFalse(rendered.hasSuffix("\\"))
        XCTAssertTrue(rendered.contains("AXTree v2"))
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
