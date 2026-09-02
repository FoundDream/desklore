import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyRecorderAvailability,
  classifySegment,
  diagnosticSummary,
  discoverLocalCodexHistoryRoot,
  evaluateEvents,
  normalizedEvent,
  normalizedMetadata,
  normalizedRecorderAvailabilityRun,
  readDataset,
  readRecorderAvailability,
  run as runHistoryEvaluation,
  tolerantMatchCount,
  tolerantMatchPairs,
} from "./eval-history-data.mjs";

function event(timestamp, kind = "mouse.click", bundleIdentifier = "com.example.app") {
  return { timestamp, kind, app: "Example", bundleIdentifier };
}

void test("normalizes the current candidate schema and the Codex reference schema", () => {
  const raw = {
    id: "EVENT-1",
    timestamp: "2026-08-20T12:00:00.000Z",
    kind: "window.changed",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
  };
  const normalized = normalizedEvent(raw, "candidate");
  assert.equal(normalized.timestamp, "2026-08-20T12:00:00.000Z");
  assert.equal(normalized.kind, "window.changed");
  assert.equal(normalized.app, "Example");
  assert.equal(normalized.bundleIdentifier, "com.example.app");
  assert.equal(normalized.semantics.axPresent, false);
  assert.throws(
    () =>
      normalizedEvent(
        {
          id: "EVENT-1",
          timestamp: "2026-08-20T12:00:00.000Z",
          kind: "window.changed",
          application: { bundle_identifier: "com.example.app", name: "Example" },
        },
        "candidate",
      ),
    /Invalid history event/,
  );
  assert.equal(
    normalizedEvent(
      {
        timestamp: "2026-08-20T12:00:00Z",
        kind: "window.changed",
        app: { bundleIdentifier: "com.example.app", name: "Example" },
      },
      "reference",
    ).bundleIdentifier,
    "com.example.app",
  );
});

void test("normalizes camelCase and snake_case reference metadata", () => {
  assert.deepEqual(
    normalizedMetadata(
      {
        id: "2026-08-20T12-00-00Z",
        startedAt: "2026-08-20T12:00:00Z",
        endedAt: "2026-08-20T12:10:00Z",
        eventCount: 4,
      },
      "reference",
      "2026-08-20T12-00-00Z",
    ),
    {
      id: "2026-08-20T12-00-00Z",
      startedAt: "2026-08-20T12:00:00Z",
      endedAt: "2026-08-20T12:10:00Z",
      eventCount: 4,
      raw: {
        id: "2026-08-20T12-00-00Z",
        startedAt: "2026-08-20T12:00:00Z",
        endedAt: "2026-08-20T12:10:00Z",
        eventCount: 4,
      },
    },
  );
  const snake = normalizedMetadata(
    {
      id: "2026-08-20T12-00-00Z",
      started_at: "2026-08-20T12:00:00Z",
      ended_at: "2026-08-20T12:10:00Z",
      event_count: 4,
    },
    "reference",
    "2026-08-20T12-00-00Z",
  );
  assert.equal(snake.endedAt, "2026-08-20T12:10:00Z");
  assert.equal(snake.eventCount, 4);
});

void test("discovers the read-only local Codex Computer History root without a Team ID", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-codex-local-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const historyRoot = path.join(
    root,
    "EXAMPLE.com.openai.sky.CUAService",
    "Library",
    "Caches",
    "ComputerUse",
    "Skysight",
  );
  await mkdir(path.join(historyRoot, "segments"), { recursive: true });

  await assert.doesNotReject(async () => {
    assert.equal(await discoverLocalCodexHistoryRoot({ groupContainersRoot: root }), historyRoot);
  });
  await assert.rejects(
    discoverLocalCodexHistoryRoot({ groupContainersRoot: path.join(root, "empty") }),
    /Cannot read the macOS Group Containers directory/,
  );
});

void test("classifies open, partial, invalid, and complete buckets", () => {
  const base = {
    metadata: {
      id: "2026-08-20T12-00-00Z",
      startedAt: "2026-08-20T12:00:00Z",
      endedAt: "2026-08-20T12:10:00Z",
      eventCount: 1,
    },
    directoryID: "2026-08-20T12-00-00Z",
    eventRows: 1,
    malformedLines: 0,
  };
  assert.equal(classifySegment(base).status, "complete");
  assert.equal(
    classifySegment({ ...base, metadata: { ...base.metadata, endedAt: undefined } }).status,
    "open",
  );
  assert.equal(
    classifySegment({
      ...base,
      metadata: { ...base.metadata, startedAt: "2026-08-20T12:00:03Z" },
    }).status,
    "partial_start",
  );
  assert.equal(
    classifySegment({
      ...base,
      metadata: { ...base.metadata, endedAt: "2026-08-20T12:09:57Z" },
    }).status,
    "partial_end",
  );
  assert.equal(classifySegment({ ...base, eventRows: 2 }).status, "invalid_events");
});

