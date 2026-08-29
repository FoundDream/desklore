import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { defaultObservationPolicy } from "../../../shared/defaults.js";
import { ServerCoreProcessClient } from "./server-core-client.js";

const electron = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("electron", () => ({
  utilityProcess: { fork: electron.fork },
}));

describe("ServerCoreProcessClient", () => {
  it("initializes the child and keeps its latest snapshot", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      postMessage: vi.fn((value: unknown) => {
        const message = value as { type?: string; id?: string; method?: string };
        if (message.type === "initialize") {
          queueMicrotask(() =>
            child.emit("message", {
              type: "ready",
              snapshot: {
                locale: "en",
                connectionState: "stopped",
                recordingConsentGranted: false,
                observationPolicy: defaultObservationPolicy,
              },
            }),
          );
          return;
        }
        if (message.method === "start") {
          queueMicrotask(() =>
            child.emit("message", {
              type: "response",
              id: message.id,
              ok: true,
              value: {
                locale: "zh-CN",
                connectionState: "stopped",
                recordingConsentGranted: false,
                observationPolicy: defaultObservationPolicy,
              },
            }),
          );
          return;
        }
        if (message.method === "storagePath") {
          queueMicrotask(() =>
            child.emit("message", {
              type: "response",
              id: message.id,
              ok: true,
              value: "/tmp/desklore/timeline",
            }),
          );
        }
      }),
    });
    electron.fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const load = vi.fn(async () => "test-key");
    const openPath = vi.fn(async () => "");
    const client = new ServerCoreProcessClient({
      storageRoot: "/tmp/desklore",
      collectorExecutableCandidates: ["/tmp/collector"],
      credentials: {
        has: vi.fn(async () => true),
        load,
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      desktopShell: { openPath },
    });

    await client.connect();
    expect(load).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize", apiKey: "test-key" }),
    );

    await client.start();
    expect(client.current().locale).toBe("zh-CN");

    await client.revealStorage();
    expect(openPath).toHaveBeenCalledWith("/tmp/desklore/timeline");
    client.terminate();
  });
});
