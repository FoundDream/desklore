import { describe, expect, it } from "vitest";
import { CollectorClient } from "./client.js";

describe("CollectorClient", () => {
  it("reports a missing collector without spawning a process", async () => {
    const client = new CollectorClient(["/path/that/does/not/exist"]);

    await expect(client.start()).resolves.toMatchObject({
      connectionState: "missing",
      connectionError: "DeskLore Collector was not built",
    });
  });
});
