import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../agent-client.js";
import { HistoryService } from "./service.js";
import type { HistoryEvent } from "./types.js";
import type { VisualCaptureProvider } from "./visual.js";

const temporaryDirectories: string[] = [];

function collector(): AgentClient {
  return Object.assign(new EventEmitter(), {
    current: () => ({ connectionState: "disconnected" as const }),
  }) as unknown as AgentClient;
}

function uncertainEvent(): HistoryEvent {
  return {
    id: "00000000-0000-4000-8000-000000000099",
    timestamp: new Date().toISOString(),
    kind: "mouse.click",
    captureReason: "mouse",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
    window: { title: "Example", isPrivateBrowsing: false, runtimeIdentifier: 42 },
    accessibility: {
      mode: "fullTree",
      text: 'AXTree v2 nodes=2\ne1 AXWindow\n  e2 AXStaticText title="Partial"',
    },
  };
}

function modelResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("visual evidence service", () => {
  it("captures a settled gray-zone candidate without waiting for the model decision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-23T02:30:00.000Z"));
    let resolveModel!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveModel = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    const capture = vi.fn().mockResolvedValue({
      status: "captured",
      provider: "test-provider",
      capturedAt: new Date().toISOString(),
      ocrText: "Visible content",
    });
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "luna",
      captureMode: "fallback",
      understandingMode: "ocr",
    });

    internal.scheduleVisualEnrichment(uncertainEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledOnce();
    resolveModel(
      modelResponse({
        decision: "needs_visual",
        confidence: 0.9,
        reasons: ["visible_content_missing"],
        missing_evidence: ["primary_content"],
      }),
    );
    await internal.visualWork;

    expect(capture).toHaveBeenCalledOnce();
  });

  it("reports a visual gap when no screenshot provider is installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    const service = new HistoryService(collector(), root);
    const internal = service as unknown as {
      captureVisualEvidence(event: HistoryEvent): Promise<{
        payload: { status: string; reason?: string };
      }>;
    };

    await expect(internal.captureVisualEvidence(uncertainEvent())).resolves.toMatchObject({
      payload: { status: "unavailable", reason: "provider_unavailable" },
    });
  });

  it("does not turn an uncertain Luna decision into a screenshot request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        modelResponse({
          decision: "uncertain",
          confidence: 0.4,
          reasons: ["screen_required_to_decide"],
          missing_evidence: ["primary_content"],
        }),
      ),
    );
    const capture = vi.fn();
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
      visualHealth: { visualGapCount: number; lastCaptureDecisionReason?: string };
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "luna",
      captureMode: "fallback",
      understandingMode: "ocr",
    });

    internal.scheduleVisualEnrichment(uncertainEvent());
    await internal.visualWork;

    expect(capture).not.toHaveBeenCalled();
    expect(internal.visualHealth).toMatchObject({
      visualGapCount: 1,
      lastCaptureDecisionReason: "ax_judge_uncertain",
    });
  });

  it("discards a transient candidate when Luna later decides AX is enough", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-23T02:30:00.000Z"));
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    let resolveModel!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveModel = resolve;
          }),
      ),
    );
    const capture = vi.fn().mockResolvedValue({
      status: "captured",
      provider: "test-provider",
      capturedAt: "2026-08-23T02:30:00.500Z",
      ocrText: "Transient local text",
    });
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
      visualHealth: { captureDiscardedCount: number; visionCalledCount: number };
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "luna",
      captureMode: "fallback",
      understandingMode: "ocr",
    });

    const source = uncertainEvent();
    internal.scheduleVisualEnrichment(source);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledOnce();
    resolveModel(
      modelResponse({
        decision: "enough",
        confidence: 0.9,
        reasons: ["visible_content_covered"],
        missing_evidence: [],
      }),
    );
    await internal.visualWork;

    const evidence = (
      await readFile(path.join(root, "segments", "2026-08-23T02-30-00Z", "evidence.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(evidence.at(-1)).toMatchObject({
      assessment_started_at: "2026-08-23T02:30:00.000Z",
      visual: {
        status: "discarded",
        reason: "candidate_discarded_ax_enough",
        privacy: "not_captured",
      },
    });
    expect(JSON.stringify(evidence.at(-1))).not.toContain("Transient local text");
    expect(internal.visualHealth).toMatchObject({
      captureDiscardedCount: 1,
      visionCalledCount: 0,
    });
  });

  it("reuses Luna understanding for an unchanged window image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-22T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        modelResponse({ understanding: "Visible conversation", confidence: 0.88 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const capture = vi.fn().mockResolvedValue({
      status: "captured",
      provider: "test-provider",
      capturedAt: new Date(startedAt).toISOString(),
      imageBase64: "unchanged-privacy-processed-image",
    });
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
      visualHealth: {
        visualUnchangedCount: number;
        visualReusedCount: number;
        visionCalledCount: number;
      };
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "rules",
      captureMode: "fallback",
      understandingMode: "luna",
    });
    const first = {
      ...uncertainEvent(),
      id: "00000000-0000-4000-8000-000000000101",
      timestamp: new Date(startedAt).toISOString(),
      accessibility: undefined,
    };
    internal.scheduleVisualEnrichment(first);
    await vi.advanceTimersByTimeAsync(500);
    await internal.visualWork;

    vi.setSystemTime(startedAt + 13_000);
    internal.scheduleVisualEnrichment({
      ...first,
      id: "00000000-0000-4000-8000-000000000102",
      timestamp: new Date(startedAt + 13_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(500);
    await internal.visualWork;

    expect(capture).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(internal.visualHealth).toMatchObject({
      visualUnchangedCount: 1,
      visualReusedCount: 1,
      visionCalledCount: 1,
    });
  });

  it("coalesces pending intents per window before taking a candidate screenshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-23T02:30:00.000Z");
    vi.setSystemTime(startedAt);
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    const capture = vi.fn().mockResolvedValue({
      status: "captured",
      provider: "test-provider",
      capturedAt: new Date(startedAt).toISOString(),
      ocrText: "Visible content",
    });
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
      visualHealth: { captureCoalescedCount: number };
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "rules",
      captureMode: "fallback",
      understandingMode: "ocr",
    });
    const first = {
      ...uncertainEvent(),
      id: "00000000-0000-4000-8000-000000000201",
      timestamp: new Date(startedAt).toISOString(),
      accessibility: undefined,
    };
    const second = {
      ...first,
      id: "00000000-0000-4000-8000-000000000202",
      timestamp: new Date(startedAt + 250).toISOString(),
    };

    internal.scheduleVisualEnrichment(first);
    await vi.advanceTimersByTimeAsync(250);
    internal.scheduleVisualEnrichment(second);
    await vi.advanceTimersByTimeAsync(500);
    await internal.visualWork;

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ eventID: second.id });
    expect(internal.visualHealth.captureCoalescedCount).toBe(1);
  });

  it("cancels pending screenshot intents when the optional provider is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    vi.useFakeTimers();
    vi.stubEnv("OPENAI_API_KEY", "configured-for-test");
    const capture = vi.fn();
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      initialize(): Promise<void>;
      scheduleVisualEnrichment(event: HistoryEvent): void;
      visualWork: Promise<unknown>;
    };
    await internal.initialize();
    await service.configureVisual({
      axJudge: "rules",
      captureMode: "fallback",
      understandingMode: "ocr",
    });

    internal.scheduleVisualEnrichment({ ...uncertainEvent(), accessibility: undefined });
    await vi.advanceTimersByTimeAsync(250);
    await service.configureVisual({
      axJudge: "rules",
      captureMode: "off",
      understandingMode: "ocr",
    });
    await vi.advanceTimersByTimeAsync(500);
    await internal.visualWork;

    expect(capture).not.toHaveBeenCalled();
  });

  it("does not turn an expired capture into provider-wide backoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-"));
    temporaryDirectories.push(root);
    const capture = vi.fn().mockResolvedValue({
      status: "unavailable",
      reason: "request_expired",
      provider: "test-provider",
    });
    const provider: VisualCaptureProvider = {
      id: "test-provider",
      status: () => "ready",
      requestPermission: vi.fn(),
      capture,
    };
    const service = new HistoryService(collector(), root, provider);
    const internal = service as unknown as {
      captureVisualEvidence(
        event: HistoryEvent,
        mode: "ocr",
        now: number,
      ): Promise<{
        payload: { status: string; reason?: string };
      }>;
    };
    const first = uncertainEvent();
    const second = {
      ...first,
      id: "00000000-0000-4000-8000-000000000302",
      window: { ...first.window!, runtimeIdentifier: 84 },
    };

    await expect(internal.captureVisualEvidence(first, "ocr", Date.now())).resolves.toMatchObject({
      payload: { status: "unavailable", reason: "request_expired" },
    });
    await expect(
      internal.captureVisualEvidence(second, "ocr", Date.now() + 1),
    ).resolves.toMatchObject({
      payload: { status: "unavailable", reason: "request_expired" },
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
