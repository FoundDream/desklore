import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const secretPattern =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi;
const sensitiveSystemBundles = new Set([
  "com.apple.loginwindow",
  "com.apple.SecurityAgent",
  "com.apple.ScreenSaver.Engine",
]);
const defaultExcludedBundles = new Set([
  "com.github.Electron",
  "com.ziwen.computer-history.desktop",
]);

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--") && value && !value.startsWith("--")) {
      values.set(key.slice(2), value);
      index += 1;
    }
  }
  return values;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function objectFromCounts(map) {
  return Object.fromEntries([...map.entries()].sort((lhs, rhs) => rhs[1] - lhs[1]));
}

export function normalizedEvent(value, source) {
  const candidate = source === "candidate";
  const application = candidate ? value.application : value.app;
  return {
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    app: application?.name ?? value.application?.name ?? value.app?.name ?? "<missing>",
    bundleIdentifier:
      application?.bundleIdentifier ??
      application?.bundle_identifier ??
      value.application?.bundleIdentifier ??
      value.application?.bundle_identifier ??
      value.app?.bundleIdentifier,
    url: typeof value.window?.url === "string" ? value.window.url : undefined,
    axText:
      (candidate ? value.accessibility?.text : value.ax?.text) ??
      value.accessibility?.text ??
      value.ax?.text,
    raw: value,
  };
}

async function readDataset(root, source) {
  const segmentsRoot = path.join(root, "segments");
  const entries = await readdir(segmentsRoot, { withFileTypes: true });
  const segments = [];
  const events = [];
  let bytes = 0;
  let malformedLines = 0;
  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(segmentsRoot, entry.name);
    const metadataPath = path.join(directory, "metadata.json");
    const eventsPath = path.join(directory, "events.jsonl");
    let metadata;
    let contents;
    try {
      [metadata, contents] = await Promise.all([
        readFile(metadataPath, "utf8").then(JSON.parse),
        readFile(eventsPath, "utf8"),
      ]);
    } catch {
      continue;
    }
    const completed = Boolean(metadata.ended_at ?? metadata.endedAt);
    const segmentEvents = [];
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        segmentEvents.push(normalizedEvent(JSON.parse(line), source));
      } catch {
        malformedLines += 1;
      }
    }
    bytes += Buffer.byteLength(contents);
    segments.push({
      id: entry.name,
      completed,
      metadata,
      events: segmentEvents.length,
      bytes: Buffer.byteLength(contents),
    });
    events.push(...segmentEvents.map((event) => ({ ...event, segmentID: entry.name })));
  }
  return { root, segments, events, bytes, malformedLines };
}

function multisetIntersection(lhs, rhs, key) {
  const counts = new Map();
  for (const item of rhs) increment(counts, key(item));
  let matches = 0;
  for (const item of lhs) {
    const value = key(item);
    const remaining = counts.get(value) ?? 0;
    if (remaining > 0) {
      matches += 1;
      counts.set(value, remaining - 1);
    }
  }
  return matches;
}

function appIdentity(event) {
  return event.bundleIdentifier || event.app;
}

function eventKey(event) {
  return `${event.kind}\u001f${appIdentity(event)}`;
}

export function tolerantMatchCount(lhs, rhs, toleranceMilliseconds) {
  const leftByStream = new Map();
  const rightByStream = new Map();
  for (const event of lhs) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const key = eventKey(event);
    const values = leftByStream.get(key) ?? [];
    values.push(timestamp);
    leftByStream.set(key, values);
  }
  for (const event of rhs) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const key = eventKey(event);
    const values = rightByStream.get(key) ?? [];
    values.push(timestamp);
    rightByStream.set(key, values);
  }

  let matches = 0;
  for (const [key, leftValues] of leftByStream) {
    const rightValues = rightByStream.get(key);
    if (!rightValues) continue;
    leftValues.sort((lhsValue, rhsValue) => lhsValue - rhsValue);
    rightValues.sort((lhsValue, rhsValue) => lhsValue - rhsValue);
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftValues.length && rightIndex < rightValues.length) {
      const delta = leftValues[leftIndex] - rightValues[rightIndex];
      if (Math.abs(delta) <= toleranceMilliseconds) {
        matches += 1;
        leftIndex += 1;
        rightIndex += 1;
      } else if (delta < 0) {
        leftIndex += 1;
      } else {
        rightIndex += 1;
      }
    }
  }
  return matches;
}

