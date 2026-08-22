import assert from "node:assert/strict";
import test from "node:test";
import { replayVisualPolicy } from "./eval-visual-policy.mjs";

const start = Date.parse("2026-08-22T12:00:00.000Z");

function record({
  offsetSeconds,
  decision = "needs_visual",
  window = 1,
  application = "com.example.app",
  visualStatus,
  contentFingerprint,
}) {
  const timestampMilliseconds = start + offsetSeconds * 1_000;
  const hasStableWindowIdentity = window !== undefined && window !== null;
  const runtimeIdentifier = hasStableWindowIdentity ? window : undefined;
  return {
    eventID: `event-${offsetSeconds}-${window ?? "missing"}`,
    timestamp: new Date(timestampMilliseconds).toISOString(),
    timestampMilliseconds,
    segmentID: "segment-a",
    kind: "mouse.click",
    application,
    applicationKey: application,
    bundleIdentifier: application,
    windowKey: `${application}\u001f${hasStableWindowIdentity ? `id:${runtimeIdentifier}` : "unresolved"}`,
    windowKeyHash: `hash-${window ?? "missing"}`,
    hasStableWindowIdentity,
    runtimeIdentifier,
    axDecision: decision,
    axSource: "luna",
    visualStatus,
    visualReason: undefined,
    observedOCR: contentFingerprint !== undefined,
    observedUnderstanding: false,
    observedReuse: false,
    observedVisionCall: false,
    contentFingerprint,
  };
}

test("replays the old non-enough baseline against needs-visual cooldown policy", () => {
  const result = replayVisualPolicy([
    record({ offsetSeconds: 0 }),
    record({ offsetSeconds: 5 }),
    record({ offsetSeconds: 12 }),
    record({ offsetSeconds: 13, decision: "uncertain" }),
    record({ offsetSeconds: 14, decision: "enough" }),
  ]);

  assert.equal(result.summary.baseline.screenshotRequests, 4);
  assert.equal(result.summary.candidate.screenshotRequests, 2);
  assert.equal(result.summary.delta.screenshotRequestsSaved, 2);
  assert.deepEqual(result.summary.candidate.gateReasons, {
    capture_allowed: 2,
    window_cooldown: 1,
    ax_uncertain: 1,
    ax_enough: 1,
  });
});

test("uses the shared rolling global capture limit", () => {
  const result = replayVisualPolicy(
    [0, 1, 2, 3, 4].map((offsetSeconds) => record({ offsetSeconds, window: offsetSeconds + 1 })),
  );

  assert.equal(result.summary.candidate.screenshotRequests, 4);
  assert.equal(result.summary.candidate.gateReasons.global_budget, 1);
});

test("reports OCR checkpoint trigger coverage without exposing OCR text", () => {
  const result = replayVisualPolicy(
    [
      record({
        offsetSeconds: 0,
        visualStatus: "captured",
        contentFingerprint: "fingerprint-a",
      }),
      record({
        offsetSeconds: 1,
        visualStatus: "captured",
        contentFingerprint: "fingerprint-b",
      }),
      record({
        offsetSeconds: 12,
        visualStatus: "captured",
        contentFingerprint: "fingerprint-b",
      }),
    ],
    { coverageMilliseconds: 5_000 },
  );

  assert.equal(result.summary.fidelityProxy.meaningfulOCRCheckpoints, 2);
  assert.equal(result.summary.fidelityProxy.coveredCheckpoints, 1);
  assert.equal(result.summary.fidelityProxy.missedCheckpoints, 1);
  assert.equal(result.summary.worstMisses[0].nextCandidateDelayMilliseconds, 11_000);
});

test("an unresolved event protects the same application when a stable ID appears", () => {
  const result = replayVisualPolicy([
    record({ offsetSeconds: 0, window: null }),
    record({ offsetSeconds: 1, window: 42 }),
    record({ offsetSeconds: 12, window: 42 }),
  ]);

  assert.equal(result.summary.candidate.screenshotRequests, 2);
  assert.equal(result.decisions[1].candidate.reason, "window_cooldown");
});
