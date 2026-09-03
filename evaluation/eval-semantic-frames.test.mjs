import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  compareWithBaseline,
  evaluateSemanticFrames,
  renderMarkdown,
  writeReport,
} from "./eval-semantic-frames.mjs";

const jiti = createJiti(import.meta.url);
const { SemanticFrameTracker } = await jiti.import("../src/server/history/semantic/tracker.ts");
const { normalizeHistoryEvent } = await jiti.import("../src/server/history/contracts.ts");

const startedAt = "2026-08-22T12:00:00.000Z";
const privateText = "PRIVATE_FRAME_SOURCE_TEXT";

function node(overrides) {
  return { siblingIndex: 0, childCount: 0, ...overrides };
}

const tree = {
  nodes: [
    node({ id: "w", role: "AXWindow", depth: 0, childCount: 2, title: "Post" }),
    node({ id: "bar", parentID: "w", role: "AXToolbar", depth: 1, childCount: 1 }),
    node({ id: "btn", parentID: "bar", role: "AXButton", depth: 2, title: "Reload" }),
    node({ id: "web", parentID: "w", role: "AXWebArea", depth: 1, siblingIndex: 1, childCount: 2 }),
    node({ id: "h", parentID: "web", role: "AXHeading", depth: 2, value: "Post" }),
    node({
      id: "p",
      parentID: "web",
      role: "AXStaticText",
      depth: 2,
      siblingIndex: 1,
      value: privateText,
      focused: true,
    }),
  ],
  visitedNodeCount: 6,
  wasTruncated: false,
};

function event(id, offsetSeconds, overrides = {}) {
  return {
    id,
    timestamp: new Date(Date.parse(startedAt) + offsetSeconds * 1_000).toISOString(),
    kind: "window.changed",
    captureReason: "window_focus",
    application: { bundleIdentifier: "com.apple.Safari", name: "Safari" },
    window: {
      title: "Post",
      url: "https://example.com/post",
      isPrivateBrowsing: false,
      runtimeIdentifier: 5,
    },
    ...overrides,
  };
}

async function writeHistoryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-semantic-frames-"));
  const segmentID = "2026-08-22T12-00-00-000Z";
  const directory = path.join(root, "segments", segmentID);
  await mkdir(directory, { recursive: true });

  const stored = new SemanticFrameTracker().process(
    normalizeHistoryEvent(
      event("00000000-0000-4000-8000-000000000001", 1, {
        accessibility: { mode: "fullTree", tree },
      }),
    ),
  );
  const rows = [
    // Full tree with a stored frame that matches replay.
    {
      ...event("00000000-0000-4000-8000-000000000001", 1),
      accessibility: { mode: "fullTree", tree },
      semantic: stored.semantic,
    },
    // Delta on the same window stream, no stored frame.
    {
      ...event("00000000-0000-4000-8000-000000000002", 2),
      accessibility: {
        mode: "diffFromPrevious",
        delta: {
          added: [
            node({
              id: "q",
              parentID: "web",
              role: "AXStaticText",
              depth: 2,
              siblingIndex: 2,
              value: "More",
            }),
          ],
          removed: [],
          updated: [],
          moved: [],
        },
      },
    },
    // Delta on an unknown window stream: cannot be framed.
    {
      ...event("00000000-0000-4000-8000-000000000003", 3, {
        window: { title: "Other", isPrivateBrowsing: false, runtimeIdentifier: 9 },
      }),
      accessibility: {
        mode: "diffFromPrevious",
        delta: { added: [], removed: [], updated: [], moved: [] },
      },
    },
    // Legacy text-only context from an earlier build.
    {
      ...event("00000000-0000-4000-8000-000000000004", 4, {
        application: { bundleIdentifier: "com.apple.Terminal", name: "Terminal" },
      }),
      accessibility: { mode: "fullTree", text: "AXTree v2 nodes=0" },
    },
    // No Accessibility context at all.
    event("00000000-0000-4000-8000-000000000005", 5, { kind: "mouse.click" }),
  ];
  await writeFile(
    path.join(directory, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: segmentID,
      startedAt,
      endedAt: "2026-08-22T12:10:00.000Z",
      eventCount: rows.length,
      suppressedEventCount: 0,
      capturedEventCount: rows.length,
      policyBlockedEventCount: 0,
      deduplicatedEventCount: 0,
      burstCoalescedEventCount: 0,
      eventsFile: "events.jsonl",
    }),
  );
  await writeFile(
    path.join(directory, "events.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\nnot json\n`,
  );
  const open = path.join(root, "segments", "2026-08-22T12-10-00-000Z");
  await mkdir(open, { recursive: true });
  await writeFile(
    path.join(open, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "2026-08-22T12-10-00-000Z",
      startedAt: "2026-08-22T12:10:00.000Z",
      eventCount: 0,
      suppressedEventCount: 0,
      capturedEventCount: 0,
      policyBlockedEventCount: 0,
      deduplicatedEventCount: 0,
      burstCoalescedEventCount: 0,
      eventsFile: "events.jsonl",
    }),
  );
  return root;
}