function score(matches, candidateCount, referenceCount) {
  const precision = matches / Math.max(1, candidateCount);
  const recall = matches / Math.max(1, referenceCount);
  return {
    matches,
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall),
    alignment: matches / Math.max(1, Math.min(candidateCount, referenceCount)),
  };
}

function selectedEvents(dataset, segmentIDs, excludedBundles) {
  return dataset.events.filter(
    (event) => segmentIDs.has(event.segmentID) && !excludedBundles.has(event.bundleIdentifier),
  );
}

function summarize(dataset, segmentIDs, excludedBundles) {
  const events = selectedEvents(dataset, segmentIDs, excludedBundles);
  const kinds = new Map();
  const apps = new Map();
  let axCharacters = 0;
  let queryRows = 0;
  let fragmentRows = 0;
  let redactionMarkers = 0;
  let secretPatternHits = 0;
  let sensitiveSystemRows = 0;
  for (const event of events) {
    increment(kinds, event.kind);
    increment(apps, event.app);
    axCharacters += typeof event.axText === "string" ? event.axText.length : 0;
    if (event.url?.includes("?")) queryRows += 1;
    if (event.url?.includes("#")) fragmentRows += 1;
    const serialized = JSON.stringify(event.raw);
    redactionMarkers += serialized.match(/\[REDACTED\]/g)?.length ?? 0;
    secretPattern.lastIndex = 0;
    secretPatternHits += [...serialized.matchAll(secretPattern)].length;
    if (sensitiveSystemBundles.has(event.bundleIdentifier)) sensitiveSystemRows += 1;
  }
  return {
    segments: segmentIDs.size,
    events: events.length,
    bytes: dataset.segments
      .filter((segment) => segmentIDs.has(segment.id))
      .reduce((total, segment) => total + segment.bytes, 0),
    earliest: events
      .map((event) => event.timestamp)
      .filter(Boolean)
      .sort((lhs, rhs) => lhs.localeCompare(rhs))[0],
    latest: events
      .map((event) => event.timestamp)
      .filter(Boolean)
      .sort((lhs, rhs) => lhs.localeCompare(rhs))
      .at(-1),
    malformedLines: dataset.malformedLines,
    kinds: objectFromCounts(kinds),
    topApps: Object.fromEntries(Object.entries(objectFromCounts(apps)).slice(0, 15)),
    axCharacters,
    privacy: {
      queryRows,
      fragmentRows,
      redactionMarkers,
      secretPatternHits,
      sensitiveSystemRows,
    },
  };
}

export function evaluateEvents(candidateEvents, referenceEvents, toleranceMilliseconds) {
  const exactKey = (event) => `${event.timestamp}\u001f${event.kind}\u001f${appIdentity(event)}`;
  const exactMatches = multisetIntersection(candidateEvents, referenceEvents, exactKey);
  const tolerantMatches = tolerantMatchCount(
    candidateEvents,
    referenceEvents,
    toleranceMilliseconds,
  );
  const kinds = new Set([
    ...candidateEvents.map((event) => event.kind),
    ...referenceEvents.map((event) => event.kind),
  ]);
  const byKind = {};
  for (const kind of [...kinds].sort((lhs, rhs) => lhs.localeCompare(rhs))) {
    const candidateKindEvents = candidateEvents.filter((event) => event.kind === kind);
    const referenceKindEvents = referenceEvents.filter((event) => event.kind === kind);
    byKind[kind] = {
      candidate: candidateKindEvents.length,
      reference: referenceKindEvents.length,
      ...score(
        tolerantMatchCount(candidateKindEvents, referenceKindEvents, toleranceMilliseconds),
        candidateKindEvents.length,
        referenceKindEvents.length,
      ),
    };
  }
  return {
    exact: score(exactMatches, candidateEvents.length, referenceEvents.length),
    tolerant: score(tolerantMatches, candidateEvents.length, referenceEvents.length),
    byKind,
  };
}

