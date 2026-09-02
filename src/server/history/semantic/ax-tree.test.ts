import { describe, expect, it } from "vitest";
import {
  eventForDisk,
  normalizeHistoryEvent,
  type AXTreeNode,
  type AXTreeSnapshot,
  type HistoryEvent,
} from "../contracts.js";
import { EventBurstCoalescer } from "../events/coalescer.js";
import { sanitizeEvent } from "../policy/policy.js";
import {
  accessibilityContextForDisk,
  mergeAXTreeDeltas,
  normalizeAccessibilityContext,
  renderAXTreeDeltaText,
  renderAXTreeText,
  withSanitizedAccessibilityTree,
} from "./ax-tree.js";

function node(
  overrides: Partial<AXTreeNode> & Pick<AXTreeNode, "id" | "role" | "depth">,
): AXTreeNode {
  return { siblingIndex: 0, childCount: 0, ...overrides };
}

function event(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-08-22T06:00:00.000Z",
    kind: "window.changed",
    captureReason: "window_focus",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
    window: { title: "Example", isPrivateBrowsing: false, runtimeIdentifier: 42 },
    ...overrides,
  };
}

const bodyTree: AXTreeSnapshot = {
  nodes: [
    node({ id: "1", depth: 0, role: "AXWindow", childCount: 1 }),
    node({
      id: "2",
      parentID: "1",
      depth: 1,
      role: "AXGroup",
      focused: true,
      expanded: false,
      childCount: 1,
    }),
    node({ id: "3", parentID: "2", depth: 2, role: "AXStaticText", value: "Visible body" }),
  ],
  visitedNodeCount: 4,
  wasTruncated: true,
};

describe("AX tree rendering", () => {
  it("renders a full tree with hierarchy and state", () => {
    const rendered = renderAXTreeText(bodyTree);

    expect(rendered).toContain("AXTree v2 nodes=3 visited=4 truncated=true");
    expect(rendered).toContain("2 AXGroup children=1 focused collapsed");
    expect(rendered).toContain('3 AXStaticText value="Visible body" parent=2');
  });

  it("renders a delta with node identity instead of labels", () => {
    const rendered = renderAXTreeDeltaText({
      added: [node({ id: "5", parentID: "2", depth: 2, role: "AXLink" })],
      removed: [node({ id: "4", parentID: "1", depth: 1, role: "AXStaticText" })],
      updated: [node({ id: "2", parentID: "1", depth: 1, role: "AXButton", title: "Opened" })],
      moved: [],
    });

    expect(rendered).toContain("AXTreeDiff v2 added=1 removed=1 updated=1 moved=0");
    expect(rendered).toContain("- 4 AXStaticText parent=1");
    expect(rendered).toContain("+     5 AXLink parent=2");
    expect(rendered).toContain('~   2 AXButton title="Opened" parent=1');
    expect(rendered).not.toContain("~   3 AXButton");
  });

  it("escapes quoted values and truncates at a line boundary", () => {
    const quoted = renderAXTreeText({
      nodes: [node({ id: "1", depth: 0, role: "AXStaticText", value: 'say "hi"\nnow' })],
      visitedNodeCount: 1,
      wasTruncated: false,
    });
    expect(quoted).toContain('value="say \\"hi\\"\\nnow"');

    const rendered = renderAXTreeText(
      {
        nodes: Array.from({ length: 20 }, (_, index) =>
          node({ id: `${index}`, depth: 0, role: "AXStaticText", value: "x".repeat(30) }),
        ),
        visitedNodeCount: 20,
        wasTruncated: false,
      },
      180,
    );
    expect(rendered.length).toBeLessThanOrEqual(180);
    expect(rendered).toContain("AXTree v2");
    expect(rendered).toContain("truncated");
    expect(rendered.endsWith("\\")).toBe(false);
  });
});

