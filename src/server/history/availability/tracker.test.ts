import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureHealth } from "../../../shared/contracts/index.js";
import type { CollectorConnection } from "../../core/ports.js";
import { makeStorageLayout } from "../storage/repository.js";
import { RecorderAvailabilityTracker, type RecorderAvailabilityRun } from "./tracker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function health(overrides: Partial<CaptureHealth> = {}): CaptureHealth {
  return {
    accessibilityGranted: true,
    interactionMonitorActive: true,
    axObserverActive: true,
    axValueNotificationTargets: 1,
    axSelectionNotificationTargets: 1,
    returnKeyEventCount: 0,
    keyboardSubmitCount: 0,
    keyboardShortcutCount: 0,
    textInputEventCount: 0,
    selectionEventCount: 0,
    capturedEventCount: 0,
    persistedEventCount: 0,
    policyBlockedEventCount: 0,
    deduplicatedEventCount: 0,
    burstCoalescedEventCount: 0,
    lastAXCaptureDurationMilliseconds: 0,
    axCaptureBacklog: 0,
    screenCaptureGranted: false,
    ...overrides,
  };
}

function connection(
  overrides: Partial<CollectorConnection> = {},
  healthOverrides: Partial<CaptureHealth> = {},
): CollectorConnection {
  return {
    connectionState: "connected",
    snapshot: {
      recorderState: "running",
      health: health(healthOverrides),
    },
    ...overrides,
  };
}

async function fixture(): Promise<{
  root: string;
  tracker: RecorderAvailabilityTracker;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-recorder-availability-"));
  temporaryDirectories.push(root);
  return {
    root,
    tracker: new RecorderAvailabilityTracker(makeStorageLayout(root)),
  };
}

async function storedRun(root: string): Promise<RecorderAvailabilityRun> {
  const directory = path.join(root, "usage", "recorder-availability");
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(directory, files[0]), "utf8"));
}

describe("recorder availability tracking", () => {
  it("updates one run file for heartbeats and records only state transitions", async () => {
    const { root, tracker } = await fixture();
    const start = new Date("2026-09-02T00:00:00.000Z");
    await tracker.start(connection(), start);
    await tracker.record(connection(), "collector_snapshot", new Date("2026-09-02T00:00:10.000Z"));
    expect((await storedRun(root)).lastHeartbeatAt).toBe(start.toISOString());
    await tracker.record(connection(), "heartbeat", new Date("2026-09-02T00:00:30.000Z"));
    await tracker.stop({ connectionState: "stopped" }, new Date("2026-09-02T00:01:00.000Z"));

    const stored = await storedRun(root);
    expect(stored.startedAt).toBe(start.toISOString());
    expect(stored.lastHeartbeatAt).toBe("2026-09-02T00:01:00.000Z");
    expect(stored.endedAt).toBe("2026-09-02T00:01:00.000Z");
    expect(stored.transitions.map(({ state, reason }) => ({ state, reason }))).toEqual([
      { state: "available", reason: "recorder_running" },
      { state: "unavailable", reason: "server_stopped" },
    ]);
    expect(JSON.stringify(stored)).not.toContain("activeApplication");
    expect(
      (await stat(path.join(root, "usage", "recorder-availability", `${stored.runID}.json`))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("preserves usage blockers across healthy collector snapshots", async () => {
    const { root, tracker } = await fixture();
    await tracker.start(connection(), new Date("2026-09-02T01:00:00.000Z"));
    await tracker.recordUsageState(connection(), {
      timestamp: "2026-09-02T01:01:00.000Z",
      state: "unavailable",
      reason: "screen_sleep",
    });
    await tracker.record(connection(), "collector_snapshot", new Date("2026-09-02T01:01:30.000Z"));
    await tracker.recordUsageState(connection(), {
      timestamp: "2026-09-02T01:02:00.000Z",
      state: "excluded",
      reason: "application_activation",
    });

    const stored = await storedRun(root);
    expect(stored.transitions.map(({ state, reason }) => ({ state, reason }))).toEqual([
      { state: "available", reason: "recorder_running" },
      { state: "unavailable", reason: "screen_sleep" },
      { state: "available", reason: "recorder_running" },
    ]);
  });

  it("recovers from a failed heartbeat after the next healthy sample", async () => {
    const { root, tracker } = await fixture();
    await tracker.start(connection(), new Date("2026-09-02T02:00:00.000Z"));
    await tracker.recordUnavailable(
      "collector_heartbeat_failed",
      connection(),
      new Date("2026-09-02T02:00:30.000Z"),
    );
    await tracker.record(connection(), "heartbeat", new Date("2026-09-02T02:01:00.000Z"));

    const stored = await storedRun(root);
    expect(stored.transitions.map(({ state, reason }) => ({ state, reason }))).toEqual([
      { state: "available", reason: "recorder_running" },
      { state: "unavailable", reason: "collector_heartbeat_failed" },
      { state: "available", reason: "recorder_running" },
    ]);
  });
});
