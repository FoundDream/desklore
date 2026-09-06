import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ClosedSegment, TimelineDocumentRecord } from "../contracts.js";
import {
  ensureStorage,
  makeStorageLayout,
  SegmentStore,
  segmentIdentifier,
} from "../storage/repository.js";
import { encodeTimelineMarkdown } from "./markdown.js";
import { TimelineRepository } from "./repository.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("loads existing documents once per batch and observes later edits and removals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-timeline-batch-"));
  roots.push(root);
  const layout = makeStorageLayout(root);
  await ensureStorage(layout);
  const store = new SegmentStore(layout);
  const repository = new TimelineRepository(layout, store, async () => undefined);
  const segments: ClosedSegment[] = [];
  const documents: TimelineDocumentRecord[] = [];
  for (let index = 0; index < 12; index += 1) {
    const startedAt = new Date(Date.UTC(2026, 7, 20, 0, index * 10));
    const id = segmentIdentifier(startedAt);
    const document: TimelineDocumentRecord = {
      schemaVersion: 4,
      id: `document-${index}`,
      sourceSegmentID: id,
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + 600_000).toISOString(),
      title: "Synthetic task",
      description: "Synthetic summary",
      claims: [],
      evidenceEventIDs: [],
      applications: [{ bundleIdentifier: "com.example.editor", name: "Editor" }],
      generator: { type: "agent", version: 1 },
      createdAt: startedAt.toISOString(),
      body: "Synthetic body",
      filePath: path.join(layout.timeline, `${index}.md`),
    };
    documents.push(document);
    await writeFile(document.filePath!, encodeTimelineMarkdown(document));
    segments.push({
      metadata: {
        schemaVersion: 1,
        id,
        startedAt: document.startedAt,
        endedAt: document.endedAt,
        eventCount: 1,
        capturedEventCount: 1,
        suppressedEventCount: 0,
        policyBlockedEventCount: 0,
        deduplicatedEventCount: 0,
        burstCoalescedEventCount: 0,
        eventsFile: "events.jsonl",
      },
      directoryPath: path.join(layout.segments, id),
      eventsPath: path.join(layout.segments, id, "events.jsonl"),
    });
  }
  const loads = vi.spyOn(repository, "loadDocuments");
  const reads = vi.spyOn(store, "readEvents").mockResolvedValue([]);
  expect(await repository.generatePending(segments)).toEqual([]);
  expect(loads).toHaveBeenCalledTimes(1);
  expect(reads).not.toHaveBeenCalled();

  await rm(documents[0]!.filePath!);
  await writeFile(
    documents[1]!.filePath!,
    encodeTimelineMarkdown({ ...documents[1]!, title: "Edited outside the app" }),
  );
  await repository.generatePending(segments);
  expect(loads).toHaveBeenCalledTimes(2);
  expect(reads).toHaveBeenCalledExactlyOnceWith(segments[0]);
  expect((await repository.loadDocuments()).find((item) => item.id === "document-1")?.title).toBe(
    "Edited outside the app",
  );
});
