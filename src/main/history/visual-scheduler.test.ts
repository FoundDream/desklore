import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "./types.js";
import {
  VisualCaptureScheduler,
  VisualUnderstandingCache,
  visualCaptureLimits,
  visualPayloadSignature,
  visualWindowKey,
} from "./visual-scheduler.js";

function event(runtimeIdentifier: number, bundleIdentifier = "com.example.app"): HistoryEvent {
  return {
    id: `00000000-0000-4000-8000-${runtimeIdentifier.toString().padStart(12, "0")}`,
    timestamp: "2026-08-22T12:00:00.000Z",
    kind: "mouse.click",
    application: { bundleIdentifier, name: "Example" },
    window: {
      title: `Window ${runtimeIdentifier}`,
      isPrivateBrowsing: false,
      runtimeIdentifier,
    },
  };
}

function unresolvedEvent(bundleIdentifier = "com.example.app"): HistoryEvent {
  return {
    ...event(999, bundleIdentifier),
    window: { title: "Changing title", isPrivateBrowsing: false },
  };
}

describe("visual capture scheduler", () => {
  it("limits one window to one capture per cooldown", () => {
    const scheduler = new VisualCaptureScheduler();
    const source = event(42);

    expect(scheduler.reserve(source, 0)).toMatchObject({
      allowed: true,
      reason: "capture_allowed",
    });
    expect(scheduler.reserve(source, 1_000)).toMatchObject({
      allowed: false,
      reason: "window_cooldown",
      retryAfterMilliseconds: 11_000,
    });
    expect(scheduler.reserve(source, visualCaptureLimits.windowCooldownMilliseconds)).toMatchObject(
      { allowed: true, reason: "capture_allowed" },
    );
  });

  it("shares a four-capture rolling budget across windows", () => {
    const scheduler = new VisualCaptureScheduler();
    for (let index = 0; index < visualCaptureLimits.globalCaptureLimit; index += 1) {
      expect(scheduler.reserve(event(index), index * 1_000).allowed).toBe(true);
    }
    expect(scheduler.reserve(event(99), 5_000)).toMatchObject({
      allowed: false,
      reason: "global_budget",
    });
    expect(
      scheduler.reserve(event(99), visualCaptureLimits.globalWindowMilliseconds),
    ).toMatchObject({ allowed: true, reason: "capture_allowed" });
  });

  it("uses application cooldown when a stable window ID is missing", () => {
    const scheduler = new VisualCaptureScheduler();
    expect(scheduler.reserve(unresolvedEvent(), 0).allowed).toBe(true);
    expect(scheduler.reserve(event(42), 4_000)).toMatchObject({
      allowed: false,
      reason: "window_cooldown",
    });

    const stableFirst = new VisualCaptureScheduler();
    expect(stableFirst.reserve(event(1), 0).allowed).toBe(true);
    expect(stableFirst.reserve(unresolvedEvent(), 4_000)).toMatchObject({
      allowed: false,
      reason: "window_cooldown",
    });

    const distinctStableWindows = new VisualCaptureScheduler();
    expect(distinctStableWindows.reserve(event(1), 0).allowed).toBe(true);
    expect(distinctStableWindows.reserve(event(2), 4_000).allowed).toBe(true);
  });

  it("backs off repeated provider failures and resets after success", () => {
    const scheduler = new VisualCaptureScheduler();
    scheduler.recordProviderFailure(0);
    expect(scheduler.reserve(event(1), 1_000)).toMatchObject({
      allowed: false,
      reason: "provider_backoff",
      retryAfterMilliseconds: 29_000,
    });

    scheduler.recordProviderFailure(30_000);
    expect(scheduler.reserve(event(1), 31_000)).toMatchObject({
      allowed: false,
      reason: "provider_backoff",
      retryAfterMilliseconds: 119_000,
    });

    scheduler.recordProviderSuccess();
    expect(scheduler.reserve(event(1), 31_000)).toMatchObject({
      allowed: true,
      reason: "capture_allowed",
    });
  });
});

describe("visual understanding cache", () => {
  it("reuses only the same window and exact transient image", () => {
    const cache = new VisualUnderstandingCache();
    const first = event(1);
    const second = event(2);
    const signature = visualPayloadSignature({
      status: "captured",
      provider: "test",
      imageBase64: "same-image",
    });
    expect(signature).toBeDefined();
    expect(
      visualPayloadSignature({
        status: "captured",
        provider: "test",
        imageBase64: "changed-image",
      }),
    ).not.toBe(signature);

    cache.set(visualWindowKey(first), signature!, {
      understanding: "Visible conversation",
      confidence: 0.88,
      createdAtMilliseconds: 0,
    });
    expect(cache.get(visualWindowKey(first), signature!, 1_000)).toMatchObject({
      understanding: "Visible conversation",
      confidence: 0.88,
    });
    expect(cache.get(visualWindowKey(second), signature!, 1_000)).toBeUndefined();
    expect(
      cache.get(visualWindowKey(first), signature!, visualCaptureLimits.cacheTTLMilliseconds),
    ).toBeUndefined();
  });
});
