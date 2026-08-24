import assert from "node:assert/strict";
import test from "node:test";
import { replayVisualPolicy } from "./eval-visual-policy.mjs";

const start = Date.parse("2026-08-22T12:00:00.000Z");

function record({
  offsetSeconds,
  decision = "needs_visual",
  source = "rules",
  assessmentAfterMilliseconds = 0,
  judgedAfterMilliseconds = 0,
  window = 1,
  application = "com.example.app",
  visualStatus,
  contentFingerprint,
}) {
  const timestampMilliseconds = start + offsetSeconds * 1_000;
  const assessmentStartedAtMilliseconds = timestampMilliseconds + assessmentAfterMilliseconds;
  const axJudgedAtMilliseconds = timestampMilliseconds + judgedAfterMilliseconds;
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
    axSource: source,
    axJudgedAt: new Date(axJudgedAtMilliseconds).toISOString(),
    axJudgedAtMilliseconds,
    assessmentStartedAt: new Date(assessmentStartedAtMilliseconds).toISOString(),
    assessmentStartedAtMilliseconds,
    assessmentTimestampSource: "assessment_started_at",
    axJudgmentTimestampObserved: true,
    visualStatus,
    visualReason: undefined,
    observedOCR: contentFingerprint !== undefined,
    observedUnderstanding: false,
    observedReuse: false,
    observedVisionCall: false,
    contentFingerprint,
  };
}

void test("replays the old non-enough baseline against settled last-event-wins intents", () => {
  const result = replayVisualPolicy([
    record({ offsetSeconds: 0 }),
    record({ offsetSeconds: 0.25 }),
    record({ offsetSeconds: 13 }),
    record({ offsetSeconds: 14, decision: "uncertain", source: "luna" }),
    record({ offsetSeconds: 15, decision: "enough" }),
  ]);

  assert.equal(result.summary.baseline.screenshotRequests, 4);
  assert.equal(result.summary.candidate.screenshotRequests, 2);
  assert.equal(result.summary.delta.screenshotRequestsSaved, 2);
  assert.equal(result.summary.candidate.coalescedIntents, 1);
  assert.deepEqual(result.summary.candidate.gateReasons, {
    capture_allowed: 2,
    intent_coalesced: 1,
    ax_uncertain_before_settle: 1,
    no_visual_intent: 1,
  });
});

void test("lets a clear enough event cancel the pending intent for its window", () => {
  const result = replayVisualPolicy([
    record({ offsetSeconds: 0 }),
    record({ offsetSeconds: 0.25, decision: "enough" }),
  ]);

  assert.equal(result.summary.candidate.screenshotRequests, 0);
  assert.equal(result.decisions[0].candidate.reason, "intent_coalesced");
  assert.equal(result.decisions[1].candidate.reason, "no_visual_intent");
});

void test("distinguishes early and late Luna enough decisions", () => {
  const result = replayVisualPolicy([
    record({
      offsetSeconds: 0,
      decision: "enough",
      source: "luna",
      judgedAfterMilliseconds: 200,
      window: 1,
    }),
    record({
      offsetSeconds: 0,
      decision: "enough",
      source: "luna",
      judgedAfterMilliseconds: 800,
      window: 2,
    }),
  ]);

  assert.equal(result.summary.candidate.screenshotRequests, 1);
  assert.equal(result.summary.candidate.discardedScreenshots, 1);
  assert.equal(result.summary.candidate.visionCallsUpperBound, 0);
  assert.equal(result.decisions[0].candidate.reason, "ax_enough_before_settle");
  assert.equal(result.decisions[1].candidate.reason, "candidate_discarded_ax_enough");
});

void test("does not impose a shared hard budget across distinct windows", () => {
  const result = replayVisualPolicy(
    Array.from({ length: 8 }, (_, index) => record({ offsetSeconds: 0, window: index + 1 })),
  );

  assert.equal(result.summary.candidate.screenshotRequests, 8);
  assert.deepEqual(result.summary.candidate.gateReasons, { capture_allowed: 8 });
});

void test("reports OCR checkpoint trigger coverage without exposing OCR text", () => {
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
  assert.equal(result.summary.fidelityProxy.p50DelayMilliseconds, 500);
  assert.equal(result.summary.worstMisses[0].nextCandidateDelayMilliseconds, 11_500);
});

void test("an unresolved event protects the same application when a stable ID appears", () => {
  const result = replayVisualPolicy([
    record({ offsetSeconds: 0, window: null }),
    record({ offsetSeconds: 1, window: 42 }),
    record({ offsetSeconds: 12.5, window: 42 }),
  ]);

  assert.equal(result.summary.candidate.screenshotRequests, 2);
  assert.equal(result.decisions[1].candidate.reason, "window_cooldown");
});
