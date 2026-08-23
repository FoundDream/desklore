import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aggregateVisualValueResults,
  blindVisualArm,
  classifyVisualValueCase,
  preparePairedTimelineInputs,
  run,
  selectVisualValueCases,
  validateSummary,
} from "./eval-visual-value.mjs";

const startedAt = "2026-08-22T12:00:00.000Z";

function event({
  id = "event-a",
  offsetSeconds = 0,
  axText,
  ocrText,
  understanding,
  privacy = "local_ocr",
} = {}) {
  const timestamp = new Date(Date.parse(startedAt) + offsetSeconds * 1_000).toISOString();
  return {
    id,
    timestamp,
    kind: "mouse.click",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
    window: {
      title: "Example",
      url: "https://example.com/page?token=private#secret",
      isPrivateBrowsing: false,
      runtimeIdentifier: 42,
    },
    accessibility: axText === undefined ? undefined : { mode: "fullTree", text: axText },
    evidence:
      ocrText || understanding
        ? {
            axSufficiency: {
              decision: "needs_visual",
              source: "rules",
              confidence: 1,
              reasons: ["ax_empty"],
              missingEvidence: ["semantic_text"],
              judgedAt: timestamp,
            },
            visual: {
              requestID: `request-${id}`,
              status: "captured",
              provider: "test",
              capturedAt: timestamp,
              ocrText,
              understanding,
              privacy,
            },
          }
        : undefined,
  };
}

