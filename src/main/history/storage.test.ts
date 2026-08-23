import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHistoryData,
  ensureStorage,
  makeStorageLayout,
  SegmentStore,
  segmentIdentifier,
} from "./storage.js";
import type { EventEvidenceEnrichment, HistoryEvent } from "./types.js";

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

  it("clears history directories without deleting settings", async () => {
    const { root, store, event } = await fixture();
    const layout = makeStorageLayout(root);
    await store.append(event);
    await writeFile(path.join(layout.timeline, "example.md"), "timeline", { mode: 0o600 });
    await writeFile(path.join(layout.memoryDay, "example.md"), "memory", { mode: 0o600 });
    await writeFile(path.join(layout.state, "recording-consent.json"), "{}", { mode: 0o600 });

    await clearHistoryData(layout);
    store.reset();

    await expect(stat(path.join(layout.state, "recording-consent.json"))).resolves.toBeDefined();
    await expect(stat(path.join(layout.timeline, "example.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(layout.memoryDay, "example.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      store.append({ ...event, id: "33333333-3333-4333-8333-333333333333" }),
    ).resolves.toBeUndefined();
  });
});