void test("readDataset exposes unreadable and incomplete segments instead of dropping them", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-eval-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const segments = path.join(root, "segments");
  await mkdir(segments);
  const completeID = "2026-08-20T12-00-00Z";
  const openID = "2026-08-20T12-10-00Z";
  const unreadableID = "2026-08-20T12-20-00Z";
  const invalidID = "2026-08-20T12-30-00Z";
  for (const id of [completeID, openID, unreadableID, invalidID]) {
    await mkdir(path.join(segments, id));
  }
  const referenceEvent = `${JSON.stringify({
    timestamp: "2026-08-20T12:00:01Z",
    kind: "window.changed",
    app: { bundleIdentifier: "com.example.app", name: "Example" },
  })}\n`;
  await Promise.all([
    writeFile(
      path.join(segments, completeID, "metadata.json"),
      JSON.stringify({
        id: completeID,
        startedAt: "2026-08-20T12:00:00Z",
        endedAt: "2026-08-20T12:10:00Z",
        eventCount: 1,
      }),
    ),
    writeFile(path.join(segments, completeID, "events.jsonl"), referenceEvent),
    writeFile(
      path.join(segments, openID, "metadata.json"),
      JSON.stringify({ id: openID, started_at: "2026-08-20T12:10:00Z", event_count: 0 }),
    ),
    writeFile(path.join(segments, openID, "events.jsonl"), ""),
    writeFile(path.join(segments, invalidID, "metadata.json"), "{}"),
  ]);

  const dataset = await readDataset(root, "reference");
  assert.equal(dataset.dataQuality.statusCounts.complete, 1);
  assert.equal(dataset.dataQuality.statusCounts.open, 1);
  assert.equal(dataset.dataQuality.statusCounts.unreadable, 1);
  assert.equal(dataset.dataQuality.statusCounts.invalid_metadata, 1);
  assert.equal(dataset.dataQuality.issues.length, 3);
});

void test("full paired run records provenance and scores only complete shared buckets", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-eval-history-run-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const reference = path.join(root, "reference");
  const output = path.join(root, "output");
  const segmentSelection = path.join(root, "segment-selection.json");
  const segmentID = "2026-08-20T12-00-00Z";
  const candidateDirectory = path.join(candidate, "segments", segmentID);
  const referenceDirectory = path.join(reference, "segments", segmentID);
  const availabilityDirectory = path.join(candidate, "usage", "recorder-availability");
  await Promise.all([
    mkdir(candidateDirectory, { recursive: true }),
    mkdir(referenceDirectory, { recursive: true }),
    mkdir(availabilityDirectory, { recursive: true }),
  ]);
  const candidateEvent = {
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-08-20T12:00:01.000Z",
    kind: "window.changed",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
  };
  const referenceEvent = {
    timestamp: "2026-08-20T12:00:01.500Z",
    kind: "window.changed",
    app: { bundleIdentifier: "com.example.app", name: "Example" },
  };
  await Promise.all([
    writeFile(
      path.join(candidateDirectory, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: segmentID,
        startedAt: "2026-08-20T12:00:00.000Z",
        endedAt: "2026-08-20T12:10:00.000Z",
        eventCount: 1,
        suppressedEventCount: 0,
        capturedEventCount: 1,
        policyBlockedEventCount: 0,
        deduplicatedEventCount: 0,
        burstCoalescedEventCount: 0,
        eventsFile: "events.jsonl",
      }),
    ),
    writeFile(path.join(candidateDirectory, "events.jsonl"), `${JSON.stringify(candidateEvent)}\n`),
    writeFile(
      path.join(referenceDirectory, "metadata.json"),
      JSON.stringify({
        id: segmentID,
        started_at: "2026-08-20T12:00:00.000Z",
        ended_at: "2026-08-20T12:10:00.000Z",
        event_count: 1,
      }),
    ),
    writeFile(path.join(referenceDirectory, "events.jsonl"), `${JSON.stringify(referenceEvent)}\n`),
    writeFile(
      path.join(availabilityDirectory, "fixture-run.json"),
      JSON.stringify({
        schemaVersion: 1,
        runID: "fixture-run",
        startedAt: "2026-08-20T12:00:00.000Z",
        lastHeartbeatAt: "2026-08-20T12:10:00.000Z",
        endedAt: "2026-08-20T12:10:00.000Z",
        transitions: [
          {
            timestamp: "2026-08-20T12:00:00.000Z",
            state: "available",
            reason: "recorder_running",
            trigger: "server_start",
            connectionState: "connected",
            recorderState: "running",
            accessibilityGranted: true,
            interactionMonitorActive: true,
          },
        ],
      }),
    ),
    writeFile(segmentSelection, JSON.stringify({ overall: { segmentIDs: [segmentID] } })),
  ]);

  const report = await runHistoryEvaluation([
    "--candidate",
    candidate,
    "--reference",
    reference,
    "--output",
    output,
    "--segment-ids-file",
    segmentSelection,
    "--candidate-settings",
    "fixture",
  ]);

  assert.equal(report.schemaVersion, 3);
  assert.equal(report.evaluatorVersion, "history-paired-v4");
  assert.equal(report.overall.commonCompletedSegments, 1);
  assert.equal(report.overall.matches.tolerant.matches, 1);
  assert.equal(report.provenance.candidate.recorderSettings, "fixture");
  assert.equal(report.provenance.reference.adapter, "skysight-flex-v1");
  assert.equal(report.provenance.reference.origin, "configured-path");
  assert.equal(report.segmentSelection.mode, "explicit_file");
  assert.equal(report.segmentSelection.requestedCount, 1);
  assert.equal(report.recorderAvailability.candidate.telemetry, "recorded");
  assert.deepEqual(report.recorderAvailability.referenceCompleteSegments.statusCounts, {
    available: 1,
    unavailable: 0,
    unknown: 0,
  });
  assert.equal((await stat(path.join(output, "report.json"))).mode & 0o777, 0o600);
});

