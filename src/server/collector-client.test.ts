import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorClient, collectorExecutableCandidates } from "./collector-client.js";

const originalCollectorPath = process.env.DESKLORE_COLLECTOR_PATH;

afterEach(() => {
  if (originalCollectorPath === undefined) {
    delete process.env.DESKLORE_COLLECTOR_PATH;
  } else {
    process.env.DESKLORE_COLLECTOR_PATH = originalCollectorPath;
  }
});

describe("CollectorClient", () => {
  it("reports a missing collector without spawning a process", async () => {
    const client = new CollectorClient(["/path/that/does/not/exist"]);

    await expect(client.start()).resolves.toMatchObject({
      connectionState: "missing",
      connectionError: "DeskLore Collector was not built",
    });
  });

  it("resolves development and packaged collector locations", () => {
    process.env.DESKLORE_COLLECTOR_PATH = "/custom/DeskLoreCollector";

    expect(collectorExecutableCandidates("/app", "/resources", "/project")).toEqual([
      "/custom/DeskLoreCollector",
      path.join("/resources/native", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
      path.join("/project/dist", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
      path.join("/app/dist", "DeskLore Collector.app/Contents/MacOS/DeskLoreCollector"),
    ]);
  });
});
