import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultObservationPolicy } from "../../shared/defaults.js";
import { normalizeHistoryEvent } from "../history/contracts.js";
import { HistorySettingsStore } from "../history/settings/store.js";
import { ensureStorage, makeStorageLayout } from "../history/storage/repository.js";
import type { CaptureHealth } from "../../shared/contracts/index.js";
import type { VisualEnrichmentCoordinator } from "../history/visual/coordinator.js";
import type {
  CollectorCommand,
  CollectorConnection,
  CollectorPort,
  CredentialStore,
} from "./ports.js";
import { ServerCore } from "./server-core.js";

function captureHealth(): CaptureHealth {
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
    enhancedAccessibilityRequestCount: 0,
    screenCaptureGranted: false,
  };
}

class FakeCollector extends EventEmitter implements CollectorPort {
  connection: CollectorConnection = { connectionState: "stopped" };
  readonly commands: Array<{ command: CollectorCommand; payload?: Record<string, unknown> }> = [];
  readonly start = vi.fn(async () => {
    this.connection = {
      connectionState: "connected",
      snapshot: { recorderState: "stopped", health: captureHealth() },
    };
    this.emit("snapshot", this.current());
    return this.current();
  });
  readonly stop = vi.fn(async () => {
    this.connection = { connectionState: "stopped" };
    this.emit("snapshot", this.current());
    return this.current();
  });
  readonly terminate = vi.fn();

  current(): CollectorConnection {
    return this.connection;
  }

  async request(
    command: CollectorCommand,
    payload?: Record<string, unknown>,
  ): Promise<CollectorConnection> {
    this.commands.push({ command, payload });
    const snapshot = this.connection.snapshot;
    if (snapshot && ["start", "pause", "resume"].includes(command)) {
      this.connection = {
        ...this.connection,
        snapshot: {
          ...snapshot,
          recorderState: command === "pause" ? "paused" : "running",
        },
      };
      this.emit("snapshot", this.current());
    }
    return this.current();
  }

  async requestPayload<T>(): Promise<T | undefined> {
    return undefined;
  }
}

class EphemeralCredentialStore implements CredentialStore {
  value?: string;
  readonly save = vi.fn(async (value: string) => {
    this.value = value;
  });

  async has(): Promise<boolean> {
    return Boolean(this.value);
  }

  async load(): Promise<string | undefined> {
    return this.value;
  }

  async remove(): Promise<void> {
    this.value = undefined;
  }
}

const temporaryDirectories: string[] = [];
const activeCores: ServerCore[] = [];

function internals(core: ServerCore) {
  return core as unknown as {
    captureWork: Promise<unknown>;
    timelineWork: Promise<unknown>;
    timelineAgentWork: Promise<unknown>;
    flushTimer?: NodeJS.Timeout;
    maintenanceTimer?: NodeJS.Timeout;
    visual: VisualEnrichmentCoordinator;
  };
}

