import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStorage, makeStorageLayout } from "../../storage/repository.js";
import { TimelineAgentJobRepository } from "./jobs.js";

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
    expect(JSON.parse(await readFile(repository.filePath(), "utf8"))).toMatchObject([
      { schemaVersion: 1 },
    ]);
    expect((await stat(repository.filePath())).mode & 0o777).toBe(0o600);
  });

  it("rejects incomplete job records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-agent-jobs-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const repository = new TimelineAgentJobRepository(layout);
    const current = await repository.create("segment-1", "document-1", "fingerprint-1");
    await writeFile(
      repository.filePath(),
      `${JSON.stringify([{ ...current, consecutiveFailures: undefined }])}\n`,
      { mode: 0o600 },
    );

    await expect(repository.load()).resolves.toEqual([]);
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
});
