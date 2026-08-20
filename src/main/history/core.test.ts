import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyKeyboardEvent, EventBurstCoalescer, EventCoalescer } from "./coalescer.js";
import { sampleTimelineEvents } from "./lifecycle.js";
import { decodeTimelineMarkdown, encodeTimelineMarkdown } from "./markdown.js";
import { applyObservationPolicy, defaultObservationPolicy, sanitizeEvent } from "./policy.js";
import { makeStorageLayout, SegmentStore, segmentIdentifier } from "./storage.js";
import { rawActivityRecord, TimelineRepository } from "./timeline.js";
import type { HistoryEvent, TimelineDocumentRecord } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function event(overrides: Partial<HistoryEvent> = {}, index = 0): HistoryEvent {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, index)).toISOString(),
    kind: "window.changed",
    application: { bundleIdentifier: "com.example.editor", name: "Editor" },
    window: { title: "Computer History implementation", isPrivateBrowsing: false },
    ...overrides,
  };
}

describe("TypeScript history core", () => {
  it("enforces observation policy and sanitizes secrets before persistence", () => {
    const input = event({
      target: { role: "AXTextField", placeholder: "API Key", value: "secret-value" },
      interaction: { text: "sk-abcdefghijklmnopqrstuvwxyz" },
    });
    expect(applyObservationPolicy(defaultObservationPolicy, input)).toBeUndefined();

    const safe = sanitizeEvent(
      event({
        interaction: { text: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
        window: {
          title: "Editor",
          url: "https://alice:secret@example.com/path?q=token#fragment",
          isPrivateBrowsing: false,
        },
      }),
    );
    expect(safe.interaction?.text).toBe("[REDACTED]");
    expect(safe.window?.url).toBe("https://example.com/path");
  });

  it("coalesces text deltas and short click bursts", () => {
    const coalescer = new EventCoalescer();
    const first = coalescer.process(
      event({ kind: "keyboard.text_input", interaction: { text: "hel" } }, 1),
    );
    const second = coalescer.process(
      event(
        {
          timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 2)).toISOString(),
          kind: "keyboard.text_input",
          interaction: { text: "hello" },
        },
        2,
      ),
    );
    expect(first?.interaction?.text).toBe("hel");
    expect(second?.interaction?.text).toBe("lo");

    const bursts = new EventBurstCoalescer();
    expect(bursts.ingest(event({ kind: "mouse.click" }, 3))).toEqual([]);
    expect(
      bursts.ingest(
        event(
          {
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 3, 500)).toISOString(),
            kind: "mouse.click",
          },
          4,
        ),
      ),
    ).toEqual([]);
    expect(bursts.flushAll()[0]?.occurrenceCount).toBe(2);
  });

  it("classifies Return semantics in TypeScript using the captured AX target", () => {
    const submit = classifyKeyboardEvent(
      event({
        kind: "keyboard.shortcut",
        target: { role: "AXTextField", placeholder: "Send a message" },
        interaction: { keyEquivalent: "return", modifiers: [] },
      }),
    );
    const multiline = classifyKeyboardEvent(
      event({
        kind: "keyboard.shortcut",
        target: { role: "AXTextArea", placeholder: "Notes" },
        interaction: { keyEquivalent: "return", modifiers: [] },
      }),
    );
    expect(submit.kind).toBe("keyboard.submit");
    expect(multiline.kind).toBe("keyboard.shortcut");
  });

  it("writes the legacy-compatible snake_case JSONL and ten-minute metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const store = new SegmentStore(makeStorageLayout(root));
    const input = event({}, 1);
    await store.append(input);
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    expect(segmentIdentifier(new Date(input.timestamp))).toBe("2026-08-20T13-40-00Z");
    expect(closed?.metadata).toMatchObject({ eventCount: 1, suppressedEventCount: 0 });
    const line = await readFile(closed!.eventsPath, "utf8");
    expect(line).toContain('"bundle_identifier":"com.example.editor"');
    expect(line).toContain('"is_private_browsing":false');
    await expect(store.readEvents(closed!)).resolves.toEqual([input]);
  });

  it("round-trips schema v2 Markdown including persisted LLM failure reason", () => {
    const document: TimelineDocumentRecord = {
      schemaVersion: 2,
      id: "document-1",
      sourceSegmentID: "2026-08-20T13-40-00Z",
      startedAt: "2026-08-20T13:40:00.000Z",
      endedAt: "2026-08-20T13:50:00.000Z",
      title: "Computer History migration",
      description: "Migrated timeline generation and persistence from Swift into TypeScript.",
      activityState: "implementation_completed",
      applications: [{ bundleIdentifier: "com.example.editor", name: "Editor" }],
      evidenceEventIDs: ["event-1"],
      generator: {
        type: "raw-fallback",
        version: 1,
        model: "gpt-5.6-luna",
        failureReason: "network_timeout",
      },
      createdAt: "2026-08-20T13:50:01.000Z",
      body: "## 活动\n\n迁移完成。",
    };
    const markdown = encodeTimelineMarkdown(document);
    expect(markdown).toContain('failure_reason: "network_timeout"');
    expect(decodeTimelineMarkdown(markdown)).toEqual(document);
  });

  it("persists an explicit failure reason and later retries the raw activity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    const store = new SegmentStore(layout);
    const input = event({}, 9);
    await store.append(input);
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    let apiKeyConfigured = false;
    const settings = {
      enabled: true,
      model: "gpt-5.6-luna",
      endpoint: "https://api.openai.com/v1/responses",
    };
    const repository = new TimelineRepository(layout, store, async () =>
      apiKeyConfigured
        ? { settings, apiKey: "test-key" }
        : { settings, failureReason: "api_key_missing" },
    );
    const document = await repository.generateIfNeeded(closed!);
    expect(document?.generator).toMatchObject({
      type: "raw-fallback",
      failureReason: "api_key_missing",
    });
    expect(document?.activityState).toBeUndefined();
    expect(await readFile(document!.filePath!, "utf8")).toContain(
      'failure_reason: "api_key_missing"',
    );

    apiKeyConfigured = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      title: "继续迁移 Computer History",
                      description: "完成了 TypeScript 迁移链路的实现工作。",
                      activity_state: "implementation_completed",
                      evidence_event_ids: [input.id],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(repository.retryFallbackDocuments([closed!], new Date(), 0)).resolves.toBe(1);
    await expect(repository.loadDocuments()).resolves.toMatchObject([
      {
        generator: { type: "llm" },
        activityState: "implementation_completed",
      },
    ]);
  });

  it("accepts the model activity state without a keyword-based semantic override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    const store = new SegmentStore(layout);
    const input = event(
      {
        accessibility: {
          mode: "fullTree",
          text: "仍未看到 PR 已创建、实现完成或验证通过的证据。",
        },
      },
      10,
    );
    await store.append(input);
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      title: "准备迁移 Computer History",
                      description: "活动仍处于规划阶段，尚未观察到实现或验证完成。",
                      activity_state: "planning",
                      evidence_event_ids: [input.id],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const repository = new TimelineRepository(layout, store, async () => ({
      settings: {
        enabled: true,
        model: "gpt-5.6-luna",
        endpoint: "https://api.openai.com/v1/responses",
      },
      apiKey: "test-key",
    }));

    const document = await repository.generateIfNeeded(closed!);

    expect(document?.generator.type).toBe("llm");
    expect(document?.activityState).toBe("planning");
  });

  it("keeps high-information accessibility evidence in a crowded sample", () => {
    const events = Array.from({ length: 1_000 }, (_, index) =>
      event(
        {
          timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 0, index)).toISOString(),
          accessibility: {
            mode: "diffFromPrevious",
            text: index === 731 ? "Build complete. Tests passed." : "ordinary editor content",
          },
        },
        index,
      ),
    );
    const sample = sampleTimelineEvents(events, 32);
    expect(sample).toHaveLength(32);
    expect(sample.some((item) => item.id === events[731]?.id)).toBe(true);
  });

  it("keeps the full window title and omits inferred state from raw activity", () => {
    const input = event(
      {
        window: {
          title:
            "refactor(repo): retire migrated server snapshot by FoundDream · Pull Request #409 · LowEntropyAI/AirJelly",
          isPrivateBrowsing: false,
        },
      },
      1,
    );
    const segment = {
      metadata: {
        id: "2026-08-20T13-40-00Z",
        startedAt: "2026-08-20T13:40:00.000Z",
        endedAt: "2026-08-20T13:50:00.000Z",
        eventCount: 1,
        suppressedEventCount: 0,
        eventsFile: "events.jsonl",
      },
      directoryPath: "/tmp/segment",
      eventsPath: "/tmp/segment/events.jsonl",
    };
    const raw = rawActivityRecord(segment, [input]);
    expect(raw.title).toBe(input.window?.title);
    expect(raw.activityState).toBeUndefined();
    expect(raw.generator.type).toBe("raw");
  });
});
