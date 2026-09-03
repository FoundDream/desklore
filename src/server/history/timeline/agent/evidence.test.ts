import { describe, expect, it } from "vitest";
import {
  normalizeHistoryEvent,
  type AXTreeNode,
  type AXTreeSnapshot,
  type HistoryEvent,
} from "../../contracts.js";
import { SemanticFrameTracker } from "../../semantic/tracker.js";
import { EvidenceSession } from "./runner.js";

function node(
  overrides: Partial<AXTreeNode> & Pick<AXTreeNode, "id" | "role" | "depth">,
): AXTreeNode {
  return { siblingIndex: 0, childCount: 0, ...overrides };
}

const tree: AXTreeSnapshot = {
  nodes: [
    node({ id: "w", role: "AXWindow", depth: 0, childCount: 2, title: "Release notes" }),
    node({ id: "bar", parentID: "w", role: "AXToolbar", depth: 1, childCount: 1 }),
    node({ id: "btn", parentID: "bar", role: "AXButton", depth: 2, title: "Reload" }),
    node({
      id: "web",
      parentID: "w",
      role: "AXWebArea",
      depth: 1,
      siblingIndex: 1,
      childCount: 3,
    }),
    node({ id: "h", parentID: "web", role: "AXHeading", depth: 2, value: "Release notes" }),
    node({
      id: "p",
      parentID: "web",
      role: "AXStaticText",
      depth: 2,
      siblingIndex: 1,
      value: "Build complete. Tests passed.",
      focused: true,
    }),
    node({
      id: "q",
      parentID: "web",
      role: "AXStaticText",
      depth: 2,
      siblingIndex: 2,
      value: "Shipping tomorrow.",
    }),
  ],
  visitedNodeCount: 7,
  wasTruncated: false,
};

function baseEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    timestamp: "2026-08-22T06:00:00.000Z",
    kind: "window.changed",
    captureReason: "window_focus",
    application: { bundleIdentifier: "com.apple.Safari", name: "Safari" },
    window: {
      title: "Release notes",
      url: "https://example.com/releases",
      isPrivateBrowsing: false,
      runtimeIdentifier: 3,
    },
    ...overrides,
  };
}

const framed = new SemanticFrameTracker().process(
  normalizeHistoryEvent({ ...baseEvent(), accessibility: { mode: "fullTree", tree } }),
);
const legacy = baseEvent({
  id: "00000000-0000-4000-8000-000000000011",
  timestamp: "2026-08-22T06:01:00.000Z",
  accessibility: { mode: "fullTree", text: 'AXTree v2 nodes=1\nx AXStaticText value="legacy"' },
});

function readEvents(
  session: EvidenceSession,
  eventIDs: string[],
  includeAccessibility: boolean,
  includeRawAccessibility = false,
): HistoryEvent[] {
  const result = session.inspect([
    {
      kind: "events",
      startedAt: "",
      endedAt: "",
      query: "",
      eventIDs,
      bundleIdentifiers: [],
      eventKinds: [],
      offset: 0,
      limit: eventIDs.length,
      includeAccessibility,
      includeRawAccessibility,
    },
  ]) as { results: Array<{ events: HistoryEvent[] }> };
  return result.results[0]!.events;
}

describe("evidence views", () => {
  const session = new EvidenceSession([framed, legacy]);

  it("returns a semantic summary by default and never the rendered tree", () => {
    const [event] = readEvents(session, [framed.id], false);

    expect(event?.accessibility).toBeUndefined();
    expect(event?.semantic).toMatchObject({
      surface: "web_app",
      identity: { title: "Release notes", domain: "example.com" },
      outline: [{ level: 1, text: "Release notes" }],
      body: "",
      bodyTruncated: true,
      focus: { role: "AXStaticText", text: "Build complete. Tests passed." },
      recent: ["Release notes", "Build complete. Tests passed.", "Shipping tomorrow."],
    });
  });

  it("adds the full content body on request, still without the rendered tree", () => {
    const [event] = readEvents(session, [framed.id], true);

    expect(event?.accessibility).toBeUndefined();
    expect(event?.semantic?.body.split("\n")).toEqual([
      "Release notes",
      "Build complete. Tests passed.",
      "Shipping tomorrow.",
    ]);
    expect(event?.semantic?.body).not.toContain("Reload");
    expect(event?.semantic?.bodyTruncated).toBe(false);
  });

  it("exposes the rendered tree only through the explicit raw flag", () => {
    const [event] = readEvents(session, [framed.id], false, true);

    expect(event?.accessibility?.text).toContain('btn AXButton title="Reload"');
    expect(event?.accessibility?.tree).toBeUndefined();
    expect(event?.semantic?.body).toBe("");
  });

  it("falls back to rendered text for events without a frame", () => {
    expect(readEvents(session, [legacy.id], false)[0]?.accessibility).toBeUndefined();
    expect(readEvents(session, [legacy.id], true)[0]?.accessibility?.text).toContain("legacy");
  });

  it("searches semantic content instead of window chrome", () => {
    const search = (query: string) =>
      (
        session.inspect([
          {
            kind: "search",
            startedAt: "",
            endedAt: "",
            query,
            eventIDs: [],
            bundleIdentifiers: [],
            eventKinds: [],
            offset: 0,
            limit: 10,
            includeAccessibility: false,
            includeRawAccessibility: false,
          },
        ]) as { results: Array<{ events: HistoryEvent[] }> }
      ).results[0]!.events.map((event) => event.id);

    expect(search("tests passed")).toEqual([framed.id]);
    expect(search("reload")).toEqual([]);
    expect(search("legacy")).toEqual([legacy.id]);
  });

  it("counts frames and surfaces in the overview", () => {
    expect(session.overview()).toMatchObject({
      semanticFrameEvents: 1,
      surfaces: [{ value: "web_app", count: 1 }],
    });
  });
});
