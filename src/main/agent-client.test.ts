import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient, agentExecutableCandidates } from "./agent-client.js";

const originalCollectorPath = process.env.DESKLORE_COLLECTOR_PATH;

afterEach(() => {
  if (originalCollectorPath === undefined) {
    delete process.env.DESKLORE_COLLECTOR_PATH;
  } else {
    process.env.DESKLORE_COLLECTOR_PATH = originalCollectorPath;
  }
});

describe("AgentClient", () => {
  it("reports a missing native agent without spawning a process", async () => {
    const client = new AgentClient(["/path/that/does/not/exist"]);

    await expect(client.start()).resolves.toMatchObject({
      connectionState: "missing",
      connectionError: "DeskLore Collector was not built",
    });
  });

  it("uses an inert connected agent for synthetic demo roots", async () => {
    const client = new AgentClient([], undefined, true);

    await expect(client.start()).resolves.toMatchObject({
      connectionState: "connected",
      agent: { recorderState: "paused", health: { capturedEventCount: 0 } },
    });
    await expect(client.request("pause")).resolves.toMatchObject({
      connectionState: "connected",
    });
  });

  it("resolves development and packaged agent locations", () => {
    process.env.DESKLORE_COLLECTOR_PATH = "/custom/DeskLoreCollector";

    expect(agentExecutableCandidates("/app", "/resources", "/project")).toEqual([
      "/custom/DeskLoreCollector",
      path.join("/resources/native", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
      path.join("/project/dist", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
      path.join("/app/dist", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
    ]);
  });
});
