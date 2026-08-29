import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStorage, makeStorageLayout } from "./storage.js";
import {
  TimelineAgentDiagnosticsRepository,
  type TimelineAgentRunRecord,
} from "./timeline-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function record(id: string, finishedAt: string): TimelineAgentRunRecord {
  return {
    schemaVersion: 1,
    id,
    sourceSegmentID: "2026-08-24T08-00-00Z",
    startedAt: finishedAt,
    finishedAt,
    model: "test-model",
    provider: "custom",
    protocol: "responses",
    retry: false,
    turns: 2,
    toolCalls: { read_events: 1, submit_timeline: 1 },
    inspectedEventCount: 1,
    evidenceBytes: 200,
    inputTokens: 100,
    outputTokens: 20,
    latencyMilliseconds: 10,
    terminalState: "succeeded",
  };
}

describe("timeline agent diagnostics", () => {
  it("keeps owner-only structured metrics and prunes runs older than 30 days", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-diagnostics-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const repository = new TimelineAgentDiagnosticsRepository(layout);

    await repository.append(
      record("old", "2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await repository.append(
      record("current", "2026-08-24T00:00:00.000Z"),
      new Date("2026-08-24T00:00:00.000Z"),
    );

    await expect(repository.load()).resolves.toMatchObject([{ id: "current" }]);
    expect((await stat(repository.filePath())).mode & 0o777).toBe(0o600);
  });
});
