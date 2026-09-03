import { describe, expect, it } from "vitest";
import type { AXTreeNode, AXTreeSnapshot } from "../contracts.js";
import {
  genericRegionRules,
  partitionAXRegions,
  regionRulesFor,
  registerRegionRules,
  summarizeAXRegions,
} from "./regions.js";

function node(
  overrides: Partial<AXTreeNode> & Pick<AXTreeNode, "id" | "role" | "depth">,
): AXTreeNode {
  return { siblingIndex: 0, childCount: 0, ...overrides };
}

function snapshot(nodes: AXTreeNode[]): AXTreeSnapshot {
  return { nodes, visitedNodeCount: nodes.length, wasTruncated: false };
}

/** A browser-like window: toolbar, tab strip, bookmarks sidebar, and a web page. */
const browserWindow = snapshot([
  node({ id: "window", role: "AXWindow", depth: 0, childCount: 3 }),
  node({ id: "toolbar", parentID: "window", role: "AXToolbar", depth: 1, childCount: 2 }),
  node({ id: "back", parentID: "toolbar", role: "AXButton", depth: 2, title: "Back" }),
  node({
    id: "address",
    parentID: "toolbar",
    role: "AXTextField",
    depth: 2,
    value: "https://example.com/post",
  }),
  node({ id: "tabs", parentID: "window", role: "AXTabGroup", depth: 1, childCount: 1 }),
  node({
    id: "tab",
    parentID: "tabs",
    role: "AXRadioButton",
    subrole: "AXTabButton",
    depth: 2,
    title: "Example post",
  }),
  node({ id: "split", parentID: "window", role: "AXSplitGroup", depth: 1, childCount: 2 }),
  node({ id: "sidebar", parentID: "split", role: "AXOutline", depth: 2, childCount: 1 }),
  node({ id: "bookmark", parentID: "sidebar", role: "AXRow", depth: 3, title: "Reading list" }),
  node({ id: "web", parentID: "split", role: "AXWebArea", depth: 2, childCount: 2 }),
  node({ id: "heading", parentID: "web", role: "AXHeading", depth: 3, value: "A post title" }),
  node({ id: "list", parentID: "web", role: "AXList", depth: 3, childCount: 1 }),
  node({ id: "item", parentID: "list", role: "AXStaticText", depth: 4, value: "First point" }),
]);

describe("AX region partition", () => {
  it("splits a browser window into chrome, navigation, and content", () => {
    const partition = partitionAXRegions(browserWindow);

    expect(partition.chrome.map((item) => item.id)).toEqual([
      "toolbar",
      "back",
      "address",
      "tabs",
      "tab",
    ]);
    expect(partition.navigation.map((item) => item.id)).toEqual(["sidebar", "bookmark"]);
    expect(partition.content.map((item) => item.id)).toEqual([
      "window",
      "split",
      "web",
      "heading",
      "list",
      "item",
    ]);
  });

  it("lets content markers win over surrounding navigation and lists inside content stay content", () => {
    const partition = partitionAXRegions(browserWindow);

    expect(partition.kinds.get("list")).toBe("content");
    expect(partition.kinds.get("item")).toBe("content");
    expect(partition.kinds.get("bookmark")).toBe("navigation");
    expect(partition.kinds.get("tab")).toBe("chrome");
  });

  it("reports the nodes where each region starts", () => {
    const partition = partitionAXRegions(browserWindow);

    expect(partition.roots.chrome.map((item) => item.id)).toEqual(["toolbar", "tabs"]);
    expect(partition.roots.navigation.map((item) => item.id)).toEqual(["sidebar"]);
    expect(partition.roots.content.map((item) => item.id)).toEqual(["window", "web"]);
  });

  it("treats unclassified native text as content and keeps markers inside chrome as chrome", () => {
    const partition = partitionAXRegions(
      snapshot([
        node({ id: "window", role: "AXWindow", depth: 0, childCount: 2 }),
        node({ id: "group", parentID: "window", role: "AXGroup", depth: 1, childCount: 1 }),
        node({ id: "body", parentID: "group", role: "AXStaticText", depth: 2, value: "Note" }),
        node({ id: "toolbar", parentID: "window", role: "AXToolbar", depth: 1, childCount: 1 }),
        node({ id: "picker", parentID: "toolbar", role: "AXList", depth: 2, childCount: 1 }),
        node({ id: "choice", parentID: "picker", role: "AXStaticText", depth: 3, value: "Bold" }),
      ]),
    );

    expect(partition.kinds.get("body")).toBe("content");
    expect(partition.kinds.get("picker")).toBe("chrome");
    expect(partition.kinds.get("choice")).toBe("chrome");
  });

  it("survives orphaned parents and reference cycles", () => {
    const partition = partitionAXRegions(
      snapshot([
        node({ id: "a", parentID: "b", role: "AXGroup", depth: 1 }),
        node({ id: "b", parentID: "a", role: "AXOutline", depth: 1 }),
        node({ id: "c", parentID: "missing", role: "AXStaticText", depth: 5, value: "Lost" }),
      ]),
    );

    expect(partition.kinds.get("a")).toBe("navigation");
    expect(partition.kinds.get("b")).toBe("navigation");
    expect(partition.kinds.get("c")).toBe("content");
    expect(partition.roots.content.map((item) => item.id)).toEqual(["c"]);
  });

  it("summarizes text volume per region", () => {
    const summary = summarizeAXRegions(partitionAXRegions(browserWindow));

    expect(summary.nodes).toEqual({ content: 6, navigation: 2, chrome: 5 });
    expect(summary.textNodes).toEqual({ content: 2, navigation: 1, chrome: 3 });
    expect(summary.textCharacters.content).toBe("A post title".length + "First point".length);
  });

  it("applies per-application rule overrides on top of the generic rules", () => {
    expect(regionRulesFor(undefined)).toBe(genericRegionRules);
    expect(regionRulesFor("com.example.unknown")).toBe(genericRegionRules);

    registerRegionRules("com.example.notes", {
      navigationRoles: new Set(["AXOutline"]),
    });
    const rules = regionRulesFor("com.example.notes");
    expect(rules.chromeRoles).toBe(genericRegionRules.chromeRoles);

    const partition = partitionAXRegions(
      snapshot([
        node({ id: "window", role: "AXWindow", depth: 0, childCount: 1 }),
        node({ id: "table", parentID: "window", role: "AXTable", depth: 1, childCount: 1 }),
        node({ id: "cell", parentID: "table", role: "AXCell", depth: 2, value: "Cell" }),
      ]),
      rules,
    );
    expect(partition.kinds.get("cell")).toBe("content");
  });
});