void test("recorder availability distinguishes healthy, interrupted, and legacy segments", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-eval-availability-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "usage", "recorder-availability");
  await mkdir(directory, { recursive: true });
  const run = {
    schemaVersion: 1,
    runID: "run-a",
    startedAt: "2026-08-20T12:00:00.000Z",
    lastHeartbeatAt: "2026-08-20T12:14:00.000Z",
    transitions: [
      {
        timestamp: "2026-08-20T12:00:00.000Z",
        state: "available",
        reason: "recorder_running",
        trigger: "server_start",
        connectionState: "connected",
        recorderState: "running",
        accessibilityGranted: true,
        interactionMonitorActive: true,
      },
    ],
  };
  const restartedRun = {
    ...run,
    runID: "run-b",
    startedAt: "2026-08-20T12:20:00.000Z",
    lastHeartbeatAt: "2026-08-20T12:30:00.000Z",
    endedAt: "2026-08-20T12:30:00.000Z",
    transitions: [
      {
        ...run.transitions[0],
        timestamp: "2026-08-20T12:20:00.000Z",
      },
    ],
  };
  await Promise.all([
    writeFile(path.join(directory, "run-a.json"), JSON.stringify(run)),
    writeFile(path.join(directory, "run-b.json"), JSON.stringify(restartedRun)),
    writeFile(path.join(directory, "invalid.json"), "{}"),
  ]);

  assert.equal(normalizedRecorderAvailabilityRun(run, "run-a").runID, "run-a");
  const availability = await readRecorderAvailability(root);
  assert.equal(availability.telemetry, "recorded");
  assert.equal(availability.invalidRunCount, 1);
  assert.deepEqual(
    classifyRecorderAvailability(availability.runs, "2026-08-20T11-50-00Z", 90_000),
    { status: "unknown", reason: "before_first_recorded_run" },
  );
  assert.deepEqual(
    classifyRecorderAvailability(availability.runs, "2026-08-20T12-00-00Z", 90_000),
    { status: "available", reason: "continuous_healthy_run" },
  );
  assert.deepEqual(
    classifyRecorderAvailability(availability.runs, "2026-08-20T12-10-00Z", 90_000),
    { status: "unavailable", reason: "heartbeat_gap_or_run_ended" },
  );
  assert.deepEqual(
    classifyRecorderAvailability(availability.runs, "2026-08-20T12-20-00Z", 90_000),
    { status: "available", reason: "continuous_healthy_run" },
  );
});

