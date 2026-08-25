import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStorage, makeStorageLayout } from "./storage.js";
import { TimelineAgentJobRepository } from "./timeline-agent-jobs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("timeline agent jobs", () => {
  it("persists owner-only control state without observed content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-jobs-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const repository = new TimelineAgentJobRepository(layout);

    const created = await repository.create("segment-1", "document-1", "fingerprint-1");
    expect(created.totalRuntimeFailures).toBe(0);
    expect(created.consecutiveFailures).toBe(0);
    await repository.update(created.id, {
      status: "waiting_provider",
      failureClass: "network_timeout",
      nextEligibleAt: "2026-08-24T12:00:00.000Z",
      totalTurns: 7,
    });

    await expect(repository.load()).resolves.toMatchObject([
      {
        sourceSegmentID: "segment-1",
        documentID: "document-1",
        status: "waiting_provider",
        totalTurns: 7,
      },
    ]);
    expect((await stat(repository.filePath())).mode & 0o777).toBe(0o600);
  });

  it("removes the job when its source segment is deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-jobs-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const repository = new TimelineAgentJobRepository(layout);
    await repository.create("segment-1", "document-1", "fingerprint-1");

    await repository.deleteBySegment("segment-1");

    await expect(repository.load()).resolves.toEqual([]);
  });

  it("wakes legacy retry schedules that used accumulated provider turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-jobs-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const repository = new TimelineAgentJobRepository(layout);
    const updatedAt = "2026-08-25T01:09:38.000Z";
    await writeFile(
      repository.filePath(),
      `${JSON.stringify([
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000001",
          sourceSegmentID: "2026-08-24T12-20-00Z",
          documentID: "document-1",
          fingerprint: "fingerprint-1",
          status: "stalled",
          failureClass: "agent_stalled",
          failureSignature: "no_progress",
          totalTurns: 21,
          totalToolCalls: 5,
          totalSubmissions: 0,
          totalProviderRequests: 21,
          totalRuntimeFailures: 0,
          noProgressStreak: 3,
          nextEligibleAt: "2026-08-25T07:09:49.000Z",
          createdAt: "2026-08-24T12:20:00.000Z",
          updatedAt,
        },
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000002",
          sourceSegmentID: "2026-08-24T18-30-00Z",
          documentID: "document-2",
          fingerprint: "fingerprint-2",
          status: "stalled",
          failureClass: "agent_stalled",
          failureSignature: "no_progress",
          totalTurns: 22,
          totalToolCalls: 5,
          totalSubmissions: 0,
          totalProviderRequests: 22,
          totalRuntimeFailures: 0,
          consecutiveFailures: 1,
          noProgressStreak: 3,
          createdAt: "2026-08-24T18:30:00.000Z",
          updatedAt,
        },
      ])}\n`,
      { mode: 0o600 },
    );

    await expect(repository.load()).resolves.toMatchObject([
      {
        consecutiveFailures: 1,
        nextEligibleAt: updatedAt,
      },
      {
        consecutiveFailures: 1,
        nextEligibleAt: updatedAt,
      },
    ]);
  });
});
