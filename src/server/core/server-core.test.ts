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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ServerCore", () => {
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
