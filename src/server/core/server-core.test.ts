import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultObservationPolicy } from "../../shared/defaults.js";
import type {
  CollectorCommand,
  CollectorConnection,
  CollectorPort,
  CredentialStore,
} from "./ports.js";
import { ServerCore } from "./server-core.js";

class FakeCollector extends EventEmitter implements CollectorPort {
  connection: CollectorConnection = { connectionState: "stopped" };
  readonly commands: Array<{ command: CollectorCommand; payload?: Record<string, unknown> }> = [];
  readonly start = vi.fn(async () => {
    this.connection = { connectionState: "connected" };
    return this.current();
  });
  readonly stop = vi.fn(async () => {
    this.connection = { connectionState: "stopped" };
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
    return this.current();
  }

  async requestPayload<T>(): Promise<T | undefined> {
    return undefined;
  }
}

class MemoryCredentialStore implements CredentialStore {
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
  it("runs headlessly with injected platform ports and an idempotent shutdown", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "desklore-server-core-"));
    temporaryDirectories.push(storageRoot);
    const collector = new FakeCollector();
    const credentials = new MemoryCredentialStore();
    const core = new ServerCore({ storageRoot }, { collector, credentials });

    expect(core.lifecycle()).toBe("created");
    await expect(core.start()).resolves.toMatchObject({ recordingConsentGranted: false });
    expect(core.lifecycle()).toBe("ready");
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

    await core.configureLLM({
      protocol: "responses",
      model: "test-model",
      endpoint: "https://example.com/v1/responses",
      apiKey: "test-key",
    });
    expect(credentials.save).toHaveBeenCalledWith("test-key", "en");

    expect(core.storagePath()).toBe(path.join(storageRoot, "timeline"));

    await Promise.all([core.shutdown(), core.shutdown()]);
    expect(core.lifecycle()).toBe("stopped");
    expect(collector.stop).toHaveBeenCalledOnce();
    core.terminate();
  });
});
