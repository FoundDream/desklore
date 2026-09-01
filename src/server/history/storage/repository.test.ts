import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHistoryData,
  ensureStorage,
  latestHistoryArchive,
  makeStorageLayout,
  pruneHistoryArchives,
  restoreHistoryData,
  SegmentStore,
  segmentIdentifier,
} from "./repository.js";
import type { EventEvidenceEnrichment, HistoryEvent } from "../contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{
  root: string;
  store: SegmentStore;
  event: HistoryEvent;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-storage-"));
  temporaryDirectories.push(root);
  const layout = makeStorageLayout(root);
  await ensureStorage(layout);
  const event: HistoryEvent = {
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-08-20T00:01:00.000Z",
    kind: "window.changed",
    application: { bundleIdentifier: "com.example.editor", name: "Editor" },
    window: { title: "Example", isPrivateBrowsing: false },
  };
  return { root, store: new SegmentStore(layout), event };
}

describe("history storage deletion and retention", () => {
  it("deletes an application-owned source segment", async () => {
    const { root, store, event } = await fixture();
    await store.append(event);
    const id = segmentIdentifier(new Date(event.timestamp));
    const directory = path.join(root, "segments", id);
    await expect(stat(directory)).resolves.toBeDefined();

    await expect(store.deleteSegment(id)).resolves.toBe(true);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.deleteSegment(id)).resolves.toBe(false);
    await expect(store.deleteSegment("../outside")).rejects.toThrow("Invalid segment identifier");
  });

  it("removes visual evidence after 24 hours while retaining AX assessment", async () => {
    const { root, store, event } = await fixture();
    await store.append(event);
    const enrichment: EventEvidenceEnrichment = {
      schemaVersion: 1,
      eventID: event.id,
      eventTimestamp: event.timestamp,
      createdAt: "2026-08-20T00:01:02.000Z",
      axSufficiency: {
        decision: "needs_visual",
        source: "rules",
        confidence: 0.9,
        reasons: ["missing_visible_result"],
        missingEvidence: ["visible_result"],
        judgedAt: "2026-08-20T00:01:01.000Z",
      },
      visual: {
        requestID: "22222222-2222-4222-8222-222222222222",
        status: "captured",
        provider: "native",
        capturedAt: "2026-08-20T00:01:02.000Z",
        ocrText: "private visual text",
        privacy: "local_ocr",
      },
    };
    await store.appendEvidence(enrichment);

    await expect(store.pruneVisualEvidence(new Date("2026-08-21T00:01:03.000Z"))).resolves.toBe(1);
    const id = segmentIdentifier(new Date(event.timestamp));
    const line = (await readFile(path.join(root, "segments", id, "evidence.jsonl"), "utf8")).trim();
    const stored = JSON.parse(line) as Record<string, unknown>;
    expect(stored.axSufficiency).toBeDefined();
    expect(stored.visual).toBeUndefined();
  });

  it("moves cleared history into a recoverable archive without deleting settings", async () => {
    const { root, store, event } = await fixture();
    const layout = makeStorageLayout(root);
    await store.append(event);
    await writeFile(path.join(layout.timeline, "example.md"), "timeline", { mode: 0o600 });
    await writeFile(path.join(layout.timeline, "timeline-agent-runs.jsonl"), "diagnostic\n", {
      mode: 0o600,
    });
    await writeFile(path.join(layout.rollupDay, "example.md"), "rollup", { mode: 0o600 });
    await writeFile(path.join(layout.usage, "2026-08-24.json"), "usage\n", { mode: 0o600 });
    await writeFile(path.join(layout.state, "recording-consent.json"), "{}", { mode: 0o600 });

    const archive = await clearHistoryData(
      layout,
      { documentCount: 1, rollupCount: 1 },
      new Date("2026-08-24T08:09:10.123Z"),
    );
    store.reset();

    expect(archive).toEqual({
      id: "2026-08-24T08-09-10-123Z",
      deletedAt: "2026-08-24T08:09:10.123Z",
      documentCount: 1,
      rollupCount: 1,
    });
    await expect(latestHistoryArchive(layout)).resolves.toEqual(archive);
    await expect(stat(path.join(layout.state, "recording-consent.json"))).resolves.toBeDefined();
    await expect(stat(path.join(layout.timeline, "example.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(layout.timeline, "timeline-agent-runs.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(layout.rollupDay, "example.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(layout.usage, "2026-08-24.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(layout.trash, archive.id, "timeline", "example.md")),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(layout.trash, archive.id, "timeline", "timeline-agent-runs.jsonl")),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(layout.trash, archive.id, "usage", "2026-08-24.json")),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(layout.trash, archive.id, "rollups", "day", "example.md")),
    ).resolves.toBeDefined();

    await expect(restoreHistoryData(layout, archive.id)).resolves.toEqual(archive);
    await expect(readFile(path.join(layout.timeline, "example.md"), "utf8")).resolves.toBe(
      "timeline",
    );
    await expect(
      readFile(path.join(layout.timeline, "timeline-agent-runs.jsonl"), "utf8"),
    ).resolves.toBe("diagnostic\n");
    await expect(readFile(path.join(layout.rollupDay, "example.md"), "utf8")).resolves.toBe(
      "rollup",
    );
    await expect(readFile(path.join(layout.usage, "2026-08-24.json"), "utf8")).resolves.toBe(
      "usage\n",
    );
    await expect(latestHistoryArchive(layout)).resolves.toBeUndefined();
  });

  it("refuses to replace new history while restoring", async () => {
    const { root, store, event } = await fixture();
    const layout = makeStorageLayout(root);
    await store.append(event);
    const archive = await clearHistoryData(layout);
    store.reset();
    await expect(
      store.append({ ...event, id: "33333333-3333-4333-8333-333333333333" }),
    ).resolves.toBeUndefined();
    await expect(restoreHistoryData(layout, archive.id)).rejects.toThrow("New history exists");
  });

  it("prunes only recovery archives older than the retention cutoff", async () => {
    const { root } = await fixture();
    const layout = makeStorageLayout(root);
    const oldArchive = await clearHistoryData(layout, {}, new Date("2026-06-01T00:00:00.000Z"));
    const recentArchive = await clearHistoryData(layout, {}, new Date("2026-08-20T00:00:00.000Z"));

    await expect(pruneHistoryArchives(layout, new Date("2026-08-01T00:00:00.000Z"))).resolves.toBe(
      1,
    );
    await expect(stat(path.join(layout.trash, oldArchive.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(latestHistoryArchive(layout)).resolves.toEqual(recentArchive);
  });
});