async function writeSegmentFixture(root, ocrText = "PRIVATE_VISUAL_SOURCE_TEXT") {
  const segmentID = "2026-08-22T12-00-00-000Z";
  const segmentDirectory = path.join(root, "segments", segmentID);
  await mkdir(segmentDirectory, { recursive: true });
  const source = event({ id: "event-private", ocrText });
  await Promise.all([
    writeFile(
      path.join(segmentDirectory, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: segmentID,
        startedAt,
        endedAt: "2026-08-22T12:10:00.000Z",
        eventCount: 1,
        suppressedEventCount: 0,
        capturedEventCount: 1,
        policyBlockedEventCount: 0,
        deduplicatedEventCount: 0,
        burstCoalescedEventCount: 0,
        eventsFile: "events.jsonl",
      }),
    ),
    writeFile(path.join(segmentDirectory, "events.jsonl"), `${JSON.stringify(source)}\n`),
    writeFile(
      path.join(segmentDirectory, "evidence.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        eventID: source.id,
        eventTimestamp: source.timestamp,
        createdAt: source.timestamp,
        visual: source.evidence.visual,
        axSufficiency: source.evidence.axSufficiency,
      })}\n`,
    ),
  ]);
  return { segmentID, source };
}

test("classifies AX-empty, AX-rich, and mixed captured visual cases", () => {
  assert.equal(classifyVisualValueCase([event({ ocrText: "visible" })]).cohort, "positive");
  assert.equal(
    classifyVisualValueCase([event({ axText: "a".repeat(1_000), ocrText: "visible" })]).cohort,
    "negative_control",
  );
  assert.equal(
    classifyVisualValueCase([event({ axText: "short", ocrText: "visible" })]).cohort,
    "mixed",
  );
  assert.equal(classifyVisualValueCase([event({ axText: "short" })]), undefined);
});

test("creates identical sampled IDs while removing only visual evidence from AX-only", () => {
  const source = event({
    axText: "api_key=abcdefghijklmnop",
    ocrText: "token=abcdefghijklmnop",
    understanding: "A visible confirmation",
  });
  const paired = preparePairedTimelineInputs([source]);

  assert.deepEqual(
    paired.axOnly.map((item) => item.id),
    paired.withVisual.map((item) => item.id),
  );
  assert.equal(paired.axOnly[0].evidence.visual, undefined);
  assert.equal(paired.axOnly[0].evidence.axSufficiency.decision, "needs_visual");
  assert.equal(paired.withVisual[0].evidence.visual.ocrText, "[REDACTED]");
  assert.equal(paired.withVisual[0].accessibility.text, "[REDACTED]");
  assert.equal(paired.withVisual[0].window.url, "https://example.com/page");
});

test("stratifies newest cases across cohorts and keeps blind labels deterministic", () => {
  const cases = [
    { segmentID: "positive-new", cohort: "positive", startedAt: "2026-08-22T12:03:00Z" },
    { segmentID: "positive-old", cohort: "positive", startedAt: "2026-08-22T12:00:00Z" },
    { segmentID: "negative", cohort: "negative_control", startedAt: "2026-08-22T12:02:00Z" },
    { segmentID: "mixed", cohort: "mixed", startedAt: "2026-08-22T12:01:00Z" },
  ];

  assert.deepEqual(
    selectVisualValueCases(cases, 3).map((item) => item.segmentID),
    ["positive-new", "negative", "mixed"],
  );
  assert.equal(blindVisualArm("segment-a"), blindVisualArm("segment-a"));
  assert.ok(["a", "b"].includes(blindVisualArm("segment-a")));
});

test("aggregates paired judge scores without mixing failed cases", () => {
  const scores = {
    axOnly: {
      factual_coverage: 2,
      visual_fact_coverage: 1,
      citation_support: 3,
      unsupported_claims: 1,
    },
    withVisual: {
      factual_coverage: 4,
      visual_fact_coverage: 4,
      citation_support: 3,
      unsupported_claims: 0,
    },
  };
  const report = aggregateVisualValueResults([
    {
      cohort: "positive",
      blind: { winner: "with_visual" },
      scores,
      modelUsage: { calls: 3, inputTokens: 100, outputTokens: 20, latencyMilliseconds: 10 },
    },
    { cohort: "mixed", error: "model_refusal" },
  ]);

  assert.equal(report.successfulCases, 1);
  assert.equal(report.failedCases, 1);
  assert.deepEqual(report.overall.winners, { with_visual: 1 });
  assert.equal(report.overall.withVisual.visualFactCoverage, 4);
  assert.equal(report.overall.delta.visualFactCoverage, 3);
  assert.equal(report.modelUsage.calls, 3);
});

test("applies the production summary citation and content constraints", () => {
  const summary = {
    title: "Activity",
    description: "Reviewed the visible state.",
    continuation_hint: "",
    claims: [{ text: "A fact", evidence_event_ids: ["EVENT-A"] }],
    evidence_event_ids: ["EVENT-A"],
  };

  assert.deepEqual(validateSummary(summary, ["event-a"]).evidence_event_ids, ["event-a"]);
  assert.throws(
    () => validateSummary({ ...summary, evidence_event_ids: ["event-a", "EVENT-A"] }, ["event-a"]),
    /summary_invalid_evidence_ids/,
  );
  assert.throws(
    () => validateSummary({ ...summary, title: "x".repeat(121) }, ["event-a"]),
    /summary_content_too_long/,
  );
});

test("manifest-only run reads local evidence but writes no source text", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-value-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryRoot, "output");
  await writeSegmentFixture(temporaryRoot);

  const report = await run([
    "--input",
    temporaryRoot,
    "--output",
    outputDirectory,
    "--max-cases",
    "1",
  ]);
  const artifacts = await Promise.all(
    ["report.json", "report.md", "manifest.jsonl", "cases.jsonl"].map((name) =>
      readFile(path.join(outputDirectory, name), "utf8"),
    ),
  );

  assert.equal(report.mode, "manifest_only");
  assert.equal(report.selection.selectedCases, 1);
  assert.ok(artifacts.every((contents) => !contents.includes("PRIVATE_VISUAL_SOURCE_TEXT")));
  assert.equal((await stat(path.join(outputDirectory, "report.json"))).mode & 0o777, 0o600);
});

test("paired model run maps randomized labels back to AX-only and visual arms", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "computer-history-visual-model-"));
  const outputDirectory = path.join(temporaryRoot, "output");
  const { segmentID } = await writeSegmentFixture(temporaryRoot);
  const originalFetch = globalThis.fetch;
  const originalAPIKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  context.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalAPIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalAPIKey;
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    const schemaName = request.text.format.name;
    let value;
    if (schemaName === "computer_history_visual_value_summary") {
      const hasVisual = request.input[1].content.includes('"visual":');
      value = {
        title: hasVisual ? "Visual summary" : "AX summary",
        description: hasVisual ? "Included a supported visible fact." : "Used AX events only.",
        continuation_hint: "",
        claims: [{ text: "Supported activity", evidence_event_ids: ["event-private"] }],
        evidence_event_ids: ["event-private"],
      };
    } else {
      const visualLabel = blindVisualArm(segmentID);
      const visualScores = {
        factual_coverage: 4,
        visual_fact_coverage: 4,
        citation_support: 4,
        unsupported_claims: 0,
      };
      const axScores = {
        factual_coverage: 2,
        visual_fact_coverage: 0,
        citation_support: 4,
        unsupported_claims: 0,
      };
      value = {
        candidate_a: visualLabel === "a" ? visualScores : axScores,
        candidate_b: visualLabel === "b" ? visualScores : axScores,
        winner: visualLabel,
        reason_codes: ["visual_fact_added"],
      };
    }
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    };
  };

  const report = await run([
    "--input",
    temporaryRoot,
    "--output",
    outputDirectory,
    "--max-cases",
    "1",
    "--run-models",
  ]);
  const cases = await readFile(path.join(outputDirectory, "cases.jsonl"), "utf8");

  assert.equal(calls, 3);
  assert.equal(report.comparison.successfulCases, 1);
  assert.deepEqual(report.comparison.overall.winners, { with_visual: 1 });
  assert.equal(report.comparison.overall.withVisual.visualFactCoverage, 4);
  assert.ok(cases.includes('"title":"Visual summary"'));
  assert.ok(!cases.includes("PRIVATE_VISUAL_SOURCE_TEXT"));
});
