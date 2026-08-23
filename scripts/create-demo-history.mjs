#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEMO_MARKER = {
  schemaVersion: 1,
  synthetic: true,
  purpose: "capture-safe DeskLore demo data",
};

const applications = [
  { bundleIdentifier: "com.example.writer", name: "Example Writer" },
  { bundleIdentifier: "com.example.browser", name: "Example Browser" },
  { bundleIdentifier: "com.example.terminal", name: "Example Terminal" },
];

function usage() {
  return [
    "Usage: node scripts/create-demo-history.mjs [--root DIR] [--mode timeline|onboarding]",
    "",
    "The root must be inside the current repository. It is marked synthetic and is",
    "rejected by the desktop app when it is missing the marker or overlaps app data.",
  ].join("\n");
}

function parseArguments(argv) {
  const values = { root: ".desklore-demo", mode: "timeline" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--root") {
      values.root = argv[index + 1];
      index += 1;
    } else if (argument === "--mode") {
      values.mode = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  if (!values.root || !["timeline", "onboarding"].includes(values.mode)) {
    throw new Error(`Invalid demo arguments\n\n${usage()}`);
  }
  return values;
}

function assertRepositoryChild(root) {
  const repositoryRoot = path.resolve(process.cwd());
  const relative = path.relative(repositoryRoot, root);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Demo root must be a child directory of the current repository");
  }
}

function segmentIdentifier(timestamp) {
  return new Date(timestamp)
    .toISOString()
    .replace(/:\d{2}\.000Z$/, "-00Z")
    .replace(/:/g, "-");
}

function quote(value) {
  return JSON.stringify(value);
}

function event(id, timestamp, application, kind, title, interaction) {
  return {
    id,
    timestamp,
    kind,
    captureReason: kind === "window.changed" ? "window_focus" : "mouse",
    application,
    window: {
      title,
      ...(application.bundleIdentifier === "com.example.browser"
        ? { url: "https://demo.invalid/notes" }
        : {}),
      isPrivateBrowsing: false,
    },
    ...(interaction ? { interaction } : {}),
  };
}