describe("accessibility context normalization", () => {
  it("derives text from structured wire payloads and keeps the nodes", () => {
    const normalized = normalizeAccessibilityContext({
      mode: "fullTree",
      tree: {
        nodes: [
          { id: "1", role: "AXWindow", depth: 0, siblingIndex: 0, childCount: 1 },
          { id: "2", role: "AXStaticText", depth: 1, parentID: "1", value: "Hello" },
          { role: "AXButton" },
          "garbage",
        ],
        visitedNodeCount: 2,
        wasTruncated: false,
      },
    });

    expect(normalized.mode).toBe("fullTree");
    expect(normalized.tree?.nodes.map((item) => item.id)).toEqual(["1", "2"]);
    expect(normalized.tree?.nodes[1]).toEqual({
      id: "2",
      role: "AXStaticText",
      depth: 1,
      siblingIndex: 0,
      childCount: 0,
      parentID: "1",
      value: "Hello",
    });
    expect(normalized.text).toContain("AXTree v2 nodes=2 visited=2 truncated=false");
    expect(normalized.text).toContain('2 AXStaticText value="Hello" parent=1');
  });

  it("still accepts legacy text-only contexts and rejects malformed ones", () => {
    expect(normalizeAccessibilityContext({ mode: "diffFromPrevious", text: "legacy" })).toEqual({
      mode: "diffFromPrevious",
      text: "legacy",
    });
    expect(() => normalizeAccessibilityContext({ mode: "other", text: "x" })).toThrow();
    expect(() => normalizeAccessibilityContext({ mode: "fullTree" })).toThrow();
    expect(() => normalizeAccessibilityContext({ mode: "fullTree", tree: "bad" })).toThrow();
    expect(() =>
      normalizeAccessibilityContext({ mode: "diffFromPrevious", delta: { added: [] } }),
    ).toThrow();
  });

  it("stores nodes without rendered text and re-derives identical text on load", () => {
    const input = normalizeHistoryEvent({
      ...event(),
      accessibility: { mode: "fullTree", tree: bodyTree },
    });
    const stored = eventForDisk(input);
    const storedAccessibility = stored.accessibility as Record<string, unknown>;

    expect(storedAccessibility.text).toBeUndefined();
    expect(storedAccessibility.tree).toEqual(bodyTree);
    expect(accessibilityContextForDisk({ mode: "fullTree", text: "legacy" })).toEqual({
      mode: "fullTree",
      text: "legacy",
    });

    const reloaded = normalizeHistoryEvent(JSON.parse(JSON.stringify(stored)));
    expect(reloaded.accessibility).toEqual(input.accessibility);
    expect(reloaded.accessibility?.text).toBe(renderAXTreeText(bodyTree));
  });

  it("keeps a full snapshot and applies later deltas when bursts coalesce", () => {
    const bursts = new EventBurstCoalescer();
    const delta = {
      added: [node({ id: "9", parentID: "1", depth: 1, role: "AXStaticText", value: "New" })],
      removed: [],
      updated: [],
      moved: [],
    };
    const activation = normalizeHistoryEvent({
      ...event({ captureReason: "application_activation" }),
      accessibility: { mode: "fullTree", tree: bodyTree },
    });
    const focus = normalizeHistoryEvent({
      ...event({
        id: "00000000-0000-4000-8000-000000000002",
        timestamp: "2026-08-22T06:00:00.200Z",
        captureReason: "window_focus",
      }),
      accessibility: { mode: "diffFromPrevious", delta },
    });

    expect(bursts.ingest(activation)).toEqual({ ready: [], coalescedCount: 0 });
    expect(bursts.ingest(focus)).toEqual({ ready: [], coalescedCount: 1 });
    const merged = bursts.flushAll()[0]?.accessibility;

    expect(merged?.mode).toBe("fullTree");
    expect(merged?.tree).toEqual(bodyTree);
    expect(merged?.delta).toEqual(delta);
    expect(merged?.text).toBe(`${renderAXTreeText(bodyTree)}\n${renderAXTreeDeltaText(delta)}`);
  });

  it("merges deltas in order", () => {
    const first = {
      added: [node({ id: "a", depth: 1, role: "AXLink" })],
      removed: [],
      updated: [],
      moved: [],
    };
    const second = {
      added: [],
      removed: [node({ id: "b", depth: 1, role: "AXLink" })],
      updated: [node({ id: "a", depth: 1, role: "AXLink", title: "Changed" })],
      moved: [],
    };
    expect(mergeAXTreeDeltas(undefined, second)).toBe(second);
    expect(mergeAXTreeDeltas(first, undefined)).toBe(first);
    expect(mergeAXTreeDeltas(first, second)).toEqual({
      added: first.added,
      removed: second.removed,
      updated: second.updated,
      moved: [],
    });
  });
});

describe("accessibility sanitization", () => {
  const secretTree: AXTreeSnapshot = {
    nodes: [
      node({ id: "1", depth: 0, role: "AXWindow", childCount: 1 }),
      node({
        id: "2",
        parentID: "1",
        depth: 1,
        role: "AXStaticText",
        value: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
      }),
    ],
    visitedNodeCount: 2,
    wasTruncated: false,
  };

  it("hands model-facing consumers rendered text only", () => {
    const input = normalizeHistoryEvent({
      ...event(),
      accessibility: { mode: "fullTree", tree: secretTree },
    });

    const presented = sanitizeEvent(input);

    expect(presented.accessibility?.tree).toBeUndefined();
    expect(presented.accessibility?.delta).toBeUndefined();
    expect(presented.accessibility?.text).toContain("[REDACTED]");
    expect(presented.accessibility?.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts inside retained nodes for persistence and keeps text in sync", () => {
    const input = normalizeHistoryEvent({
      ...event(),
      accessibility: { mode: "fullTree", tree: secretTree },
    });

    const retained = withSanitizedAccessibilityTree(sanitizeEvent(input), input);

    expect(retained.accessibility?.tree?.nodes[1]?.value).toContain("[REDACTED]");
    expect(retained.accessibility?.tree?.nodes[1]?.value).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
    expect(retained.accessibility?.text).toBe(renderAXTreeText(retained.accessibility!.tree!));
    expect(JSON.stringify(retained)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(withSanitizedAccessibilityTree(sanitizeEvent(event()), event())).toEqual(
      sanitizeEvent(event()),
    );
  });
});
