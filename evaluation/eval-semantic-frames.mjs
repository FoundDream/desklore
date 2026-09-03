import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { normalizeHistoryEvent, normalizeMetadata } from "../src/server/history/contracts.ts";
import { argumentsFrom } from "./eval-utils.mjs";

/**
 * Semantic frame replay.
 *
 * Replays retained segments through the current frame extractor and reports, without any
 * source text, how much of the rendered Accessibility volume the frames keep, how often a frame
 * carries identity, content, and focus, and how the stored frames compare with a fresh replay.
 * Run it before and after changing region rules, surface tables, or frame limits; the optional
 * baseline comparison turns that into a regression check.
 */

const jiti = createJiti(import.meta.url);
const { SemanticFrameTracker } = await jiti.import("../src/server/history/semantic/tracker.ts");
const { summarizeSemanticFrame } = await jiti.import("../src/server/history/semantic/frame.ts");

export const reportSchemaVersion = 1;
export const evaluatorVersion = "semantic-frames-v1";
const defaultInputRoot = path.join(os.homedir(), "Library/Application Support/DeskLore/history");
const defaultRegressionThreshold = 0.01;

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rounded(value) {
  return value === null || value === undefined ? null : Number(value.toFixed(3));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort(
      (lhs, rhs) => rhs.count - lhs.count || String(lhs.value).localeCompare(String(rhs.value)),
    );
}

export async function readSegments(root) {
  const segmentsRoot = path.join(root, "segments");
  const quality = {
    directoriesRead: 0,
    completedSegments: 0,
    openSegmentsSkipped: 0,
    unreadableSegmentMetadata: 0,
    malformedLines: 0,
    invalidEventRows: 0,
  };
  const segments = [];
  let entries;
  try {
    entries = await readdir(segmentsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { segments, quality };
    throw error;
  }
  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    if (!entry.isDirectory()) continue;
    quality.directoriesRead += 1;
    const directory = path.join(segmentsRoot, entry.name);
    let metadata;
    try {
      metadata = normalizeMetadata(
        JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8")),
      );
    } catch {
      quality.unreadableSegmentMetadata += 1;
      continue;
    }
    if (!metadata.endedAt) {
      quality.openSegmentsSkipped += 1;
      continue;
    }
    const events = [];
    let raw = "";
    try {
      raw = await readFile(path.join(directory, metadata.eventsFile), "utf8");
    } catch {
      raw = "";
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        quality.malformedLines += 1;
        continue;
      }
      try {
        events.push(normalizeHistoryEvent(parsed));
      } catch {
        quality.invalidEventRows += 1;
      }
    }
    events.sort(
      (lhs, rhs) =>
        Date.parse(lhs.timestamp) - Date.parse(rhs.timestamp) || lhs.id.localeCompare(rhs.id),
    );
    quality.completedSegments += 1;
    segments.push({
      id: metadata.id,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      events,
    });
  }
  return { segments, quality };
}

function emptyBucket() {
  return {
    events: 0,
    withAccessibility: 0,
    structured: 0,
    legacyText: 0,
    framed: 0,
    unframedDeltas: 0,
    renderedTextBytes: 0,
    frameBytes: 0,
    summaryBytes: 0,
    identity: 0,
    content: 0,
    focus: 0,
    contentShares: [],
    surfaces: [],
    storedMatches: 0,
    storedDiffers: 0,
    storedMissing: 0,
  };
}

function record(bucket, event, replayed) {
  bucket.events += 1;
  const context = event.accessibility;
  if (!context) return;
  bucket.withAccessibility += 1;
  if (!context.tree && !context.delta) {
    bucket.legacyText += 1;
    return;
  }
  bucket.structured += 1;
  bucket.renderedTextBytes += Buffer.byteLength(context.text, "utf8");
  const frame = replayed.semantic;
  if (!frame) {
    bucket.unframedDeltas += 1;
    return;
  }
  bucket.framed += 1;
  bucket.frameBytes += encodedBytes(frame);
  bucket.summaryBytes += encodedBytes(summarizeSemanticFrame(frame));
  const identity = frame.identity;
  if (identity.title || identity.url || identity.path) bucket.identity += 1;
  if (frame.body.length > 0) bucket.content += 1;
  if (frame.focus?.text) bucket.focus += 1;
  const regionTotal = frame.regions.content + frame.regions.navigation + frame.regions.chrome;
  if (regionTotal > 0) bucket.contentShares.push(frame.regions.content / regionTotal);
  bucket.surfaces.push(frame.surface);
  if (!event.semantic) bucket.storedMissing += 1;
  else if (JSON.stringify(event.semantic) === JSON.stringify(frame)) bucket.storedMatches += 1;
  else bucket.storedDiffers += 1;
}