void test("diagnostics preserve headline scoring while exposing segment and stream gaps", () => {
  const candidate = [
    { ...event("2026-08-20T12:00:00.000Z"), segmentID: "segment-a" },
    {
      ...event("2026-08-20T12:00:01.000Z", "selection.changed", "pid.42"),
      app: "Preview",
      segmentID: "segment-a",
      captureReason: "ax_selection",
    },
  ];
  const reference = [
    { ...event("2026-08-20T12:00:00.500Z"), segmentID: "segment-a" },
    { ...event("2026-08-20T12:00:02.000Z", "session.started"), segmentID: "segment-b" },
  ];

  const diagnostics = diagnosticSummary(candidate, reference, 1_000);
  assert.equal(diagnostics.perSegment.length, 2);
  assert.equal(diagnostics.activeSegmentSensitivity.commonCompletedSegments, 0);
  assert.equal(diagnostics.applicationKinds.length, 3);
  assert.equal(diagnostics.perSegment[0].matches, 1);
  assert.equal(diagnostics.largestStreamGaps[0].difference, 1);
  assert.equal(diagnostics.captureReasons.candidate["selection.changed / ax_selection"], 1);
  assert.equal(diagnostics.unstableApplications.candidate["pid.42 / Preview"], 1);
  assert.equal(diagnostics.referenceOnlyKinds["session.started"], 1);
});

void test("diagnostics expose privacy-safe Return contexts without target labels", () => {
  const candidate = [
    {
      ...event("2026-08-20T12:00:00.000Z", "keyboard.shortcut", "com.cursor.test"),
      semantics: {
        keyEquivalent: "return",
        modifiers: [],
        targetRole: "AXTextArea",
        targetLabelPresent: true,
      },
      raw: { target: { placeholder: "private prompt" } },
    },
  ];
  const diagnostics = diagnosticSummary(candidate, [], 1_000);
  assert.deepEqual(diagnostics.returnKeyContexts.candidate, [
    {
      application: "com.cursor.test",
      classifiedKind: "keyboard.shortcut",
      targetRole: "AXTextArea",
      targetLabelPresent: true,
      modifiers: [],
      count: 1,
    },
  ]);
  assert.equal(JSON.stringify(diagnostics.returnKeyContexts).includes("private prompt"), false);
});

void test("tolerant matching is one-to-one within each kind and app stream", () => {
  const candidate = [
    event("2026-08-20T12:00:00.100Z"),
    event("2026-08-20T12:00:01.100Z"),
    event("2026-08-20T12:00:02.100Z", "selection.changed"),
  ];
  const reference = [
    event("2026-08-20T12:00:00.900Z"),
    event("2026-08-20T12:00:03.500Z"),
    event("2026-08-20T12:00:02.900Z", "selection.changed"),
  ];
  assert.equal(tolerantMatchCount(candidate, reference, 1_000), 2);
  assert.equal(tolerantMatchCount(candidate, reference, 100), 0);
  assert.equal(tolerantMatchPairs(candidate, reference, 1_000)[0].latencyMilliseconds, -800);
});

void test("evaluation reports precision, recall, F1, and per-kind coverage", () => {
  const candidate = [
    event("2026-08-20T12:00:00.000Z"),
    event("2026-08-20T12:00:01.000Z", "selection.changed"),
  ];
  const reference = [
    event("2026-08-20T12:00:00.500Z"),
    event("2026-08-20T12:00:01.500Z", "selection.changed"),
    event("2026-08-20T12:00:03.000Z", "selection.changed"),
  ];
  const result = evaluateEvents(candidate, reference, 1_000);
  assert.equal(result.exact.matches, 0);
  assert.equal(result.tolerant.matches, 2);
  assert.equal(result.tolerant.precision, 1);
  assert.equal(result.tolerant.recall, 2 / 3);
  assert.equal(result.byKind["selection.changed"].recall, 1 / 2);
});

void test("semantic diagnostics never emit raw text", () => {
  const candidate = [
    {
      ...event("2026-08-20T12:00:00.000Z", "keyboard.text_input"),
      semantics: { textPresent: true, textLengthBucket: "1-16", targetRole: "AXTextField" },
      raw: { interaction: { text: "candidate-secret" } },
    },
  ];
  const reference = [
    {
      ...event("2026-08-20T12:00:00.100Z", "keyboard.text_input"),
      semantics: { textPresent: true, textLengthBucket: "17-64", targetRole: "AXTextField" },
      raw: { keyboard: { text: "reference-secret" } },
    },
  ];
  const diagnostics = diagnosticSummary(candidate, reference, 1_000);
  const serialized = JSON.stringify(diagnostics.paired);
  assert.equal(serialized.includes("candidate-secret"), false);
  assert.equal(serialized.includes("reference-secret"), false);
  assert.equal(diagnostics.paired.semantics.fields.targetRole.agreement, 1);
  assert.equal(diagnostics.paired.semantics.fields.textLengthBucket.agreement, 0);
});
