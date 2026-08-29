import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectorExecutableCandidates } from "./collector-paths.js";

const originalCollectorPath = process.env.DESKLORE_COLLECTOR_PATH;

afterEach(() => {
  if (originalCollectorPath === undefined) {
    delete process.env.DESKLORE_COLLECTOR_PATH;
  } else {
    process.env.DESKLORE_COLLECTOR_PATH = originalCollectorPath;
  }
});

describe("Collector paths", () => {
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
