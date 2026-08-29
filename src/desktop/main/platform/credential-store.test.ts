import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronCredentialStore } from "./credential-store.js";

const safeStorage = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock("electron", () => ({ safeStorage }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  safeStorage.isEncryptionAvailable.mockReturnValue(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ElectronCredentialStore", () => {
  it("preserves the encrypted credential file and environment override behavior", async () => {
    const historyRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-credentials-"));
    temporaryDirectories.push(historyRoot);
    await mkdir(path.join(historyRoot, "state"));
    const store = new ElectronCredentialStore(historyRoot);

    await store.save("stored-key", "en");
    expect(await readFile(path.join(historyRoot, "state", "llm-api-key.bin"), "utf8")).toBe(
      "encrypted:stored-key",
    );
    await expect(store.load()).resolves.toBe("stored-key");
    await expect(store.has()).resolves.toBe(true);

    vi.stubEnv("OPENAI_API_KEY", "environment-key");
    await expect(store.load()).resolves.toBe("environment-key");

    await store.remove();
    vi.unstubAllEnvs();
    await expect(store.load()).resolves.toBeUndefined();
  });
});
