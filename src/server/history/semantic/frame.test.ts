import { describe, expect, it } from "vitest";
import {
  eventForDisk,
  normalizeHistoryEvent,
  normalizeSemanticFrame,
  type AXTreeNode,
  type AXTreeSnapshot,
  type HistoryEvent,
} from "../contracts.js";
import { applyAXTreeDelta, documentOrder, extractSemanticFrame } from "./frame.js";
import { partitionAXRegions } from "./regions.js";
import { classifySurface } from "./surface.js";
import { SemanticFrameTracker } from "./tracker.js";

function node(
  overrides: Partial<AXTreeNode> & Pick<AXTreeNode, "id" | "role" | "depth">,
): AXTreeNode {
  return { siblingIndex: 0, childCount: 0, ...overrides };
}

function snapshot(nodes: AXTreeNode[]): AXTreeSnapshot {
  return { nodes, visitedNodeCount: nodes.length, wasTruncated: false };
}

function event(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-08-22T06:00:00.000Z",
    kind: "window.changed",
    captureReason: "window_focus",
    application: { bundleIdentifier: "com.apple.Safari", name: "Safari" },
    window: {
      title: "A post title",
      url: "https://blog.example.com/post",
      isPrivateBrowsing: false,
      runtimeIdentifier: 42,
    },
    ...overrides,
  };
}

/** Browser window: toolbar and sidebar noise around an article with a focused paragraph. */
const article = snapshot([
  node({ id: "window", role: "AXWindow", depth: 0, childCount: 2, title: "A post title" }),
  node({ id: "toolbar", parentID: "window", role: "AXToolbar", depth: 1, childCount: 1 }),
  node({
    id: "address",
    parentID: "toolbar",
    role: "AXTextField",
    depth: 2,
    value: "blog.example.com/post",
  }),
  node({
    id: "split",
    parentID: "window",
    role: "AXSplitGroup",
    depth: 1,
    siblingIndex: 1,
    childCount: 2,
  }),
  node({ id: "sidebar", parentID: "split", role: "AXOutline", depth: 2, childCount: 1 }),
  node({ id: "bookmark", parentID: "sidebar", role: "AXRow", depth: 3, title: "Reading list" }),
  node({
    id: "web",
    parentID: "split",
    role: "AXWebArea",
    depth: 2,
    siblingIndex: 1,
    childCount: 4,
    title: "A post title",
  }),
  node({
    id: "h1",
    parentID: "web",
    role: "AXHeading",
    depth: 3,
    value: "A post title",
    disclosureLevel: 1,
  }),
  node({
    id: "p1",
    parentID: "web",
    role: "AXStaticText",
    depth: 3,
    siblingIndex: 1,
    value: "First paragraph.",
  }),
  node({
    id: "section",
    parentID: "web",
    role: "AXGroup",
    depth: 3,
    siblingIndex: 2,
    childCount: 5,
    description: "Details",
  }),
  node({
    id: "h2",
    parentID: "section",
    role: "AXHeading",
    depth: 4,
    value: "Details",
    disclosureLevel: 2,
  }),
  node({
    id: "p2",
    parentID: "section",
    role: "AXStaticText",
    depth: 4,
    siblingIndex: 1,
    value: "Second paragraph.",
  }),
  node({
    id: "p3",
    parentID: "section",
    role: "AXStaticText",
    depth: 4,
    siblingIndex: 2,
    value: "Third paragraph, focused.",
    focused: true,
  }),
  node({
    id: "link",
    parentID: "section",
    role: "AXLink",
    depth: 4,
    siblingIndex: 3,
    title: "Related link",
  }),
  node({
    id: "p4",
    parentID: "section",
    role: "AXStaticText",
    depth: 4,
    siblingIndex: 4,
    value: "Fourth paragraph.",
  }),
  node({
    id: "share",
    parentID: "web",
    role: "AXButton",
    depth: 3,
    siblingIndex: 3,
    title: "Share",
  }),
]);