function summarize(bucket) {
  const shares = bucket.contentShares;
  return {
    events: bucket.events,
    withAccessibility: bucket.withAccessibility,
    structured: bucket.structured,
    legacyText: bucket.legacyText,
    framed: bucket.framed,
    unframedDeltas: bucket.unframedDeltas,
    renderedTextBytes: bucket.renderedTextBytes,
    frameBytes: bucket.frameBytes,
    summaryBytes: bucket.summaryBytes,
    frameToTextRatio: ratio(bucket.frameBytes, bucket.renderedTextBytes),
    summaryToTextRatio: ratio(bucket.summaryBytes, bucket.renderedTextBytes),
    identityCoverage: ratio(bucket.identity, bucket.framed),
    contentCoverage: ratio(bucket.content, bucket.framed),
    focusCoverage: ratio(bucket.focus, bucket.framed),
    meanContentShare: shares.length
      ? rounded(shares.reduce((sum, value) => sum + value, 0) / shares.length)
      : null,
    surfaces: tally(bucket.surfaces),
    stored: {
      matches: bucket.storedMatches,
      differs: bucket.storedDiffers,
      missing: bucket.storedMissing,
    },
  };
}

export function evaluateSegments(segments) {
  const totals = emptyBucket();
  const applications = new Map();
  const perSegment = [];
  for (const segment of segments) {
    const tracker = new SemanticFrameTracker();
    const bucket = emptyBucket();
    for (const event of segment.events) {
      const replayed = tracker.process(event);
      const key = event.application.bundleIdentifier;
      const application = applications.get(key) ?? {
        bundleIdentifier: key,
        name: event.application.name,
        bucket: emptyBucket(),
      };
      applications.set(key, application);
      record(totals, event, replayed);
      record(bucket, event, replayed);
      record(application.bucket, event, replayed);
    }
    perSegment.push({ id: segment.id, ...summarize(bucket) });
  }
  return {
    totals: summarize(totals),
    applications: [...applications.values()]
      .map(({ bundleIdentifier, name, bucket }) => ({
        bundleIdentifier,
        name,
        ...summarize(bucket),
      }))
      .sort(
        (lhs, rhs) =>
          rhs.events - lhs.events || lhs.bundleIdentifier.localeCompare(rhs.bundleIdentifier),
      ),
    segments: perSegment,
  };
}

const comparedMetrics = [
  "identityCoverage",
  "contentCoverage",
  "focusCoverage",
  "meanContentShare",
];

function metricDelta(current, baseline) {
  return current === null || baseline === null || current === undefined || baseline === undefined
    ? null
    : rounded(current - baseline);
}

export function compareWithBaseline(current, baseline, threshold = defaultRegressionThreshold) {
  const baselineApplications = new Map(
    (baseline.applications ?? []).map((item) => [item.bundleIdentifier, item]),
  );
  const regressions = [];
  const totals = {};
  for (const metric of comparedMetrics) {
    totals[metric] = metricDelta(current.totals[metric], baseline.totals?.[metric]);
  }
  const applications = current.applications.map((application) => {
    const previous = baselineApplications.get(application.bundleIdentifier);
    const deltas = {};
    for (const metric of comparedMetrics) {
      deltas[metric] = metricDelta(application[metric], previous?.[metric]);
      if (deltas[metric] !== null && deltas[metric] < -threshold) {
        regressions.push({
          bundleIdentifier: application.bundleIdentifier,
          metric,
          baseline: previous?.[metric] ?? null,
          current: application[metric],
          delta: deltas[metric],
        });
      }
    }
    return {
      bundleIdentifier: application.bundleIdentifier,
      framedDelta: previous ? application.framed - previous.framed : null,
      ...deltas,
    };
  });
  return {
    baselineGeneratedAt: baseline.generatedAt ?? null,
    baselineEvaluatorVersion: baseline.evaluatorVersion ?? null,
    threshold,
    totals,
    applications,
    regressions,
  };
}