void test("replays segments and reports coverage, volume, and stored-frame agreement", async () => {
  const root = await writeHistoryRoot();
  try {
    const report = await evaluateSemanticFrames({ root });

    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.input.segmentIDs, ["2026-08-22T12-00-00-000Z"]);
    assert.equal(report.input.quality.openSegmentsSkipped, 1);
    assert.equal(report.input.quality.malformedLines, 1);

    const totals = report.totals;
    assert.equal(totals.events, 5);
    assert.equal(totals.withAccessibility, 4);
    assert.equal(totals.structured, 3);
    assert.equal(totals.legacyText, 1);
    assert.equal(totals.framed, 2);
    assert.equal(totals.unframedDeltas, 1);
    assert.equal(totals.identityCoverage, 1);
    assert.equal(totals.contentCoverage, 1);
    assert.equal(totals.focusCoverage, 1);
    assert.ok(totals.meanContentShare > 0.5);
    assert.deepEqual(totals.stored, { matches: 1, differs: 0, missing: 1 });
    assert.ok(totals.renderedTextBytes > 0);
    assert.ok(totals.summaryBytes < totals.frameBytes);
    assert.deepEqual(totals.surfaces, [{ value: "web_app", count: 2 }]);

    const safari = report.applications.find((item) => item.bundleIdentifier === "com.apple.Safari");
    assert.equal(safari.events, 4);
    assert.equal(safari.framed, 2);
    const terminal = report.applications.find(
      (item) => item.bundleIdentifier === "com.apple.Terminal",
    );
    assert.equal(terminal.legacyText, 1);
    assert.equal(terminal.identityCoverage, null);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(privateText), false);
    assert.equal(renderMarkdown(report).includes(privateText), false);
    assert.match(renderMarkdown(report), /Safari \(com.apple.Safari\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("compares against a baseline and flags per-application coverage regressions", async () => {
  const root = await writeHistoryRoot();
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "computer-history-semantic-report-"));
  try {
    const current = await evaluateSemanticFrames({ root });
    const inflated = JSON.parse(JSON.stringify(current));
    inflated.generatedAt = "2026-08-01T00:00:00.000Z";
    inflated.totals.contentCoverage = 1;
    for (const application of inflated.applications) {
      if (application.bundleIdentifier === "com.apple.Safari") application.contentCoverage = 1;
    }
    const baselinePath = path.join(outputRoot, "baseline.json");
    await writeFile(baselinePath, JSON.stringify(inflated));

    const unchanged = await evaluateSemanticFrames({ root, baseline: baselinePath });
    assert.equal(unchanged.comparison.baselineGeneratedAt, "2026-08-01T00:00:00.000Z");
    assert.deepEqual(unchanged.comparison.regressions, []);

    const degraded = JSON.parse(JSON.stringify(current));
    for (const application of degraded.applications) {
      if (application.bundleIdentifier === "com.apple.Safari") application.contentCoverage = 0.5;
    }
    const comparison = compareWithBaseline(degraded, inflated, 0.01);
    assert.equal(comparison.regressions.length, 1);
    assert.equal(comparison.regressions[0].bundleIdentifier, "com.apple.Safari");
    assert.equal(comparison.regressions[0].metric, "contentCoverage");
    assert.equal(comparison.regressions[0].delta, -0.5);

    const outputDirectory = path.join(outputRoot, "semantic-frames");
    await writeReport({ ...degraded, comparison }, outputDirectory);
    const written = JSON.parse(await readFile(path.join(outputDirectory, "report.json"), "utf8"));
    assert.equal(written.comparison.regressions.length, 1);
    assert.match(
      await readFile(path.join(outputDirectory, "report.md"), "utf8"),
      /com.apple.Safari \| contentCoverage/,
    );
    assert.equal((await stat(path.join(outputDirectory, "report.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

void test("returns an empty report for a root without segments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-semantic-empty-"));
  try {
    const report = await evaluateSemanticFrames({ root });
    assert.deepEqual(report.input.segmentIDs, []);
    assert.equal(report.totals.events, 0);
    assert.equal(report.totals.identityCoverage, null);
    assert.deepEqual(report.applications, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