function evaluateSlice(
  candidateDataset,
  referenceDataset,
  segmentIDs,
  excludedBundles,
  toleranceMilliseconds,
) {
  const candidateEvents = selectedEvents(candidateDataset, segmentIDs, excludedBundles);
  const referenceEvents = selectedEvents(referenceDataset, segmentIDs, excludedBundles);
  return {
    commonCompletedSegments: segmentIDs.size,
    segmentIDs: [...segmentIDs].sort((lhs, rhs) => lhs.localeCompare(rhs)),
    candidate: summarize(candidateDataset, segmentIDs, excludedBundles),
    reference: summarize(referenceDataset, segmentIDs, excludedBundles),
    matches: evaluateEvents(candidateEvents, referenceEvents, toleranceMilliseconds),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function sliceMarkdown(title, slice, toleranceMilliseconds) {
  const rows = Object.entries(slice.matches.byKind)
    .map(
      ([kind, value]) =>
        `| ${kind} | ${value.candidate} | ${value.reference} | ${value.matches} | ${percent(value.precision)} | ${percent(value.recall)} | ${percent(value.f1)} |`,
    )
    .join("\n");
  return (
    `## ${title}\n\n` +
    `- Common completed segments: ${slice.commonCompletedSegments}\n` +
    `- Candidate events: ${slice.candidate.events}\n` +
    `- Reference events: ${slice.reference.events}\n` +
    `- Exact timestamp/kind/app matches: ${slice.matches.exact.matches} (F1 ${percent(slice.matches.exact.f1)})\n` +
    `- ±${toleranceMilliseconds} ms kind/app matches: ${slice.matches.tolerant.matches} (precision ${percent(slice.matches.tolerant.precision)}, recall ${percent(slice.matches.tolerant.recall)}, F1 ${percent(slice.matches.tolerant.f1)})\n\n` +
    `| Event kind | Candidate | Reference | ± tolerance matches | Precision | Recall | F1 |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n`
  );
}

function privacyMarkdown(candidate, reference) {
  return (
    `## Privacy signals (overall)\n\n` +
    `| Signal | Candidate | Reference |\n| --- | ---: | ---: |\n` +
    `| URL query rows | ${candidate.privacy.queryRows} | ${reference.privacy.queryRows} |\n` +
    `| URL fragment rows | ${candidate.privacy.fragmentRows} | ${reference.privacy.fragmentRows} |\n` +
    `| Redaction markers | ${candidate.privacy.redactionMarkers} | ${reference.privacy.redactionMarkers} |\n` +
    `| Secret-pattern signals | ${candidate.privacy.secretPatternHits} | ${reference.privacy.secretPatternHits} |\n` +
    `| Sensitive system rows | ${candidate.privacy.sensitiveSystemRows} | ${reference.privacy.sensitiveSystemRows} |\n`
  );
}

function markdown(report) {
  return (
    `# Computer History paired evaluation\n\nGenerated at ${report.generatedAt}.\n\n` +
    `Matching uses bundle identifier when available and app name as fallback. ` +
    `Excluded bundles: ${report.excludedBundles.join(", ") || "none"}.\n\n` +
    sliceMarkdown(
      `Recent ${report.recent.commonCompletedSegments} completed segments`,
      report.recent,
      report.toleranceMilliseconds,
    ) +
    `\n` +
    sliceMarkdown("Overall retained data", report.overall, report.toleranceMilliseconds) +
    `\n` +
    privacyMarkdown(report.overall.candidate, report.overall.reference)
  );
}

function completedSegmentIDs(dataset) {
  return new Set(
    dataset.segments.filter((segment) => segment.completed).map((segment) => segment.id),
  );
}

function segmentStartedAt(dataset, id) {
  const segment = dataset.segments.find((item) => item.id === id);
  return Date.parse(segment?.metadata?.started_at ?? segment?.metadata?.startedAt ?? "");
}

export async function run(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  const candidateRoot = path.resolve(
    args.get("candidate") ??
      path.join(os.homedir(), "Library/Application Support/ComputerHistoryDesktop"),
  );
  const referenceRootValue = args.get("reference") ?? process.env.CODEX_COMPUTER_HISTORY_ROOT;
  if (!referenceRootValue) {
    throw new Error("Pass --reference <Skysight root> or set CODEX_COMPUTER_HISTORY_ROOT.");
  }
  const referenceRoot = path.resolve(referenceRootValue);
  const toleranceMilliseconds = Math.max(
    0,
    Number.parseInt(args.get("tolerance-ms") ?? "2000", 10) || 0,
  );
  const recentSegmentCount = Math.max(
    1,
    Number.parseInt(args.get("recent-segments") ?? "12", 10) || 12,
  );
  const excludedBundles = new Set(defaultExcludedBundles);
  for (const bundle of (args.get("exclude-bundles") ?? "").split(",")) {
    if (bundle.trim()) excludedBundles.add(bundle.trim());
  }
  const sinceValue = args.get("since");
  const since = sinceValue ? Date.parse(sinceValue) : Number.NaN;
  if (sinceValue && !Number.isFinite(since)) {
    throw new Error(`Invalid --since value: ${sinceValue}`);
  }

  const [candidateDataset, referenceDataset] = await Promise.all([
    readDataset(candidateRoot, "candidate"),
    readDataset(referenceRoot, "reference"),
  ]);
  const candidateCompleted = completedSegmentIDs(candidateDataset);
  const referenceCompleted = completedSegmentIDs(referenceDataset);
  const commonIDs = [...candidateCompleted]
    .filter((id) => referenceCompleted.has(id))
    .filter(
      (id) =>
        !Number.isFinite(since) ||
        Math.max(segmentStartedAt(candidateDataset, id), segmentStartedAt(referenceDataset, id)) >=
          since,
    )
    .sort((lhs, rhs) => lhs.localeCompare(rhs));
  const overallIDs = new Set(commonIDs);
  const recentIDs = new Set(commonIDs.slice(-recentSegmentCount));
  const overall = evaluateSlice(
    candidateDataset,
    referenceDataset,
    overallIDs,
    excludedBundles,
    toleranceMilliseconds,
  );
  const recent = evaluateSlice(
    candidateDataset,
    referenceDataset,
    recentIDs,
    excludedBundles,
    toleranceMilliseconds,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    toleranceMilliseconds,
    excludedBundles: [...excludedBundles].sort((lhs, rhs) => lhs.localeCompare(rhs)),
    since: Number.isFinite(since) ? new Date(since).toISOString() : undefined,
    recentSegmentLimit: recentSegmentCount,
    overall,
    recent,
    // Compatibility with reports produced before the evaluator added slices.
    commonCompletedSegments: overall.commonCompletedSegments,
    candidate: overall.candidate,
    reference: overall.reference,
    matches: {
      timestampKindApp: overall.matches.exact.matches,
      alignment: overall.matches.exact.alignment,
      tolerantTimestampKindApp: overall.matches.tolerant.matches,
      tolerantF1: overall.matches.tolerant.f1,
    },
  };

  const outputDirectory = path.resolve(args.get("output") ?? ".eval-data/history");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const rendered = markdown(report);
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(outputDirectory, "report.md"), rendered, { mode: 0o600 }),
  ]);
  process.stdout.write(`${rendered}\n`);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await run();
}