function timelineDocument({
  id,
  sourceSegmentID,
  startedAt,
  endedAt,
  title,
  description,
  apps,
  eventIDs,
  body,
}) {
  const lines = [
    "---",
    "schema_version: 4",
    `id: ${quote(id)}`,
    `source_segment_id: ${quote(sourceSegmentID)}`,
    `started_at: ${quote(startedAt)}`,
    `ended_at: ${quote(endedAt)}`,
    `title: ${quote(title)}`,
    `description: ${quote(description)}`,
    "applications:",
    ...apps.flatMap((application) => [
      `  - bundle_id: ${quote(application.bundleIdentifier)}`,
      `    name: ${quote(application.name)}`,
    ]),
    "evidence_event_ids:",
    ...eventIDs.map((eventID) => `  - ${quote(eventID)}`),
    "claims:",
    `  - text: ${quote(description)}`,
    `    evidence_ids: ${quote(eventIDs.slice(0, 3).join(","))}`,
    "generator:",
    '  type: "demo"',
    "  version: 1",
    'created_at: "2026-08-22T16:00:00.000Z"',
    "---",
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

function demoSegments() {
  const firstStartedAt = "2026-08-22T08:00:00.000Z";
  const secondStartedAt = "2026-08-22T14:00:00.000Z";
  const firstSegmentID = segmentIdentifier(firstStartedAt);
  const secondSegmentID = segmentIdentifier(secondStartedAt);
  const firstEvents = [
    event(
      "demo-event-001",
      "2026-08-22T08:01:00.000Z",
      applications[0],
      "window.changed",
      "Demo notes",
    ),
    event(
      "demo-event-002",
      "2026-08-22T08:03:00.000Z",
      applications[0],
      "keyboard.text_input",
      "Demo notes",
      { text: "Draft a reproducible release note" },
    ),
    event(
      "demo-event-003",
      "2026-08-22T08:06:00.000Z",
      applications[2],
      "keyboard.shortcut",
      "Demo terminal",
      { keyEquivalent: "K", modifiers: ["command"] },
    ),
  ];
  const secondEvents = [
    event(
      "demo-event-004",
      "2026-08-22T14:01:00.000Z",
      applications[1],
      "window.changed",
      "Demo research board",
    ),
    event(
      "demo-event-005",
      "2026-08-22T14:04:00.000Z",
      applications[1],
      "mouse.click",
      "Demo research board",
      { clickCount: 1, mouseButton: "left" },
    ),
    event(
      "demo-event-006",
      "2026-08-22T14:08:00.000Z",
      applications[0],
      "keyboard.submit",
      "Demo notes",
      { keyEquivalent: "ENTER" },
    ),
  ];
  return [
    {
      id: "demo-timeline-001",
      sourceSegmentID: firstSegmentID,
      startedAt: firstStartedAt,
      endedAt: "2026-08-22T08:10:00.000Z",
      title: "Reproducible release note",
      description:
        "Example Writer and Example Terminal recorded a synthetic documentation session.",
      apps: [applications[0], applications[2]],
      events: firstEvents,
      body: "## Activity\n\n- 08:01–08:06: Example Writer and Example Terminal\n\n## Evidence-linked claims\n\n- The session drafted a reproducible release note from fixed demo input.",
    },
    {
      id: "demo-timeline-002",
      sourceSegmentID: secondSegmentID,
      startedAt: secondStartedAt,
      endedAt: "2026-08-22T14:10:00.000Z",
      title: "Research board review",
      description: "Example Browser and Example Writer recorded a synthetic review session.",
      apps: [applications[1], applications[0]],
      events: secondEvents,
      body: "## Activity\n\n- 14:01–14:08: Example Browser and Example Writer\n\n## Evidence-linked claims\n\n- The session reviewed a fixed research board and returned to the notes.",
    },
  ];
}

async function writeJSON(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function createDemoHistory({ root, mode = "timeline" }) {
  const resolvedRoot = path.resolve(root);
  assertRepositoryChild(resolvedRoot);
  await mkdir(resolvedRoot, { recursive: true });
  await writeJSON(path.join(resolvedRoot, ".desklore-demo.json"), DEMO_MARKER);

  const historyRoot = path.join(resolvedRoot, "history");
  await mkdir(path.join(historyRoot, "state"), { recursive: true });
  await writeJSON(path.join(historyRoot, "state", "observation-policy.json"), {
    schemaVersion: 1,
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    allowedBundleIdentifiers: [],
    blockedBundleIdentifiers: [],
    allowedDomains: [],
    blockedDomains: [],
  });
  await writeJSON(path.join(historyRoot, "state", "visual-settings.json"), {
    schemaVersion: 1,
    axJudge: "rules",
    captureMode: "off",
    understandingMode: "off",
  });

  if (mode === "onboarding") {
    return { root: resolvedRoot, mode, files: [".desklore-demo.json"] };
  }

  await writeJSON(path.join(historyRoot, "state", "recording-consent.json"), {
    schemaVersion: 1,
    granted: true,
    grantedAt: "2026-08-22T08:00:00.000Z",
  });

  const files = [".desklore-demo.json", "history/state/recording-consent.json"];
  for (const segment of demoSegments()) {
    const segmentRoot = path.join(historyRoot, "segments", segment.sourceSegmentID);
    await mkdir(segmentRoot, { recursive: true });
    await writeJSON(path.join(segmentRoot, "metadata.json"), {
      schemaVersion: 1,
      id: segment.sourceSegmentID,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      eventCount: segment.events.length,
      suppressedEventCount: 0,
      capturedEventCount: segment.events.length,
      policyBlockedEventCount: 0,
      deduplicatedEventCount: 0,
      burstCoalescedEventCount: 0,
      eventsFile: "events.jsonl",
    });
    await writeFile(
      path.join(segmentRoot, "events.jsonl"),
      `${segment.events.map((item) => JSON.stringify(item)).join("\n")}\n`,
      { mode: 0o600 },
    );
    const eventIDs = segment.events.map((item) => item.id);
    await mkdir(path.join(historyRoot, "timeline"), { recursive: true });
    await writeFile(
      path.join(historyRoot, "timeline", `${segment.sourceSegmentID}-${segment.id}.md`),
      timelineDocument({ ...segment, eventIDs }),
      { mode: 0o600 },
    );
    files.push(`history/segments/${segment.sourceSegmentID}/events.jsonl`);
    files.push(`history/timeline/${segment.sourceSegmentID}-${segment.id}.md`);
  }
  return { root: resolvedRoot, mode, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const result = await createDemoHistory({ root: values.root, mode: values.mode });
    console.log(`Created ${result.mode} demo data in ${result.root}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