describe("surface classification", () => {
  const partition = partitionAXRegions(article);

  it("prefers the application, then the domain, then page structure", () => {
    expect(
      classifySurface({ bundleIdentifier: "com.apple.Terminal", partition: snapshotPartition() }),
    ).toBe("terminal");
    expect(classifySurface({ bundleIdentifier: "com.jetbrains.intellij", partition })).toBe(
      "editor",
    );
    expect(
      classifySurface({
        bundleIdentifier: "com.apple.Safari",
        url: "https://mail.google.com/mail/u/0/#inbox",
        partition,
      }),
    ).toBe("mail");
    expect(
      classifySurface({
        bundleIdentifier: "com.google.Chrome",
        url: "https://app.slack.com/client/T1/C1",
        partition,
      }),
    ).toBe("chat");
    expect(
      classifySurface({
        bundleIdentifier: "com.apple.Safari",
        url: "https://blog.example.com/post",
        partition,
      }),
    ).toBe("web_article");
    expect(
      classifySurface({
        bundleIdentifier: "com.apple.Safari",
        url: "https://example.com/settings",
        partition: snapshotPartition(),
      }),
    ).toBe("web_app");
  });

  it("falls back to structure for native windows", () => {
    expect(classifySurface({ bundleIdentifier: "com.example.app", partition })).toBe("unknown");
    expect(
      classifySurface({
        bundleIdentifier: "com.example.app",
        url: "file:///Users/me/notes.txt",
        partition: partitionAXRegions(
          snapshot([
            node({ id: "w", role: "AXWindow", depth: 0, childCount: 1 }),
            node({ id: "t", parentID: "w", role: "AXTextArea", depth: 1, value: "Notes" }),
          ]),
        ),
      }),
    ).toBe("document");
    expect(
      classifySurface({
        bundleIdentifier: "com.example.app",
        partition: partitionAXRegions(
          snapshot([
            node({ id: "w", role: "AXWindow", depth: 0, childCount: 1 }),
            node({ id: "table", parentID: "w", role: "AXTable", depth: 1, childCount: 2 }),
            node({ id: "r1", parentID: "table", role: "AXRow", depth: 2, childCount: 1 }),
            node({ id: "c1", parentID: "r1", role: "AXCell", depth: 3, value: "1" }),
          ]),
        ),
      }),
    ).toBe("table");
  });

  function snapshotPartition() {
    return partitionAXRegions(
      snapshot([node({ id: "w", role: "AXWindow", depth: 0, title: "Settings" })]),
    );
  }
});

describe("semantic frame extraction", () => {
  const frame = extractSemanticFrame({
    bundleIdentifier: "com.apple.Safari",
    windowTitle: "A post title",
    url: "https://blog.example.com/post",
    snapshot: article,
  });

  it("answers what, where, and what the user touches from the content region only", () => {
    expect(frame.version).toBe(1);
    expect(frame.surface).toBe("web_article");
    expect(frame.identity).toEqual({
      title: "A post title",
      url: "https://blog.example.com/post",
      domain: "blog.example.com",
    });
    expect(frame.outline).toEqual([
      { level: 1, text: "A post title" },
      { level: 2, text: "Details" },
    ]);
    expect(frame.body.split("\n")).toEqual([
      "A post title",
      "A post title",
      "First paragraph.",
      "Details",
      "Details",
      "Second paragraph.",
      "Third paragraph, focused.",
      "Related link",
      "Fourth paragraph.",
    ]);
    expect(frame.body).not.toContain("Reading list");
    expect(frame.body).not.toContain("blog.example.com/post");
    expect(frame.body).not.toContain("Share");
    expect(frame.bodyTruncated).toBe(false);
    expect(frame.focus).toEqual({
      role: "AXStaticText",
      text: "Third paragraph, focused.",
      path: ["A post title", "A post title", "Details"],
    });
    expect(frame.recent.at(-1)).toBe("Fourth paragraph.");
    expect(frame.regions.chrome).toBe("blog.example.com/post".length);
    expect(frame.regions.navigation).toBe("Reading list".length);
    expect(frame.regions.content).toBeGreaterThan(frame.regions.chrome);
  });

  it("keeps the tail of a terminal buffer and marks truncation", () => {
    const buffer = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const terminal = extractSemanticFrame({
      bundleIdentifier: "com.apple.Terminal",
      windowTitle: "zsh",
      snapshot: snapshot([
        node({ id: "w", role: "AXWindow", depth: 0, childCount: 1, title: "zsh" }),
        node({ id: "t", parentID: "w", role: "AXTextArea", depth: 1, value: buffer }),
      ]),
      limits: {
        bodyCharacters: 60,
        outlineEntries: 24,
        outlineCharacters: 160,
        recentEntries: 3,
        recentCharacters: 200,
        focusCharacters: 500,
        focusPathDepth: 6,
      },
    });

    expect(terminal.surface).toBe("terminal");
    expect(terminal.bodyTruncated).toBe(true);
    expect(terminal.body.split("\n").at(-1)).toBe("line 40");
    expect(terminal.body).not.toContain("line 1\n");
    expect(terminal.recent).toEqual(["line 38", "line 39", "line 40"]);
  });

  it("prefers the deepest focused element over its focused containers", () => {
    const terminal = extractSemanticFrame({
      bundleIdentifier: "com.apple.Terminal",
      windowTitle: "zsh",
      snapshot: snapshot([
        node({ id: "w", role: "AXWindow", depth: 0, childCount: 1, title: "zsh" }),
        node({ id: "scroll", parentID: "w", role: "AXScrollArea", depth: 1, focused: true }),
        node({
          id: "text",
          parentID: "scroll",
          role: "AXTextArea",
          depth: 2,
          value: "$ pnpm test",
          focused: true,
        }),
      ]),
    });

    expect(terminal.focus).toEqual({ role: "AXTextArea", text: "$ pnpm test", path: ["zsh"] });
  });

  it("resolves a file URL into a path", () => {
    const local = extractSemanticFrame({
      bundleIdentifier: "com.apple.TextEdit",
      url: "file:///Users/me/My%20Notes.txt",
      snapshot: snapshot([node({ id: "w", role: "AXWindow", depth: 0 })]),
    });
    expect(local.identity).toEqual({
      url: "file:///Users/me/My%20Notes.txt",
      path: "/Users/me/My Notes.txt",
    });
    expect(local.surface).toBe("document");
  });
});

