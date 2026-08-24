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
  assert.equal(blindTimelineArm(segmentID), blindTimelineArm(segmentID));
});

void test("manifest-only mode writes hashes and IDs without source event payloads", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const report = await run(["--input", root, "--output", output, "--max-cases", "1"]);
  const artifacts = await Promise.all(
    ["report.json", "report.md", "manifest.jsonl", "cases.jsonl", "human-review.jsonl"].map(
      (name) => readFile(path.join(output, name), "utf8"),
    ),
  );

  assert.equal(report.mode, "manifest_only");
  assert.equal(report.selection.selectedCases, 1);
  assert.ok(artifacts.every((contents) => !contents.includes("PRIVATE_SOURCE_SENTINEL")));
  assert.equal((await stat(path.join(output, "report.json"))).mode & 0o777, 0o600);
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
