import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectorPort } from "../../core/ports.js";
import { createTestServerCore } from "../../testing/create-server-core.js";
import { HistorySettingsStore } from "./store.js";
import { defaultObservationPolicy } from "../../../shared/defaults.js";
import { ensureStorage, makeStorageLayout } from "../storage/repository.js";
import type { HistoryEvent, TimelineDocumentRecord } from "../contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("History settings", () => {
  it("lets immediate timeline work preempt a delayed retry wake-up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-wake-"));
    temporaryDirectories.push(root);
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
      terminate: vi.fn(),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    const advanceNextAgentJob = vi.fn(async () => ({
      processed: false,
      upgraded: false,
      pending: false,
    }));
    const internals = service as unknown as {
      timelineAgentEnabled: boolean;
      timelineAgentWork: Promise<unknown>;
      segments: { pendingClosedSegments(): Promise<never[]> };
      timeline: {
        advanceNextAgentJob(segments: never[]): Promise<{
          processed: boolean;
          upgraded: boolean;
          pending: boolean;
        }>;
      };
      kickTimelineAgent(delayMilliseconds?: number): void;
    };
    vi.spyOn(internals.segments, "pendingClosedSegments").mockResolvedValue([]);
    vi.spyOn(internals.timeline, "advanceNextAgentJob").mockImplementation(advanceNextAgentJob);
    vi.useFakeTimers();
    internals.timelineAgentEnabled = true;

    internals.kickTimelineAgent(6 * 60 * 60 * 1_000);
    internals.kickTimelineAgent();
    await vi.advanceTimersByTimeAsync(0);
    await internals.timelineAgentWork;

    expect(advanceNextAgentJob).toHaveBeenCalledOnce();
    service.terminate();
  });

  it("cascades timeline deletion to its source segment before refreshing rollups", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-delete-"));
    temporaryDirectories.push(root);
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    const document: TimelineDocumentRecord = {
      schemaVersion: 4,
      id: "timeline-document",
      sourceSegmentID: "2026-08-23T00-00-00Z",
      startedAt: "2026-08-23T00:00:00.000Z",
      endedAt: "2026-08-23T00:10:00.000Z",
      title: "Synthetic history",
      description: "Synthetic history for cascade deletion.",
      claims: [],
      applications: [],
      evidenceEventIDs: [],
      generator: { type: "rules", version: 1 },
      createdAt: "2026-08-23T00:10:01.000Z",
      body: "Synthetic history",
      filePath: path.join(root, "timeline", "synthetic.md"),
    };
    const internals = service as unknown as {
      documents: TimelineDocumentRecord[];
      segments: { deleteSegment(id: string): Promise<boolean> };
      timeline: { delete(value: TimelineDocumentRecord): Promise<void> };
      refreshDocuments(): Promise<void>;
    };
    internals.documents = [document];
    const deleteSegment = vi.spyOn(internals.segments, "deleteSegment").mockResolvedValue(true);
    const deleteTimeline = vi.spyOn(internals.timeline, "delete").mockResolvedValue();
    const refreshDocuments = vi.spyOn(internals, "refreshDocuments").mockResolvedValue();

    await service.deleteDocument(document.id);

    expect(deleteSegment).toHaveBeenCalledWith(document.sourceSegmentID);
    expect(deleteTimeline).toHaveBeenCalledWith(document);
    expect(deleteSegment.mock.invocationCallOrder[0]).toBeLessThan(
      deleteTimeline.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(refreshDocuments).toHaveBeenCalledOnce();
  });

  it("does not start the collector before recording consent is stored", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-consent-"));
    temporaryDirectories.push(root);
    const start = vi.fn(async () => ({ connectionState: "stopped" as const }));
    const stop = vi.fn(async () => ({ connectionState: "stopped" as const }));
    const request = vi.fn(async () => ({ connectionState: "stopped" as const }));
    const terminate = vi.fn();
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
      start,
      stop,
      request,
      terminate,
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);

    await expect(service.start()).resolves.toMatchObject({
      recordingConsentGranted: false,
      connectionState: "stopped",
    });
    expect(start).not.toHaveBeenCalled();

    await expect(service.grantRecordingConsent()).resolves.toMatchObject({
      recordingConsentGranted: true,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(request).toHaveBeenNthCalledWith(1, "configureObservationPolicy", {
      observationPolicy: defaultObservationPolicy,
    });
    expect(request).toHaveBeenNthCalledWith(2, "start");
    await service.shutdown();
    expect(stop).toHaveBeenCalledOnce();
    service.terminate();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("persists explicit recording consent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-consent-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);

    await expect(settingsStore.hasRecordingConsent()).resolves.toBe(false);
    await settingsStore.grantRecordingConsent(new Date("2026-08-23T00:00:00.000Z"));
    await expect(settingsStore.hasRecordingConsent()).resolves.toBe(true);
  });

  it("persists observation policy title exclusions in schema v2", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-policy-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);

    await settingsStore.savePolicy({
      ...structuredClone(defaultObservationPolicy),
      blockedWindowTitles: [{ id: "private-window", pattern: "Payroll", match: "contains" }],
    });
    expect(
      JSON.parse(await readFile(path.join(layout.state, "observation-policy.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      blockedWindowTitles: [{ id: "private-window", pattern: "Payroll", match: "contains" }],
    });
    await expect(settingsStore.loadPolicy()).resolves.toMatchObject({
      blockedWindowTitles: [{ id: "private-window", pattern: "Payroll", match: "contains" }],
    });
  });

  it("rejects observation policy schema v1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-policy-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    await writeFile(
      path.join(layout.state, "observation-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        ...structuredClone(defaultObservationPolicy),
      }),
    );

    await expect(new HistorySettingsStore(layout).loadPolicy()).rejects.toThrow(
      "Unsupported observation policy schema",
    );
  });

  it("never appends an event excluded by observation policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-policy-persist-"));
    temporaryDirectories.push(root);
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    const internals = service as unknown as {
      policy: typeof defaultObservationPolicy;
      segments: {
        append(event: HistoryEvent): Promise<undefined>;
        recordMetric(timestamp: string, metric: string): Promise<undefined>;
        recordSuppressed(timestamp: string): Promise<undefined>;
      };
      processEvent(event: HistoryEvent): Promise<void>;
    };
    internals.policy = {
      ...structuredClone(defaultObservationPolicy),
      blockedBundleIdentifiers: ["com.example.private"],
    };
    const append = vi.spyOn(internals.segments, "append").mockResolvedValue(undefined);
    const recordMetric = vi.spyOn(internals.segments, "recordMetric").mockResolvedValue(undefined);
    const recordSuppressed = vi
      .spyOn(internals.segments, "recordSuppressed")
      .mockResolvedValue(undefined);
    const input: HistoryEvent = {
      id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-08-24T00:00:00.000Z",
      kind: "window.changed",
      application: { bundleIdentifier: "com.example.private", name: "Private" },
      window: { title: "Sensitive work", isPrivateBrowsing: false },
    };

    await internals.processEvent(input);

    expect(recordMetric).toHaveBeenCalledWith(input.timestamp, "captured");
    expect(recordSuppressed).toHaveBeenCalledWith(input.timestamp);
    expect(append).not.toHaveBeenCalled();
  });

  it("pauses capture when a live policy update cannot reach the collector", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-policy-sync-"));
    temporaryDirectories.push(root);
    const request = vi.fn(async (command: string) => {
      if (command === "configureObservationPolicy") throw new Error("collector unavailable");
      return { connectionState: "connected" as const };
    });
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "connected" as const }),
      request,
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);

    await expect(
      service.updateObservationPolicy({
        ...structuredClone(defaultObservationPolicy),
        blockedDomains: ["private.example.com"],
      }),
    ).rejects.toThrow("collector unavailable");

    expect(request).toHaveBeenNthCalledWith(1, "configureObservationPolicy", {
      observationPolicy: {
        ...defaultObservationPolicy,
        blockedDomains: ["private.example.com"],
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, "pause");
    expect(service.current()).toMatchObject({
      observationPolicy: { blockedDomains: ["private.example.com"] },
      connectionError: undefined,
    });
  });

  it("defaults the interface to English and persists an explicit language choice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-interface-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);

    await expect(settingsStore.loadLocale()).resolves.toBe("en");
    await settingsStore.saveLocale("zh-CN");
    await expect(settingsStore.loadLocale()).resolves.toBe("zh-CN");
  });

  it("keeps visual capabilities independently disabled by default and persists opt-in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-visual-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);

    await expect(settingsStore.loadVisualSettings()).resolves.toEqual({
      axJudge: "rules",
      captureMode: "off",
      understandingMode: "off",
    });
    await settingsStore.saveVisualSettings({
      axJudge: "luna",
      captureMode: "fallback",
      understandingMode: "ocr",
    });
    await expect(settingsStore.loadVisualSettings()).resolves.toEqual({
      axJudge: "luna",
      captureMode: "fallback",
      understandingMode: "ocr",
    });
  });

  it("rejects unversioned visual settings instead of migrating them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-unversioned-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    await writeFile(
      path.join(layout.state, "visual-settings.json"),
      JSON.stringify({ axJudge: "rules", captureMode: "off", understandingMode: "off" }),
    );

    await expect(new HistorySettingsStore(layout).loadVisualSettings()).rejects.toThrow(
      "Unsupported visual settings schema",
    );
  });

  it("rejects unsupported LLM settings schemas", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-unsupported-llm-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    await writeFile(
      path.join(layout.state, "llm-settings.json"),
      JSON.stringify({
        schemaVersion: 99,
        enabled: false,
        rollupSynthesisEnabled: true,
        protocol: "responses",
        model: "gpt-5.6-luna",
        endpoint: "https://api.openai.com/v1/responses",
      }),
    );

    const settingsStore = new HistorySettingsStore(layout);
    await expect(settingsStore.loadLLMSettings()).rejects.toThrow(
      "Unsupported model settings schema",
    );
  });

  it("persists the timeline-rollup synthesis toggle independently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);
    await settingsStore.saveLLMSettings({
      enabled: true,
      rollupSynthesisEnabled: false,
      protocol: "responses",
      model: "custom-model",
      endpoint: "https://example.com/v1/responses",
    });
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");

    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "disconnected" as const }),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    await (service as unknown as { initialize(): Promise<void> }).initialize();

    await service.setRollupSynthesisEnabled(true);

    const reloaded = await settingsStore.loadLLMSettings();
    expect(reloaded.rollupSynthesisEnabled).toBe(true);
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.model).toBe("custom-model");
    expect(reloaded.endpoint).toBe("https://example.com/v1/responses");
  });

  it("persists the model-summary toggle independently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);
    await settingsStore.saveLLMSettings({
      enabled: false,
      rollupSynthesisEnabled: true,
      protocol: "chat_completions",
      model: "custom-model",
      endpoint: "https://example.com/v1/chat/completions",
    });
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");

    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "disconnected" as const }),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    await (service as unknown as { initialize(): Promise<void> }).initialize();

    await service.setLLMEnabled(true);

    const reloaded = await settingsStore.loadLLMSettings();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.rollupSynthesisEnabled).toBe(true);
    expect(reloaded.protocol).toBe("chat_completions");
    expect(reloaded.model).toBe("custom-model");
    expect(reloaded.endpoint).toBe("https://example.com/v1/chat/completions");
  });

  it("keeps feature toggles unchanged when the model connection changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-model-connection-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);
    await settingsStore.saveLLMSettings({
      enabled: true,
      rollupSynthesisEnabled: false,
      protocol: "responses",
      model: "original-model",
      endpoint: "https://example.com/v1/responses",
    });

    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "disconnected" as const }),
    }) as unknown as CollectorPort;
    const service = createTestServerCore(collector, root);
    await (service as unknown as { initialize(): Promise<void> }).initialize();

    await service.configureLLM({
      protocol: "chat_completions",
      model: "replacement-model",
      endpoint: "https://example.com/v1/chat/completions",
      apiKey: "",
    });
    await (service as unknown as { timelineWork: Promise<unknown> }).timelineWork;

    await expect(settingsStore.loadLLMSettings()).resolves.toEqual({
      enabled: true,
      rollupSynthesisEnabled: false,
      protocol: "chat_completions",
      model: "replacement-model",
      endpoint: "https://example.com/v1/chat/completions",
    });
  });
});