async function runningCore() {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-history-mutation-"));
  temporaryDirectories.push(storageRoot);
  const collector = new FakeCollector();
  const core = new ServerCore(
    { storageRoot },
    { collector, credentials: new EphemeralCredentialStore() },
  );
  activeCores.push(core);
  await core.grantRecordingConsent();
  await internals(core).timelineWork;
  const event = normalizeHistoryEvent({
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: new Date().toISOString(),
    kind: "keyboard.submit",
    application: { bundleIdentifier: "com.example.editor", name: "Editor" },
    window: { title: "Synthetic history", isPrivateBrowsing: false },
  });
  collector.emit("event", event);
  await internals(core).captureWork;
  return { core, collector, event, layout: makeStorageLayout(storageRoot) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of activeCores.splice(0)) {
    core.terminate();
    const work = internals(core);
    await Promise.allSettled([work.captureWork, work.timelineWork, work.timelineAgentWork]);
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ServerCore", () => {
  it.each(["start", "resume"] as const)(
    "rejects history changes while %s is already in progress",
    async (command) => {
      const { core, collector, layout } = await runningCore();
      await core.pause();
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const request = collector.request.bind(collector);
      const blockedCommand = command === "start" ? "configureObservationPolicy" : "resume";
      let waiting = false;
      vi.spyOn(collector, "request").mockImplementation(async (next, payload) => {
        if (next === blockedCommand) {
          waiting = true;
          await pending;
        }
        return request(next, payload);
      });
      const recording = core[command]();
      try {
        await vi.waitFor(() => expect(waiting).toBe(true));
        await expect(core.clearHistory()).rejects.toThrow("Recording state is being changed");
        await expect(core.restoreHistory("missing-archive")).rejects.toThrow(
          "Recording state is being changed",
        );
        expect(await readdir(layout.trash)).toEqual([]);
      } finally {
        release();
        await recording;
      }
    },
  );

  it("keeps history and maintenance intact when the collector cannot pause for clear", async () => {
    const { core, collector, layout } = await runningCore();
    const before = await readdir(layout.segments);
    const timers = [internals(core).flushTimer, internals(core).maintenanceTimer];
    vi.spyOn(collector, "request").mockRejectedValue(new Error("Synthetic pause timeout"));

    await expect(core.clearHistory()).rejects.toThrow("Synthetic pause timeout");

    expect(await readdir(layout.segments)).toEqual(before);
    expect(await readdir(layout.trash)).toEqual([]);
    expect(core.current().history?.recorderState).toBe("running");
    expect([internals(core).flushTimer, internals(core).maintenanceTimer]).toEqual(timers);
    expect(core.current().historyRecovery).toBeUndefined();
  });

  it("rejects an unconfirmed pause without moving history", async () => {
    const { core, collector, layout } = await runningCore();
    vi.spyOn(collector, "request").mockImplementation(async () => collector.current());

    await expect(core.clearHistory()).rejects.toThrow("Recording must be paused");
    expect(await readdir(layout.trash)).toEqual([]);
    expect(await readdir(layout.segments)).toHaveLength(1);
  });

  it("blocks late capture during and after clear, then accepts the first resumed event", async () => {
    const { core, collector, event, layout } = await runningCore();
    vi.spyOn(internals(core).visual, "drain").mockImplementationOnce(async () => {
      collector.emit("event", { ...event, id: "late-during-clear" });
      await expect(core.resume()).rejects.toThrow("History is being cleared or restored");
      await expect(core.start()).rejects.toThrow("History is being cleared or restored");
      await expect(core.clearHistory()).rejects.toThrow("History is being cleared or restored");
    });
    const cleared = await core.clearHistory();
    expect(cleared.history?.recorderState).toBe("paused");
    expect(cleared.historyRecovery).toBeDefined();

    collector.emit("event", { ...event, id: "late-after-clear" });
    await internals(core).captureWork;
    expect(await readdir(layout.segments)).toEqual([]);

    const request = collector.request.bind(collector);
    vi.spyOn(collector, "request").mockImplementation(async (command, payload) => {
      const result = await request(command, payload);
      if (command === "resume") collector.emit("event", { ...event, id: "after-resume" });
      return result;
    });
    await core.resume();
    const [segmentID] = await readdir(layout.segments);
    const events = await readFile(path.join(layout.segments, segmentID!, "events.jsonl"), "utf8");
    expect(events).toContain("after-resume");
    expect(events).not.toContain("late-");
  });

  it("restarts maintenance after a failed clear while keeping recording paused", async () => {
    const { core, layout } = await runningCore();
    vi.spyOn(internals(core).visual, "drain").mockRejectedValueOnce(
      new Error("Synthetic drain failure"),
    );
    await expect(core.clearHistory()).rejects.toThrow("Synthetic drain failure");
    expect(core.current().history?.recorderState).toBe("paused");
    expect(internals(core).maintenanceTimer).toBeDefined();
    expect(internals(core).flushTimer).toBeDefined();
    expect(await readdir(layout.segments)).toHaveLength(1);
  });

  it("requires a confirmed pause before restoring an archive", async () => {
    const { core, collector, layout } = await runningCore();
    const cleared = await core.clearHistory();
    await core.resume();
    vi.spyOn(collector, "request").mockRejectedValueOnce(
      new Error("Synthetic restore pause timeout"),
    );
    await expect(core.restoreHistory(cleared.historyRecovery!.id)).rejects.toThrow(
      "Synthetic restore pause timeout",
    );
    expect(await readdir(layout.trash)).toHaveLength(1);
    expect(await readdir(layout.segments)).toEqual([]);
  });

  it("publishes one desktop snapshot per native update, including disconnects", async () => {
    const { core, collector } = await runningCore();
    const snapshots = vi.fn();
    core.on("snapshot", snapshots);
    collector.emit("snapshot", collector.current());
    await internals(core).captureWork;
    expect(snapshots).toHaveBeenCalledTimes(1);
    collector.connection = { connectionState: "failed", connectionError: "Synthetic disconnect" };
    collector.emit("snapshot", collector.current());
    await internals(core).captureWork;
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(snapshots.mock.lastCall?.[0]).toMatchObject({ connectionState: "failed" });
  });

  it("resumes the original recording state when restore fails", async () => {
    const { core, collector, event, layout } = await runningCore();
    await expect(core.restoreHistory("missing-archive")).rejects.toThrow(
      "History recovery archive was not found",
    );
    expect(core.current().history?.recorderState).toBe("running");
    collector.emit("event", { ...event, id: "after-restore-failure" });
    await internals(core).captureWork;
    const [segmentID] = await readdir(layout.segments);
    expect(
      await readFile(path.join(layout.segments, segmentID!, "events.jsonl"), "utf8"),
    ).toContain("after-restore-failure");
    await expect(core.clearHistory()).resolves.toMatchObject({
      history: { recorderState: "paused" },
    });
  });

  it("prepares an authoritative consent snapshot without starting the collector", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-server-core-ready-"));
    temporaryDirectories.push(storageRoot);
    const layout = makeStorageLayout(storageRoot);
    await ensureStorage(layout);
    await new HistorySettingsStore(layout).grantRecordingConsent(
      new Date("2026-08-30T00:00:00.000Z"),
    );
    const collector = new FakeCollector();
    const core = new ServerCore(
      { storageRoot },
      { collector, credentials: new EphemeralCredentialStore() },
    );

    await expect(core.prepare()).resolves.toMatchObject({
      recordingConsentGranted: true,
      connectionState: "stopped",
    });
    expect(collector.start).not.toHaveBeenCalled();
    core.terminate();
  });

  it("runs headlessly with injected platform ports and an idempotent shutdown", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-server-core-"));
    temporaryDirectories.push(storageRoot);
    const collector = new FakeCollector();
    const credentials = new EphemeralCredentialStore();
    const core = new ServerCore({ storageRoot }, { collector, credentials });

    await expect(core.start()).resolves.toMatchObject({ recordingConsentGranted: false });
    expect(collector.start).not.toHaveBeenCalled();

    await core.grantRecordingConsent();
    expect(collector.start).toHaveBeenCalledOnce();
    expect(collector.commands).toEqual([
      {
        command: "configureObservationPolicy",
        payload: { observationPolicy: defaultObservationPolicy },
      },
      { command: "start", payload: undefined },
    ]);
    const availabilityDirectory = path.join(storageRoot, "usage", "recorder-availability");
    const runFiles = await readdir(availabilityDirectory);
    expect(runFiles).toHaveLength(1);
    const runningAvailability = JSON.parse(
      await readFile(path.join(availabilityDirectory, runFiles[0]), "utf8"),
    ) as { transitions: Array<{ state: string }> };
    expect(runningAvailability.transitions.at(-1)?.state).toBe("available");
    await (
      core as unknown as {
        maintenance(): Promise<void>;
      }
    ).maintenance();
    expect(collector.commands.at(-1)).toEqual({ command: "heartbeat", payload: undefined });

    await core.configureLLM({
      protocol: "responses",
      model: "test-model",
      endpoint: "https://example.com/v1/responses",
      apiKey: "test-key",
    });
    expect(credentials.save).toHaveBeenCalledWith("test-key", "en");

    expect(core.storagePath()).toBe(path.join(storageRoot, "timeline"));

    await Promise.all([core.shutdown(), core.shutdown()]);
    expect(collector.stop).toHaveBeenCalledOnce();
    const stoppedAvailability = JSON.parse(
      await readFile(path.join(availabilityDirectory, runFiles[0]), "utf8"),
    ) as { endedAt?: string; transitions: Array<{ state: string }> };
    expect(stoppedAvailability.endedAt).toBeDefined();
    expect(stoppedAvailability.transitions.at(-1)?.state).toBe("unavailable");
    core.terminate();
  });

  it("persists structured Accessibility nodes, redacted, without rendered text", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-server-core-ax-"));
    temporaryDirectories.push(storageRoot);
    const collector = new FakeCollector();
    const core = new ServerCore(
      { storageRoot },
      { collector, credentials: new EphemeralCredentialStore() },
    );
    await core.start();
    await core.grantRecordingConsent();

    const tree = {
      nodes: [
        { id: "w", role: "AXWindow", depth: 0, siblingIndex: 0, childCount: 1 },
        {
          id: "t",
          parentID: "w",
          role: "AXStaticText",
          depth: 1,
          siblingIndex: 0,
          childCount: 0,
          value: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
        },
      ],
      visitedNodeCount: 2,
      wasTruncated: false,
    };
    collector.emit(
      "event",
      normalizeHistoryEvent({
        id: "00000000-0000-4000-8000-0000000000aa",
        timestamp: new Date().toISOString(),
        kind: "window.changed",
        captureReason: "window_focus",
        application: { bundleIdentifier: "com.example.app", name: "Example" },
        window: { title: "Example", isPrivateBrowsing: false, runtimeIdentifier: 7 },
        accessibility: { mode: "fullTree", tree },
      }),
    );
    await core.shutdown();

    const segmentsDirectory = path.join(storageRoot, "segments");
    const [segmentID] = await readdir(segmentsDirectory);
    const lines = (await readFile(path.join(segmentsDirectory, segmentID!, "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const stored = JSON.parse(lines[0]!) as {
      accessibility: { mode: string; text?: string; tree?: typeof tree };
      semantic?: { version: number; surface: string; body: string };
    };
    expect(stored.accessibility.mode).toBe("fullTree");
    expect(stored.accessibility.text).toBeUndefined();
    expect(stored.accessibility.tree?.nodes[1]?.value).toBe("[REDACTED]");
    expect(stored.semantic).toMatchObject({ version: 1, surface: "unknown" });
    expect(stored.semantic?.body).toContain("[REDACTED]");

    const reloaded = normalizeHistoryEvent(stored);
    expect(reloaded.accessibility?.text).toContain('t AXStaticText value="[REDACTED]" parent=w');
    core.terminate();
  });
});