describe("delta replay and document order", () => {
  it("orders siblings by index and trails unreachable nodes", () => {
    const ordered = documentOrder(
      snapshot([
        node({ id: "b", parentID: "root", role: "AXGroup", depth: 1, siblingIndex: 1 }),
        node({ id: "root", role: "AXWindow", depth: 0 }),
        node({ id: "a", parentID: "root", role: "AXGroup", depth: 1, siblingIndex: 0 }),
        node({ id: "lost", parentID: "gone", role: "AXGroup", depth: 3 }),
      ]),
    );
    expect(ordered.map((item) => item.id)).toEqual(["root", "a", "b", "lost"]);
  });

  it("applies added, removed, updated, and moved nodes", () => {
    const next = applyAXTreeDelta(article, {
      added: [
        node({ id: "p5", parentID: "section", role: "AXStaticText", depth: 4, value: "Fifth" }),
      ],
      removed: [node({ id: "p1", parentID: "web", role: "AXStaticText", depth: 3 })],
      updated: [
        node({
          id: "h1",
          parentID: "web",
          role: "AXHeading",
          depth: 3,
          value: "Updated title",
          disclosureLevel: 1,
        }),
      ],
      moved: [
        node({ id: "link", parentID: "web", role: "AXLink", depth: 3, title: "Related link" }),
      ],
    });
    const byID = new Map(next.nodes.map((item) => [item.id, item]));

    expect(byID.has("p1")).toBe(false);
    expect(byID.get("p5")?.value).toBe("Fifth");
    expect(byID.get("h1")?.value).toBe("Updated title");
    expect(byID.get("link")?.parentID).toBe("web");
    expect(next.visitedNodeCount).toBe(article.nodes.length);
  });
});

describe("semantic frame tracker", () => {
  const delta = {
    added: [
      node({
        id: "p5",
        parentID: "section",
        role: "AXStaticText",
        depth: 4,
        siblingIndex: 5,
        value: "Fifth",
      }),
    ],
    removed: [],
    updated: [],
    moved: [],
  };

  it("frames full snapshots and replays deltas on the same window stream", () => {
    const tracker = new SemanticFrameTracker();
    const full = tracker.process(
      normalizeHistoryEvent({ ...event(), accessibility: { mode: "fullTree", tree: article } }),
    );
    expect(full.semantic?.surface).toBe("web_article");
    expect(full.semantic?.body).not.toContain("Fifth");

    const incremental = tracker.process(
      normalizeHistoryEvent({
        ...event({ id: "00000000-0000-4000-8000-000000000002" }),
        accessibility: { mode: "diffFromPrevious", delta },
      }),
    );
    expect(incremental.semantic?.body).toContain("Fifth");
    expect(incremental.semantic?.recent.at(-1)).toBe("Fifth");

    const otherWindow = tracker.process(
      normalizeHistoryEvent({
        ...event({
          id: "00000000-0000-4000-8000-000000000003",
          window: { title: "Other", isPrivateBrowsing: false, runtimeIdentifier: 99 },
        }),
        accessibility: { mode: "diffFromPrevious", delta },
      }),
    );
    expect(otherWindow.semantic).toBeUndefined();

    tracker.reset();
    const afterReset = tracker.process(
      normalizeHistoryEvent({
        ...event({ id: "00000000-0000-4000-8000-000000000004" }),
        accessibility: { mode: "diffFromPrevious", delta },
      }),
    );
    expect(afterReset.semantic).toBeUndefined();
    expect(tracker.process(event()).semantic).toBeUndefined();
  });

  it("round-trips frames through disk and drops malformed ones", () => {
    const framed = new SemanticFrameTracker().process(
      normalizeHistoryEvent({ ...event(), accessibility: { mode: "fullTree", tree: article } }),
    );
    const reloaded = normalizeHistoryEvent(JSON.parse(JSON.stringify(eventForDisk(framed))));
    expect(reloaded.semantic).toEqual(framed.semantic);

    expect(normalizeSemanticFrame(undefined)).toBeUndefined();
    expect(normalizeSemanticFrame({ version: 2, surface: "chat" })).toBeUndefined();
    expect(normalizeSemanticFrame({ version: 1, surface: "hologram" })).toBeUndefined();
    expect(normalizeSemanticFrame({ version: 1, surface: "chat" })).toEqual({
      version: 1,
      surface: "chat",
      identity: {},
      outline: [],
      body: "",
      bodyTruncated: false,
      focus: undefined,
      recent: [],
      regions: { content: 0, navigation: 0, chrome: 0 },
    });
  });
});
