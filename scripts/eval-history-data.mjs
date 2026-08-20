import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const secretPattern =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi;
const sensitiveSystemBundles = new Set([
  "com.apple.loginwindow",
  "com.apple.SecurityAgent",
  "com.apple.ScreenSaver.Engine",
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

function normalizedEvent(value, source) {
  const candidate = source === "candidate";
  return {
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    app:
      (candidate ? value.application?.name : value.app?.name) ??
      value.application?.name ??
      value.app?.name ??
      "<missing>",
    bundleIdentifier:
      (candidate
        ? (value.application?.bundle_identifier ?? value.application?.bundleIdentifier)
        : value.app?.bundleIdentifier) ??
      value.application?.bundle_identifier ??
      value.application?.bundleIdentifier ??
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

function summarize(dataset, segmentIDs) {
  const events = dataset.events.filter((event) => !segmentIDs || segmentIDs.has(event.segmentID));
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
    segments: segmentIDs?.size ?? dataset.segments.length,
    events: events.length,
    bytes: segmentIDs
      ? dataset.segments
          .filter((segment) => segmentIDs.has(segment.id))
          .reduce((total, segment) => total + segment.bytes, 0)
      : dataset.bytes,
    earliest: events
      .map((event) => event.timestamp)
      .filter(Boolean)
      .sort()[0],
    latest: events
      .map((event) => event.timestamp)
      .filter(Boolean)
      .sort()
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

function markdown(report) {
  const kinds = new Set([
    ...Object.keys(report.candidate.kinds),
    ...Object.keys(report.reference.kinds),
  ]);
  const rows = [...kinds]
    .sort()
    .map(
      (kind) =>
        `| ${kind} | ${report.candidate.kinds[kind] ?? 0} | ${report.reference.kinds[kind] ?? 0} |`,
    )
    .join("\n");
  return (
    `# Computer History paired evaluation\n\nGenerated at ${report.generatedAt}.\n\n` +
    `- Common completed segments: ${report.commonCompletedSegments}\n` +
    `- Candidate events: ${report.candidate.events}\n` +
    `- Reference events: ${report.reference.events}\n` +
    `- timestamp/kind/app matches: ${report.matches.timestampKindApp}\n` +
    `- Alignment: ${(report.matches.alignment * 100).toFixed(1)}%\n\n` +
    `| Event kind | Candidate | Reference |\n| --- | ---: | ---: |\n${rows}\n\n` +
    `## Privacy signals\n\n` +
    `| Signal | Candidate | Reference |\n| --- | ---: | ---: |\n` +
    `| URL query rows | ${report.candidate.privacy.queryRows} | ${report.reference.privacy.queryRows} |\n` +
    `| URL fragment rows | ${report.candidate.privacy.fragmentRows} | ${report.reference.privacy.fragmentRows} |\n` +
    `| Redaction markers | ${report.candidate.privacy.redactionMarkers} | ${report.reference.privacy.redactionMarkers} |\n` +
    `| Secret-pattern signals | ${report.candidate.privacy.secretPatternHits} | ${report.reference.privacy.secretPatternHits} |\n` +
    `| Sensitive system rows | ${report.candidate.privacy.sensitiveSystemRows} | ${report.reference.privacy.sensitiveSystemRows} |\n`
  );
}

const args = argumentsFrom(process.argv.slice(2));
const candidateRoot = path.resolve(
  args.get("candidate") ??
    path.join(os.homedir(), "Library/Application Support/ComputerHistoryDesktop"),
);
const referenceRootValue = args.get("reference") ?? process.env.CODEX_COMPUTER_HISTORY_ROOT;
if (!referenceRootValue) {
  throw new Error("Pass --reference <Skysight root> or set CODEX_COMPUTER_HISTORY_ROOT.");
}
const referenceRoot = path.resolve(referenceRootValue);
const [candidateDataset, referenceDataset] = await Promise.all([
  readDataset(candidateRoot, "candidate"),
  readDataset(referenceRoot, "reference"),
]);
const candidateCompleted = new Set(
  candidateDataset.segments.filter((segment) => segment.completed).map((segment) => segment.id),
);
const referenceCompleted = new Set(
  referenceDataset.segments.filter((segment) => segment.completed).map((segment) => segment.id),
);
const common = new Set([...candidateCompleted].filter((id) => referenceCompleted.has(id)));
const candidateEvents = candidateDataset.events.filter((event) => common.has(event.segmentID));
const referenceEvents = referenceDataset.events.filter((event) => common.has(event.segmentID));
const key = (event) => `${event.timestamp}\u001f${event.kind}\u001f${event.app}`;
const timestampKindApp = multisetIntersection(candidateEvents, referenceEvents, key);
const report = {
  generatedAt: new Date().toISOString(),
  commonCompletedSegments: common.size,
  candidate: summarize(candidateDataset, common),
  reference: summarize(referenceDataset, common),
  matches: {
    timestampKindApp,
    alignment:
      timestampKindApp / Math.max(1, Math.min(candidateEvents.length, referenceEvents.length)),
  },
};

const outputDirectory = path.resolve(args.get("output") ?? ".eval-data/history");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  }),
  writeFile(path.join(outputDirectory, "report.md"), markdown(report), { mode: 0o600 }),
]);
process.stdout.write(`${markdown(report)}\n`);