function percent(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(report) {
  const totals = report.totals;
  const lines = [
    "# Semantic frame replay",
    "",
    `Generated at ${report.generatedAt}. Input: ${report.input.root}.`,
    `Segments: ${report.input.segmentIDs.length} complete, ${report.input.quality.openSegmentsSkipped} open skipped.`,
    "",
    "## Totals",
    "",
    `- Events: ${totals.events}; with Accessibility: ${totals.withAccessibility}; structured: ${totals.structured}; legacy text only: ${totals.legacyText}.`,
    `- Framed: ${totals.framed}; deltas without a base: ${totals.unframedDeltas}.`,
    `- Rendered text ${totals.renderedTextBytes} bytes; frames ${totals.frameBytes} bytes (${percent(totals.frameToTextRatio)}); summaries ${totals.summaryBytes} bytes (${percent(totals.summaryToTextRatio)}).`,
    `- Identity ${percent(totals.identityCoverage)}; content ${percent(totals.contentCoverage)}; focus ${percent(totals.focusCoverage)}; mean content share ${percent(totals.meanContentShare)}.`,
    `- Stored frames: ${totals.stored.matches} match replay, ${totals.stored.differs} differ, ${totals.stored.missing} missing.`,
    "",
    "## Applications",
    "",
    "| Application | Events | Framed | Identity | Content | Focus | Content share | Summary/text | Surfaces |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.applications.map(
      (item) =>
        `| ${item.name} (${item.bundleIdentifier}) | ${item.events} | ${item.framed} | ${percent(item.identityCoverage)} | ${percent(item.contentCoverage)} | ${percent(item.focusCoverage)} | ${percent(item.meanContentShare)} | ${percent(item.summaryToTextRatio)} | ${item.surfaces.map((entry) => `${entry.value}:${entry.count}`).join(", ")} |`,
    ),
  ];
  if (report.comparison) {
    lines.push("", "## Baseline comparison", "");
    lines.push(
      `Baseline generated at ${report.comparison.baselineGeneratedAt ?? "unknown"}; regression threshold ${report.comparison.threshold}.`,
    );
    if (!report.comparison.regressions.length) {
      lines.push("", "No per-application coverage regressions.");
    } else {
      lines.push(
        "",
        "| Application | Metric | Baseline | Current | Delta |",
        "| --- | --- | ---: | ---: | ---: |",
      );
      for (const item of report.comparison.regressions) {
        lines.push(
          `| ${item.bundleIdentifier} | ${item.metric} | ${percent(item.baseline)} | ${percent(item.current)} | ${percent(item.delta)} |`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function evaluateSemanticFrames(options = {}) {
  const root = path.resolve(options.root ?? defaultInputRoot);
  const { segments, quality } = await readSegments(root);
  const evaluated = evaluateSegments(segments);
  const report = {
    schemaVersion: reportSchemaVersion,
    evaluatorVersion,
    generatedAt: new Date().toISOString(),
    input: {
      root,
      segmentIDs: segments.map((segment) => segment.id),
      quality,
    },
    ...evaluated,
  };
  if (options.baseline) {
    const baseline = JSON.parse(await readFile(path.resolve(options.baseline), "utf8"));
    report.comparison = compareWithBaseline(report, baseline, options.regressionThreshold);
  }
  return report;
}

export async function writeReport(report, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(outputDirectory, "report.md"), renderMarkdown(report), { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(outputDirectory, 0o700),
    chmod(path.join(outputDirectory, "report.json"), 0o600),
    chmod(path.join(outputDirectory, "report.md"), 0o600),
  ]);
}

export async function run(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  const outputDirectory = path.resolve(args.get("output") ?? ".eval-data/semantic-frames");
  const threshold = args.has("regression-threshold")
    ? Number(args.get("regression-threshold"))
    : defaultRegressionThreshold;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error("--regression-threshold must be a non-negative number");
  }
  const report = await evaluateSemanticFrames({
    root: args.get("root"),
    baseline: args.get("baseline"),
    regressionThreshold: threshold,
  });
  await writeReport(report, outputDirectory);
  console.info(renderMarkdown(report));
  console.info(`Report written to ${outputDirectory}`);
  if (report.comparison?.regressions.length && argv.includes("--fail-on-regression")) {
    process.exitCode = 2;
  }
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await run();
