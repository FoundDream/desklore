import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyKeyboardEvent, EventBurstCoalescer, EventCoalescer } from "./coalescer.js";
import { sampleTimelineEvents } from "./lifecycle.js";
import { decodeTimelineMarkdown, encodeTimelineMarkdown } from "./markdown.js";
import { applyObservationPolicy, defaultObservationPolicy, sanitizeEvent } from "./policy.js";
import { makeStorageLayout, SegmentStore, segmentIdentifier } from "./storage.js";
import {
  prepareTimelineEventsForModel,
  rawActivityRecord,
  TimelineRepository,
} from "./timeline.js";
import {
  normalizeHistoryEvent,
  normalizeMetadata,
  type HistoryEvent,
  type TimelineDocumentRecord,
} from "./types.js";

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
    window: { title: "DeskLore implementation", isPrivateBrowsing: false },
    ...overrides,
  };
}

function llmResponse(draft: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(draft) }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("TypeScript history core", () => {
  it("rejects pre-DeskLore snake_case event and metadata shapes", () => {
    expect(() =>
      normalizeHistoryEvent({
        id: "00000000-0000-4000-8000-000000000001",
        timestamp: "2026-08-20T13:40:00.000Z",
        kind: "window.changed",
        application: { bundle_identifier: "com.example.editor", name: "Editor" },
        window: { is_private_browsing: false },
      }),
    ).toThrow("Invalid history event");
    expect(() =>
      normalizeMetadata({
        id: "2026-08-20T13-40-00Z",
        started_at: "2026-08-20T13:40:00.000Z",
        event_count: 0,
      }),
    ).toThrow("Invalid segment metadata");
  });

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
          runtimeIdentifier: 42,
        },
        evidence: {
          visual: {
            requestID: "request-1",
            status: "captured",
            provider: "test",
            ocrText: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
            understanding: "password=secret-value",
            privacy: "local_ocr",
          },
        },
      }),
    );
    expect(safe.interaction?.text).toBe("[REDACTED]");
    expect(safe.window?.url).toBe("https://example.com/path");
    expect(safe.window?.runtimeIdentifier).toBe(42);
    expect(safe.evidence?.visual?.ocrText).toBe("[REDACTED]");
    expect(safe.evidence?.visual?.understanding).toBe("[REDACTED]");
    expect(
      applyObservationPolicy(
        defaultObservationPolicy,
        event({
          application: { bundleIdentifier: "com.apple.loginwindow", name: "loginwindow" },
        }),
      ),
    ).toBeUndefined();
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
    expect(bursts.ingest(event({ kind: "mouse.click" }, 3))).toEqual({
      ready: [],
      coalescedCount: 0,
    });
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
    ).toEqual({ ready: [], coalescedCount: 1 });
    expect(bursts.flushAll()[0]?.occurrenceCount).toBe(2);
  });

  it("rejects non-editable and initial empty text value notifications", () => {
    const coalescer = new EventCoalescer();
    expect(
      coalescer.process(
        event({
          kind: "keyboard.text_input",
          target: { role: "AXStaticText", value: "rendered output" },
        }),
      ),
    ).toBeUndefined();
    expect(
      coalescer.process(
        event({
          kind: "keyboard.text_input",
          target: { role: "AXTextField", value: "" },
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps activations immediate and coalesces title churn to the latest window", () => {
    const bursts = new EventBurstCoalescer();
    const activation = event({ captureReason: "application_activation" }, 1);
    expect(bursts.ingest(activation)).toEqual({ ready: [activation], coalescedCount: 0 });

    const firstTitle = event(
      {
        captureReason: "title_change",
        window: { title: "Loading", isPrivateBrowsing: false },
      },
      2,
    );
    const settledTitle = event(
      {
        timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 3)).toISOString(),
        captureReason: "title_change",
        window: { title: "Settled", isPrivateBrowsing: false },
      },
      3,
    );
    expect(bursts.ingest(firstTitle).ready).toEqual([]);
    expect(bursts.ingest(settledTitle)).toEqual({ ready: [], coalescedCount: 1 });
    expect(bursts.flushAll()[0]).toMatchObject({
      window: { title: "Settled" },
      occurrenceCount: 2,
    });
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
    const chatWithoutTarget = classifyKeyboardEvent(
      event({
        kind: "keyboard.shortcut",
        application: { bundleIdentifier: "com.tencent.xinWeChat", name: "微信" },
        target: undefined,
        interaction: { keyEquivalent: "return", modifiers: [] },
      }),
    );
    expect(submit.kind).toBe("keyboard.submit");
    expect(multiline.kind).toBe("keyboard.shortcut");
    expect(chatWithoutTarget.kind).toBe("keyboard.submit");
  });

  it("drops duplicate focus callbacks but preserves later and activation events", () => {
    const coalescer = new EventCoalescer();
    expect(coalescer.process(event({ captureReason: "window_focus" }, 1))).toBeDefined();
    expect(coalescer.process(event({ captureReason: "window_focus" }, 2))).toBeUndefined();
    expect(
      coalescer.process(
        event(
          {
            captureReason: "focus_change",
            target: { role: "AXTextArea", placeholder: "Prompt" },
          },
          3,
        ),
      ),
    ).toBeUndefined();
    expect(
      coalescer.process(
        event(
          {
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 4, 1)).toISOString(),
            captureReason: "focus_change",
          },
          4,
        ),
      ),
    ).toBeDefined();
    expect(coalescer.process(event({ captureReason: "application_activation" }, 5))).toBeDefined();
  });

  it("keeps structural selection changes even when selected text is unavailable", () => {
    const coalescer = new EventCoalescer();
    const structuralSelection = event(
      {
        kind: "selection.changed",
        captureReason: "ax_selection",
        target: { role: "AXTabGroup" },
      },
      1,
    );
    expect(coalescer.process(structuralSelection)).toBeDefined();
    expect(
      coalescer.process(
        event(
          {
            ...structuralSelection,
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 1, 20)).toISOString(),
          },
          2,
        ),
      ),
    ).toBeUndefined();
    expect(
      coalescer.process(
        event(
          {
            ...structuralSelection,
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 4, 100)).toISOString(),
          },
          3,
        ),
      ),
    ).toBeDefined();
    expect(
      coalescer.process(
        event(
          {
            ...structuralSelection,
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 4, 200)).toISOString(),
            target: { role: "AXRow", identifier: "next-row" },
          },
          4,
        ),
      ),
    ).toBeDefined();
  });

  it("drops noisy selection roles and empty text caret changes", () => {
    const coalescer = new EventCoalescer();
    expect(
      coalescer.process(event({ kind: "selection.changed", target: { role: "AXLink" } }, 1)),
    ).toBeUndefined();

    const caret = event(
      {
        kind: "selection.changed",
        target: { role: "AXWebArea" },
        interaction: { selectedText: "" },
      },
      2,
    );
    expect(coalescer.process(caret)).toBeUndefined();
  });

  it("preserves repeated shortcut key-down events", () => {
    const coalescer = new EventCoalescer();
    const first = event(
      {
        kind: "keyboard.shortcut",
        captureReason: "keyboard",
        interaction: { keyEquivalent: "down-arrow", modifiers: ["function"] },
      },
      1,
    );
    expect(coalescer.process(first)).toBeDefined();
    expect(
      coalescer.process(
        event(
          {
            ...first,
            timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 1, 40)).toISOString(),
          },
          2,
        ),
      ),
    ).toBeDefined();
  });

  it("writes the current camelCase JSONL and versioned ten-minute metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const store = new SegmentStore(makeStorageLayout(root));
    const input = event({ captureReason: "mouse" }, 1);
    await store.recordMetric(input.timestamp, "captured");
    await store.append(input);
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    expect(segmentIdentifier(new Date(input.timestamp))).toBe("2026-08-20T13-40-00Z");
    expect(closed?.metadata).toMatchObject({
      schemaVersion: 1,
      eventCount: 1,
      suppressedEventCount: 0,
      capturedEventCount: 1,
      policyBlockedEventCount: 0,
      deduplicatedEventCount: 0,
      burstCoalescedEventCount: 0,
    });
    const line = await readFile(closed!.eventsPath, "utf8");
    expect(line).toContain('"bundleIdentifier":"com.example.editor"');
    expect(line).toContain('"isPrivateBrowsing":false');
    expect(line).toContain('"captureReason":"mouse"');
    await expect(store.readEvents(closed!)).resolves.toEqual([input]);
  });

  it("keeps optional visual enrichment separate and joins it by event ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-evidence-"));
    temporaryDirectories.push(root);
    const store = new SegmentStore(makeStorageLayout(root));
    const input = event(
      {
        window: {
          title: "Canvas",
          isPrivateBrowsing: false,
          runtimeIdentifier: 42,
        },
      },
      7,
    );
    await store.append(input);
    await store.appendEvidence({
      schemaVersion: 1,
      eventID: input.id,
      eventTimestamp: input.timestamp,
      createdAt: input.timestamp,
      axSufficiency: {
        decision: "needs_visual",
        source: "luna",
        confidence: 0.93,
        reasons: ["canvas_content_missing"],
        missingEvidence: ["visible_content"],
        judgedAt: input.timestamp,
      },
      visual: {
        requestID: "visual-request",
        status: "captured",
        provider: "test-provider",
        ocrText: "Visible canvas label",
        privacy: "local_ocr",
      },
    });
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    await expect(store.readEvents(closed!)).resolves.toEqual([
      {
        ...input,
        evidence: {
          axSufficiency: expect.objectContaining({
            decision: "needs_visual",
            source: "luna",
          }),
          visual: expect.objectContaining({
            status: "captured",
            ocrText: "Visible canvas label",
          }),
        },
      },
    ]);
  });

  it("round-trips schema v4 Markdown including persisted LLM failure reason", () => {
    const document: TimelineDocumentRecord = {
      schemaVersion: 4,
      id: "document-1",
      sourceSegmentID: "2026-08-20T13-40-00Z",
      startedAt: "2026-08-20T13:40:00.000Z",
      endedAt: "2026-08-20T13:50:00.000Z",
      title: "DeskLore migration",
      description: "Migrated timeline generation and persistence from Swift into TypeScript.",
      claims: [],
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
    expect(() =>
      decodeTimelineMarkdown(markdown.replace("schema_version: 4", "schema_version: 3")),
    ).toThrow("Unsupported timeline schema");
  });

  it("round-trips a narrative summary with one optional continuation hint", () => {
    const document: TimelineDocumentRecord = {
      schemaVersion: 4,
      id: "document-v4",
      sourceSegmentID: "2026-08-20T13-40-00Z",
      startedAt: "2026-08-20T13:40:00.000Z",
      endedAt: "2026-08-20T13:50:00.000Z",
      title: "语义摘要采用自然叙事",
      description: "摘要以独立标题和描述记录活动，不再拆成任务状态。",
      continuationHint: "运行真实数据评测",
      claims: [{ text: "摘要采用自然叙事。", evidenceEventIDs: ["event-1"] }],
      applications: [{ bundleIdentifier: "com.example.editor", name: "Editor" }],
      evidenceEventIDs: ["event-1"],
      generator: { type: "llm", version: 2, model: "gpt-5.6-luna" },
      createdAt: "2026-08-20T13:50:01.000Z",
      body: "## Recording summary\n\nNatural summary.",
    };

    expect(decodeTimelineMarkdown(encodeTimelineMarkdown(document))).toEqual(document);
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
      memorySynthesisEnabled: false,
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
    expect(document?.continuationHint).toBeUndefined();
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
                      title: "继续迁移 DeskLore",
                      description: "完成了 TypeScript 迁移链路的实现工作。",
                      continuation_hint: "",
                      claims: [
                        {
                          text: "完成了 TypeScript 迁移链路的实现工作。",
                          evidence_event_ids: [input.id],
                        },
                      ],
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
      },
    ]);
  });

  it("accepts a narrative-first summary without forced task metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    const store = new SegmentStore(layout);
    const input = event({
      accessibility: {
        mode: "fullTree",
        text: "仍未看到 PR 已创建、实现完成或验证通过的证据。",
      },
    });
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
                      title: "查看 DeskLore 迁移状态",
                      description: "查看了当前迁移状态，活动仍处于规划阶段。",
                      continuation_hint: "",
                      claims: [
                        {
                          text: "活动仍处于规划阶段。",
                          evidence_event_ids: [input.id],
                        },
                      ],
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
        memorySynthesisEnabled: false,
        model: "gpt-5.6-luna",
        endpoint: "https://api.openai.com/v1/responses",
      },
      apiKey: "test-key",
    }));

    const document = await repository.generateIfNeeded(closed!);

    expect(document?.generator.type).toBe("llm");
    expect(document?.continuationHint).toBeUndefined();
    expect(document).not.toHaveProperty("task");
    expect(document).not.toHaveProperty("progression");
    expect(document).not.toHaveProperty("outcome");
    expect(document).not.toHaveProperty("openLoops");
  });

  it("bounds model input by total bytes while preserving temporal endpoints", () => {
    const events = Array.from({ length: 400 }, (_, index) =>
      event(
        {
          timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, 0, index)).toISOString(),
          accessibility: {
            mode: "diffFromPrevious",
            text: `${index} ${"rich accessibility context ".repeat(500)}`,
          },
        },
        index,
      ),
    );

    const prepared = prepareTimelineEventsForModel(events);

    expect(prepared.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(prepared), "utf8")).toBeLessThanOrEqual(120 * 1_024);
    expect(prepared.some((item) => item.id === events[0]?.id)).toBe(true);
    expect(prepared.some((item) => item.id === events.at(-1)?.id)).toBe(true);
  });

  it("retries an incomplete response with a smaller model input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-ts-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    const store = new SegmentStore(layout);
    const events = Array.from({ length: 80 }, (_, index) =>
      event(
        {
          timestamp: new Date(Date.UTC(2026, 7, 20, 13, 40, index)).toISOString(),
          accessibility: {
            mode: "diffFromPrevious",
            text: "AXTreeDiff v2\n" + "context ".repeat(1_000),
          },
        },
        index,
      ),
    );
    for (const input of events) await store.append(input);
    const closed = await store.closeExpired(new Date("2026-08-20T13:50:00.000Z"));
    const requestSizes: number[] = [];
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestCount += 1;
        const requestBody = typeof init?.body === "string" ? init.body : "";
        requestSizes.push(Buffer.byteLength(requestBody, "utf8"));
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return llmResponse({
          title: "恢复 DeskLore 的结构化活动摘要",
          description: "模型输出中断后缩小输入范围，并成功生成了结构化的活动时间线摘要。",
          continuation_hint: "",
          claims: [
            {
              text: "缩小输入后成功生成摘要。",
              evidence_event_ids: [events[0]!.id, events.at(-1)!.id],
            },
          ],
          evidence_event_ids: [events[0]!.id, events.at(-1)!.id],
        });
      }),
    );
    const repository = new TimelineRepository(layout, store, async () => ({
      settings: {
        enabled: true,
        memorySynthesisEnabled: false,
        model: "gpt-5.6-luna",
        endpoint: "https://api.openai.com/v1/responses",
      },
      apiKey: "test-key",
    }));

    const document = await repository.generateIfNeeded(closed!);

    expect(document?.generator.type).toBe("llm");
    expect(requestCount).toBe(2);
    expect(requestSizes[1]).toBeLessThan(requestSizes[0]!);
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

  it("keeps the full window title and omits inferred continuation from raw activity", () => {
    const input = event(
      {
        window: {
          title:
            "refactor(repo): retire migrated server snapshot · Pull Request #409 · example/project",
          isPrivateBrowsing: false,
        },
      },
      1,
    );
    const segment = {
      metadata: {
        schemaVersion: 1 as const,
        id: "2026-08-20T13-40-00Z",
        startedAt: "2026-08-20T13:40:00.000Z",
        endedAt: "2026-08-20T13:50:00.000Z",
        eventCount: 1,
        suppressedEventCount: 0,
        capturedEventCount: 1,
        policyBlockedEventCount: 0,
        deduplicatedEventCount: 0,
        burstCoalescedEventCount: 0,
        eventsFile: "events.jsonl",
      },
      directoryPath: "/tmp/segment",
      eventsPath: "/tmp/segment/events.jsonl",
    };
    const raw = rawActivityRecord(segment, [input]);
    expect(raw.title).toBe(input.window?.title);
    expect(raw.continuationHint).toBeUndefined();
    expect(raw.generator.type).toBe("raw");
  });
});
