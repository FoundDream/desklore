import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aggregateTimelineResults,
  blindTimelineArm,
  run,
  validateTimelineSummary,
} from "./eval-timeline.mjs";

const segmentID = "2026-08-22T12-00-00Z";
const eventID = "11111111-1111-4111-8111-111111111111";
const secondEventID = "22222222-2222-4222-8222-222222222222";
let piResponseIndex = 0;

function piToolResponse(name, argumentsValue) {
  piResponseIndex += 1;
  const id = piResponseIndex;
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: JSON.stringify(argumentsValue),
    status: "completed",
  };
  const response = {
    id: `resp_${id}`,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function summary(title) {
  return {
    title,
    description: `${title} description`,
    continuationHint: "",
    claims: [{ text: `${title} claim`, evidenceEventIDs: [eventID] }],
    evidenceEventIDs: [eventID],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-timeline-eval-"));
  const directory = path.join(root, "segments", segmentID);
  await mkdir(directory, { recursive: true });
  const event = {
    id: eventID,
    timestamp: "2026-08-22T12:00:01.000Z",
    kind: "window.changed",
    application: { bundleIdentifier: "com.example.editor", name: "Editor" },
    window: {
      title: "PRIVATE_SOURCE_SENTINEL",
      isPrivateBrowsing: false,
    },
  };
  await Promise.all([
    writeFile(
      path.join(directory, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: segmentID,
        startedAt: "2026-08-22T12:00:00.000Z",
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
    writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`),
  ]);
  return root;
}

void test("validates summary citations against the selected same-evidence IDs", () => {
  assert.equal(validateTimelineSummary(summary("A"), [eventID]).claims.length, 1);
  assert.throws(
    () =>
      validateTimelineSummary({ ...summary("A"), evidenceEventIDs: ["uninspected"] }, [eventID]),
    /summary_invalid_fields_or_evidence/,
  );
  assert.throws(
    () =>
      validateTimelineSummary({ ...summary("A"), evidenceEventIDs: [eventID, secondEventID] }, [
        eventID,
        secondEventID,
      ]),
    /summary_evidence_union_mismatch/,
  );
  assert.equal(blindTimelineArm(segmentID), blindTimelineArm(segmentID));
});

void test("manifest-only mode writes hashes and IDs without source event payloads", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const report = await run(["--input", root, "--output", output, "--segment-ids", segmentID]);
  const artifacts = await Promise.all(
    ["report.json", "report.md", "manifest.jsonl", "cases.jsonl", "human-review.jsonl"].map(
      (name) => readFile(path.join(output, name), "utf8"),
    ),
  );

  assert.equal(report.mode, "manifest_only");
  assert.equal(report.selection.selectedCases, 1);
  assert.equal(report.selection.mode, "explicit");
  assert.deepEqual(report.input.selectedSegmentIDs, [segmentID]);
  assert.ok(artifacts.every((contents) => !contents.includes("PRIVATE_SOURCE_SENTINEL")));
  assert.equal((await stat(path.join(output, "report.json"))).mode & 0o777, 0o600);
  await assert.rejects(
    run(["--input", root, "--output", output, "--segment-ids", "missing-segment"]),
    /missing or incomplete/,
  );
});

void test("pairs two candidate files and produces a blind human-review template", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const manifestOutput = path.join(root, "manifest-output");
  const armA = path.join(root, "arm-a.jsonl");
  const armB = path.join(root, "arm-b.jsonl");
  await run(["--input", root, "--output", manifestOutput, "--max-cases", "1"]);
  const manifest = JSON.parse(
    (await readFile(path.join(manifestOutput, "manifest.jsonl"), "utf8")).trim(),
  );
  await Promise.all([
    writeFile(
      armA,
      `${JSON.stringify({ segmentID, evidenceHash: manifest.evidenceHash, summary: summary("Current") })}\n`,
    ),
    writeFile(
      armB,
      `${JSON.stringify({ segmentID, evidenceHash: manifest.evidenceHash, summary: summary("Candidate") })}\n`,
    ),
  ]);

  const report = await run(["--input", root, "--output", output, "--arm-a", armA, "--arm-b", armB]);
  const review = JSON.parse(
    (await readFile(path.join(output, "human-review.jsonl"), "utf8")).trim(),
  );
  const cases = JSON.parse((await readFile(path.join(output, "cases.jsonl"), "utf8")).trim());

  assert.equal(report.mode, "paired_validation");
  assert.equal(report.comparison.pairedCases, 1);
  assert.equal(report.humanReview.pending, 1);
  assert.equal(review.segmentID, segmentID);
  assert.equal(review.review.winner, null);
  assert.equal(cases.deterministic.armA.citationsValid, true);
  assert.equal(cases.evidenceHash, review.evidenceHash);

  review.review = {
    winner: "a",
    threadCoverageA: 4,
    threadCoverageB: 1,
    factualSupportA: 4,
    factualSupportB: 1,
    continuityValueA: 3,
    continuityValueB: 2,
    citationSupportA: 4,
    citationSupportB: 2,
    notes: "reviewed locally",
  };
  const completedReviewPath = path.join(output, "human-review.jsonl");
  await writeFile(completedReviewPath, `${JSON.stringify(review)}\n`);
  const reviewedReport = await run([
    "--input",
    root,
    "--output",
    output,
    "--arm-a",
    armA,
    "--arm-b",
    armB,
    "--human-review",
    completedReviewPath,
  ]);
  const expectedWinner = blindTimelineArm(segmentID) === "a" ? "arm_a" : "arm_b";
  const expectedArmAScore = blindTimelineArm(segmentID) === "a" ? 4 : 1;
  assert.equal(reviewedReport.humanReview.completed, 1);
  assert.equal(reviewedReport.humanReview.pending, 0);
  assert.equal(reviewedReport.humanReview.invalidRows, 0);
  assert.deepEqual(reviewedReport.humanReview.winners, { [expectedWinner]: 1 });
  assert.equal(reviewedReport.humanReview.armA.threadCoverage, expectedArmAScore);
  assert.equal(
    JSON.parse((await readFile(completedReviewPath, "utf8")).trim()).review.notes,
    "reviewed locally",
  );
  assert.equal((await stat(path.join(output, "human-review-template.jsonl"))).mode & 0o777, 0o600);
});

void test("generates the current arm with the production timeline agent and runtime metrics", async (context) => {
  const root = await fixture();
  const output = path.join(root, "generated-output");
  const originalFetch = globalThis.fetch;
  const originalAPIKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  context.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalAPIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalAPIKey;
    await rm(root, { recursive: true, force: true });
  });
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    const toolOutput = request.input.find((item) => item.type === "function_call_output");
    if (!toolOutput) {
      return piToolResponse("read_events", {
        event_ids: [eventID],
        include_accessibility: true,
      });
    }
    return piToolResponse("submit_timeline", {
      title: "Generated current",
      description: "A supported generated summary.",
      continuation_hint: "Continue the task.",
      claims: [{ text: "The editor was active.", evidence_event_ids: [eventID] }],
    });
  };

  const report = await run([
    "--input",
    root,
    "--output",
    output,
    "--segment-ids",
    segmentID,
    "--generate-current",
    "--model",
    "test-model",
    "--endpoint",
    "https://example.com/v1/responses?secret=hidden",
  ]);
  const generated = await readFile(path.join(output, "generated-current.jsonl"), "utf8");

  assert.equal(calls, 2);
  assert.equal(report.mode, "generated_current");
  assert.equal(report.generation.succeededCases, 1);
  assert.equal(report.generation.runtime.turns, 2);
  assert.equal(report.generation.runtime.providerRequests, 2);
  assert.deepEqual(report.generation.runtime.toolCalls, { read_events: 1, submit_timeline: 1 });
  assert.equal(report.models.generation.endpoint, "https://example.com/v1/responses");
  assert.ok(generated.includes('"title":"Generated current"'));
  assert.ok(!generated.includes("PRIVATE_SOURCE_SENTINEL"));
  assert.equal((await stat(path.join(output, "generated-current.jsonl"))).mode & 0o777, 0o600);
});

void test("aggregates automatic judge results without counting failures", () => {
  const judgment = {
    scores: {
      armA: {
        thread_coverage: 4,
        factual_support: 4,
        continuity_value: 3,
        citation_support: 4,
        focus: 3,
        unsupported_claims: 0,
        incidental_details: 1,
      },
      armB: {
        thread_coverage: 2,
        factual_support: 3,
        continuity_value: 2,
        citation_support: 3,
        focus: 2,
        unsupported_claims: 1,
        incidental_details: 2,
      },
    },
    blind: { winner: "arm_a" },
    modelUsage: { inputTokens: 100, outputTokens: 20 },
  };
  const result = aggregateTimelineResults([{ judgment }, { error: "model_refusal" }]);
  assert.equal(result.judgedCases, 1);
  assert.equal(result.failedCases, 1);
  assert.deepEqual(result.winners, { arm_a: 1 });
  assert.equal(result.armA.thread_coverage, 4);
  assert.equal(result.modelUsage.calls, 1);
});
