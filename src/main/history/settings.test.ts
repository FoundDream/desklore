import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../agent-client.js";
import { HistoryService } from "./service.js";
import { HistorySettingsStore } from "./settings.js";
import { ensureStorage, makeStorageLayout } from "./storage.js";

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
  it("persists the long-term-memory synthesis toggle independently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-settings-"));
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
});
