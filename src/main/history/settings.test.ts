import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../agent-client.js";
import { HistoryService } from "./service.js";
import { HistorySettingsStore } from "./settings.js";
import { ensureStorage, makeStorageLayout } from "./storage.js";
import type { TimelineDocumentRecord } from "./types.js";

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
  },
  shell: { openPath: vi.fn() },
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("History settings", () => {
  it("cascades timeline deletion to its source segment before refreshing memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-delete-"));
    temporaryDirectories.push(root);
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
    }) as unknown as AgentClient;
    const service = new HistoryService(collector, root);
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
    const terminate = vi.fn();
    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "stopped" as const }),
      start,
      stop,
      terminate,
    }) as unknown as AgentClient;
    const service = new HistoryService(collector, root);

    await expect(service.start()).resolves.toMatchObject({
      recordingConsentGranted: false,
      connectionState: "stopped",
    });
    expect(start).not.toHaveBeenCalled();

    await expect(service.grantRecordingConsent()).resolves.toMatchObject({
      recordingConsentGranted: true,
    });
    expect(start).toHaveBeenCalledOnce();
    await service.stop();
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

  it("rejects unversioned settings instead of migrating them", async () => {
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

  it("persists the long-term-memory synthesis toggle independently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-settings-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const settingsStore = new HistorySettingsStore(layout);
    await settingsStore.saveLLMSettings({
      enabled: true,
      memorySynthesisEnabled: false,
      model: "custom-model",
      endpoint: "https://example.com/v1/responses",
    });
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");

    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "disconnected" as const }),
    }) as unknown as AgentClient;
    const service = new HistoryService(collector, root);
    await (service as unknown as { initialize(): Promise<void> }).initialize();

    await service.setMemorySynthesisEnabled(true);

    const reloaded = await settingsStore.loadLLMSettings();
    expect(reloaded.memorySynthesisEnabled).toBe(true);
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
      memorySynthesisEnabled: true,
      model: "custom-model",
      endpoint: "https://example.com/v1/responses",
    });
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");

    const collector = Object.assign(new EventEmitter(), {
      current: () => ({ connectionState: "disconnected" as const }),
    }) as unknown as AgentClient;
    const service = new HistoryService(collector, root);
    await (service as unknown as { initialize(): Promise<void> }).initialize();

    await service.setLLMEnabled(true);

    const reloaded = await settingsStore.loadLLMSettings();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.memorySynthesisEnabled).toBe(true);
    expect(reloaded.model).toBe("custom-model");
    expect(reloaded.endpoint).toBe("https://example.com/v1/responses");
  });
});
