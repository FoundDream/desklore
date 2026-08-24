import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeHistoryEvent, normalizeMetadata } from "../src/main/history/types.ts";

const secretPattern =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi;
const sensitiveSystemBundles = new Set([
  "com.apple.loginwindow",
  "com.apple.SecurityAgent",
  "com.apple.ScreenSaver.Engine",
]);
const defaultExcludedBundles = new Set(["com.github.Electron", "com.desklore.desktop"]);
const reportSchemaVersion = 2;
const evaluatorVersion = "history-paired-v2";
const segmentDurationMilliseconds = 10 * 60 * 1_000;
const segmentBoundaryToleranceMilliseconds = 2_000;
const segmentStatuses = [
  "complete",
  "open",
  "partial_start",
  "partial_end",
  "invalid_metadata",
  "invalid_events",
  "unreadable",
];

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

function record(value) {
  return value !== null && typeof value === "object" ? value : undefined;
}

function string(value) {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").sort((lhs, rhs) => lhs.localeCompare(rhs))
    : undefined;
}

function present(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

function lengthBucket(value) {
  if (typeof value !== "string" || !value.trim()) return "none";
  if (value.length <= 16) return "1-16";
  if (value.length <= 64) return "17-64";
  if (value.length <= 256) return "65-256";
  return "257+";
}

function normalizedTarget(value) {
  const target = record(value);
  return {
    role: string(target?.role),
    subrole: string(target?.subrole ?? target?.subRole),
    identifier: string(target?.identifier),
    labelPresent: present(
      target?.title ?? target?.description ?? target?.placeholder ?? target?.label ?? target?.value,
    ),
  };
}

function referenceInteraction(value) {
  const source = record(value);
  const mouse = record(source?.mouse);
  const keyboard = record(source?.keyboard);
  const selection = record(source?.selection);
  const textInput = record(source?.textInput ?? source?.text_input);
  return {
    text: string(textInput?.text ?? keyboard?.text),
    selectedText: string(selection?.selectedText ?? selection?.selected_text),
    keyEquivalent: string(keyboard?.keyEquivalent ?? keyboard?.key_equivalent),
    modifiers: normalizedStringArray(keyboard?.modifiers),
    mouseButton: string(mouse?.button),
    clickCount: finiteNumber(mouse?.clickCount ?? mouse?.click_count),
    target: mouse?.target ?? keyboard?.target ?? selection?.target ?? textInput?.target,
  };
}

export function normalizedEvent(value, source) {
  const candidate = source === "candidate";
  const currentEvent = candidate ? normalizeHistoryEvent(value) : undefined;
  const reference = record(value);
  const application = currentEvent?.application ?? record(reference?.app);
  const captureReason = candidate
    ? currentEvent?.captureReason
    : (reference?.captureReason ?? reference?.capture_reason);
  const referenceAX = record(reference?.ax ?? reference?.accessibility);
  const interaction = candidate ? currentEvent?.interaction : referenceInteraction(reference);
  const target = normalizedTarget(candidate ? currentEvent?.target : interaction.target);
  const accessibilityMode = candidate
    ? currentEvent?.accessibility?.mode
    : string(referenceAX?.mode);
  const accessibilityText = candidate
    ? currentEvent?.accessibility?.text
    : string(referenceAX?.text);
  return {
    timestamp:
      typeof (currentEvent?.timestamp ?? reference?.timestamp) === "string"
        ? (currentEvent?.timestamp ?? reference?.timestamp)
        : "",
    kind:
      typeof (currentEvent?.kind ?? reference?.kind) === "string"
        ? (currentEvent?.kind ?? reference?.kind)
        : "unknown",
    app: application?.name ?? "<missing>",
    bundleIdentifier: application?.bundleIdentifier,
    occurrenceCount: candidate
      ? currentEvent?.occurrenceCount
      : finiteNumber(reference?.occurrenceCount),
    captureReason: typeof captureReason === "string" ? captureReason : undefined,
    url:
      typeof (currentEvent?.window?.url ?? record(reference?.window)?.url) === "string"
        ? (currentEvent?.window?.url ?? record(reference?.window)?.url)
        : undefined,
    axText: accessibilityText,
    semantics: {
      targetRole: target.role,
      targetSubrole: target.subrole,
      targetIdentifier: target.identifier,
      targetLabelPresent: target.labelPresent,
      keyEquivalent: interaction?.keyEquivalent,
      modifiers: normalizedStringArray(interaction?.modifiers),
      mouseButton: interaction?.mouseButton,
      clickCount: interaction?.clickCount,
      textPresent: present(interaction?.text),
      textLengthBucket: lengthBucket(interaction?.text),
      selectionPresent: present(interaction?.selectedText),
      selectionLengthBucket: lengthBucket(interaction?.selectedText),
      axPresent: present(accessibilityText),
      axMode: accessibilityMode,
    },
    raw: value,
  };
}

export function normalizedMetadata(value, source, directoryID) {
  if (source === "candidate") {
    const metadata = normalizeMetadata(value);
    return {
      id: metadata.id,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      eventCount: metadata.eventCount,
      raw: metadata,
    };
  }
  const metadata = record(value);
  const id = string(metadata?.id) ?? directoryID;
  const startedAt = string(metadata?.startedAt ?? metadata?.started_at);
  const endedAt = string(metadata?.endedAt ?? metadata?.ended_at);
  const eventCount = finiteNumber(metadata?.eventCount ?? metadata?.event_count);
  if (!id || !startedAt || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error("Invalid reference segment metadata");
  }
  return { id, startedAt, endedAt, eventCount, raw: value };
}

function expectedSegmentStart(id) {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(id);
  if (!matched) return Number.NaN;
  return Date.parse(`${matched[1]}T${matched[2]}:${matched[3]}:${matched[4]}Z`);
}

export function classifySegment({ metadata, directoryID, eventRows, malformedLines, readError }) {
  if (readError) return { status: "unreadable", reason: readError };
  if (!metadata) return { status: "invalid_metadata", reason: "metadata_not_normalized" };
  const startedAt = Date.parse(metadata.startedAt);
  const endedAt = Date.parse(metadata.endedAt ?? "");
  if (
    metadata.id !== directoryID ||
    !Number.isFinite(startedAt) ||
    (metadata.endedAt !== undefined && !Number.isFinite(endedAt)) ||
    (metadata.eventCount !== undefined &&
      (!Number.isInteger(metadata.eventCount) || metadata.eventCount < 0))
  ) {
    return { status: "invalid_metadata", reason: "metadata_fields_invalid" };
  }
  if (malformedLines > 0) {
    return { status: "invalid_events", reason: "malformed_event_rows" };
  }
  if (metadata.eventCount !== undefined && metadata.eventCount !== eventRows) {
    return { status: "invalid_events", reason: "metadata_event_count_mismatch" };
  }
  if (!metadata.endedAt) return { status: "open", reason: "missing_end_time" };
  if (endedAt <= startedAt) {
    return { status: "invalid_metadata", reason: "non_positive_duration" };
  }
  const expectedStart = expectedSegmentStart(directoryID);
  if (Number.isFinite(expectedStart)) {
    if (startedAt > expectedStart + segmentBoundaryToleranceMilliseconds) {
      return { status: "partial_start", reason: "started_after_bucket_boundary" };
    }
    if (
      endedAt <
      expectedStart + segmentDurationMilliseconds - segmentBoundaryToleranceMilliseconds
    ) {
      return { status: "partial_end", reason: "ended_before_bucket_boundary" };
    }
  }
  return { status: "complete" };
}

export async function readDataset(root, source) {
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
    let contents = "";
    let metadataContents;
    try {
      metadataContents = await readFile(metadataPath, "utf8");
    } catch (error) {
      segments.push({
        id: entry.name,
        status: "unreadable",
        statusReason: `metadata:${error instanceof Error ? error.name : "unknown_error"}`,
        events: 0,
        bytes: 0,
      });
      continue;
    }
    try {
      metadata = normalizedMetadata(JSON.parse(metadataContents), source, entry.name);
    } catch (error) {
      segments.push({
        id: entry.name,
        status: "invalid_metadata",
        statusReason: error instanceof Error ? error.message : "metadata_invalid",
        events: 0,
        bytes: 0,
      });
      continue;
    }
    try {
      contents = await readFile(eventsPath, "utf8");
    } catch (error) {
      segments.push({
        id: entry.name,
        status: "unreadable",
        statusReason: `events:${error instanceof Error ? error.name : "unknown_error"}`,
        startedAt: metadata.startedAt,
        metadata,
        events: 0,
        bytes: 0,
      });
      continue;
    }
    const segmentEvents = [];
    let segmentMalformedLines = 0;
    let eventRows = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      eventRows += 1;
      try {
        segmentEvents.push(normalizedEvent(JSON.parse(line), source));
      } catch {
        malformedLines += 1;
        segmentMalformedLines += 1;
      }
    }
    const classification = classifySegment({
      metadata,
      directoryID: entry.name,
      eventRows,
      malformedLines: segmentMalformedLines,
    });
    bytes += Buffer.byteLength(contents);
    segments.push({
      id: entry.name,
      status: classification.status,
      statusReason: classification.reason,
      completed: classification.status === "complete",
      startedAt: metadata.startedAt,
      metadata,
      events: segmentEvents.length,
      eventRows,
      malformedLines: segmentMalformedLines,
      bytes: Buffer.byteLength(contents),
    });
    events.push(...segmentEvents.map((event) => ({ ...event, segmentID: entry.name })));
  }
  const statusCounts = new Map(segmentStatuses.map((status) => [status, 0]));
  for (const segment of segments) increment(statusCounts, segment.status);
  return {
    root,
    segments,
    events,
    bytes,
    malformedLines,
    dataQuality: {
      segmentCount: segments.length,
      statusCounts: Object.fromEntries(statusCounts),
      issues: segments
        .filter((segment) => segment.status !== "complete")
        .map((segment) => ({
          segmentID: segment.id,
          status: segment.status,
          reason: segment.statusReason,
        })),
    },
  };
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

function isUnstableBundleIdentifier(value) {
  return typeof value === "string" && /^pid\.\d+$/.test(value);
}

function eventKey(event) {
  return `${event.kind}\u001f${appIdentity(event)}`;
}

export function tolerantMatchCount(lhs, rhs, toleranceMilliseconds) {
  return tolerantMatchPairs(lhs, rhs, toleranceMilliseconds).length;
}

export function tolerantMatchPairs(lhs, rhs, toleranceMilliseconds) {
  const leftByStream = new Map();
  const rightByStream = new Map();
  for (const event of lhs) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const key = eventKey(event);
    const values = leftByStream.get(key) ?? [];
    values.push({ event, timestamp });
    leftByStream.set(key, values);
  }
  for (const event of rhs) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const key = eventKey(event);
    const values = rightByStream.get(key) ?? [];
    values.push({ event, timestamp });
    rightByStream.set(key, values);
  }

  const pairs = [];
  for (const [key, leftValues] of leftByStream) {
    const rightValues = rightByStream.get(key);
    if (!rightValues) continue;
    leftValues.sort((lhsValue, rhsValue) => lhsValue.timestamp - rhsValue.timestamp);
    rightValues.sort((lhsValue, rhsValue) => lhsValue.timestamp - rhsValue.timestamp);
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftValues.length && rightIndex < rightValues.length) {
      const delta = leftValues[leftIndex].timestamp - rightValues[rightIndex].timestamp;
      if (Math.abs(delta) <= toleranceMilliseconds) {
        pairs.push({
          candidate: leftValues[leftIndex].event,
          reference: rightValues[rightIndex].event,
          latencyMilliseconds: delta,
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (delta < 0) {
        leftIndex += 1;
      } else {
        rightIndex += 1;
      }
    }
  }
  return pairs;
}

function percentile(values, ratio) {
  if (!values.length) return undefined;
  const ordered = [...values].sort((lhs, rhs) => lhs - rhs);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

function duplicateBurstSummary(events, windowMilliseconds = 100) {
  const byStream = new Map();
  let burstRows = 0;
  let representedOccurrences = 0;
  for (const event of events) {
    representedOccurrences += Math.max(1, event.occurrenceCount ?? 1);
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const key = eventKey(event);
    const previous = byStream.get(key);
    if (previous !== undefined && timestamp - previous <= windowMilliseconds) burstRows += 1;
    byStream.set(key, timestamp);
  }
  return {
    eventRows: events.length,
    representedOccurrences,
    burstRows,
    burstRatio: burstRows / Math.max(1, events.length),
    coalescedOccurrences: Math.max(0, representedOccurrences - events.length),
  };
}

function comparableValue(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function semanticAgreement(pairs) {
  const fields = [
    "targetRole",
    "targetSubrole",
    "targetIdentifier",
    "targetLabelPresent",
    "keyEquivalent",
    "modifiers",
    "mouseButton",
    "clickCount",
    "textPresent",
    "textLengthBucket",
    "selectionPresent",
    "selectionLengthBucket",
    "axPresent",
    "axMode",
  ];
  const agreement = Object.fromEntries(
    fields.map((field) => [field, { compared: 0, agreed: 0, agreement: undefined }]),
  );
  const mismatches = new Map();
  for (const pair of pairs) {
    for (const field of fields) {
      const candidate = comparableValue(pair.candidate.semantics?.[field]);
      const reference = comparableValue(pair.reference.semantics?.[field]);
      if (candidate === undefined && reference === undefined) continue;
      const metric = agreement[field];
      metric.compared += 1;
      if (candidate === reference) {
        metric.agreed += 1;
      } else {
        increment(
          mismatches,
          `${pair.candidate.kind}\u001f${appIdentity(pair.candidate)}\u001f${field}`,
        );
      }
    }
  }
  for (const metric of Object.values(agreement)) {
    metric.agreement = metric.compared ? metric.agreed / metric.compared : undefined;
  }
  const topMismatches = [...mismatches.entries()]
    .map(([key, count]) => {
      const [kind, application, field] = key.split("\u001f");
      return { kind, application, field, count };
    })
    .sort((lhs, rhs) => rhs.count - lhs.count || lhs.field.localeCompare(rhs.field))
    .slice(0, 20);
  return { fields: agreement, topMismatches };
}

function pairedDiagnostics(candidateEvents, referenceEvents, toleranceMilliseconds) {
  const pairs = tolerantMatchPairs(candidateEvents, referenceEvents, toleranceMilliseconds);
  const absoluteLatencies = pairs.map((pair) => Math.abs(pair.latencyMilliseconds));
  return {
    matchedPairs: pairs.length,
    latencyMilliseconds: {
      p50: percentile(absoluteLatencies, 0.5),
      p95: percentile(absoluteLatencies, 0.95),
      maximum: absoluteLatencies.length ? Math.max(...absoluteLatencies) : undefined,
    },
    duplicateBursts: {
      candidate: duplicateBurstSummary(candidateEvents),
      reference: duplicateBurstSummary(referenceEvents),
    },
    semantics: semanticAgreement(pairs),
  };
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
    applicationCount: apps.size,
    applications: objectFromCounts(apps),
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

function datasetProvenance(dataset, source, recorderSettings, generatedAt) {
  const timestamps = dataset.segments
    .flatMap((segment) => [segment.startedAt, segment.metadata?.endedAt])
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((lhs, rhs) => lhs.localeCompare(rhs));
  const latest = timestamps.at(-1);
  return {
    source,
    adapter: source === "candidate" ? "desklore-segment-v1" : "skysight-flex-v1",
    recorderSettings: recorderSettings?.slice(0, 200) || "not_supplied",
    segmentCount: dataset.segments.length,
    bytes: dataset.bytes,
    clockRange: { earliest: timestamps[0], latest },
    datasetAgeMilliseconds: latest
      ? Math.max(0, Date.parse(generatedAt) - Date.parse(latest))
      : undefined,
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

export function diagnosticSummary(candidateEvents, referenceEvents, toleranceMilliseconds) {
  const segmentIDs = new Set([
    ...candidateEvents.map((event) => event.segmentID).filter(Boolean),
    ...referenceEvents.map((event) => event.segmentID).filter(Boolean),
  ]);
  const perSegment = [...segmentIDs]
    .sort((lhs, rhs) => lhs.localeCompare(rhs))
    .map((segmentID) => {
      const candidate = candidateEvents.filter((event) => event.segmentID === segmentID);
      const reference = referenceEvents.filter((event) => event.segmentID === segmentID);
      return {
        segmentID,
        candidate: candidate.length,
        reference: reference.length,
        ...evaluateEvents(candidate, reference, toleranceMilliseconds).tolerant,
      };
    });

  const streamKeys = new Set([...candidateEvents.map(eventKey), ...referenceEvents.map(eventKey)]);
  const largestStreamGaps = [...streamKeys]
    .map((key) => {
      const separator = key.indexOf("\u001f");
      const kind = key.slice(0, separator);
      const application = key.slice(separator + 1);
      const candidate = candidateEvents.filter((event) => eventKey(event) === key);
      const reference = referenceEvents.filter((event) => eventKey(event) === key);
      const matches = tolerantMatchCount(candidate, reference, toleranceMilliseconds);
      return {
        kind,
        application,
        candidate: candidate.length,
        reference: reference.length,
        difference: candidate.length - reference.length,
        ...score(matches, candidate.length, reference.length),
      };
    })
    .sort(
      (lhs, rhs) =>
        Math.abs(rhs.difference) - Math.abs(lhs.difference) ||
        rhs.candidate + rhs.reference - (lhs.candidate + lhs.reference),
    )
    .slice(0, 20);

  const captureReasons = { candidate: new Map(), reference: new Map() };
  for (const event of candidateEvents) {
    increment(captureReasons.candidate, `${event.kind} / ${event.captureReason ?? "<missing>"}`);
  }
  for (const event of referenceEvents) {
    increment(captureReasons.reference, `${event.kind} / ${event.captureReason ?? "<missing>"}`);
  }
  const unstableApplications = { candidate: new Map(), reference: new Map() };
  for (const event of candidateEvents) {
    if (isUnstableBundleIdentifier(event.bundleIdentifier)) {
      increment(unstableApplications.candidate, `${event.bundleIdentifier} / ${event.app}`);
    }
  }
  for (const event of referenceEvents) {
    if (isUnstableBundleIdentifier(event.bundleIdentifier)) {
      increment(unstableApplications.reference, `${event.bundleIdentifier} / ${event.app}`);
    }
  }
  const candidateKinds = new Set(candidateEvents.map((event) => event.kind));
  const referenceOnlyKinds = new Map();
  for (const event of referenceEvents) {
    if (!candidateKinds.has(event.kind)) increment(referenceOnlyKinds, event.kind);
  }

  return {
    perSegment,
    largestStreamGaps,
    captureReasons: {
      candidate: objectFromCounts(captureReasons.candidate),
      reference: objectFromCounts(captureReasons.reference),
    },
    unstableApplications: {
      candidate: objectFromCounts(unstableApplications.candidate),
      reference: objectFromCounts(unstableApplications.reference),
    },
    referenceOnlyKinds: objectFromCounts(referenceOnlyKinds),
    paired: pairedDiagnostics(candidateEvents, referenceEvents, toleranceMilliseconds),
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
    diagnostics: diagnosticSummary(candidateEvents, referenceEvents, toleranceMilliseconds),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function sliceMarkdown(title, slice, toleranceMilliseconds) {
  const rows = Object.entries(slice.matches.byKind)
    .map(
      ([kind, value]) =>
        `| ${kind} | ${value.candidate} | ${value.reference} | ${value.matches} | ${percent(value.precision)} | ${percent(value.recall)} | ${percent(value.f1)} |`,
    )
    .join("\n");
  const segmentRows = slice.diagnostics.perSegment
    .map(
      (value) =>
        `| ${markdownCell(value.segmentID)} | ${value.candidate} | ${value.reference} | ${percent(value.precision)} | ${percent(value.recall)} | ${percent(value.f1)} |`,
    )
    .join("\n");
  const streamGapRows = slice.diagnostics.largestStreamGaps
    .map(
      (value) =>
        `| ${markdownCell(value.kind)} | ${markdownCell(value.application)} | ${value.candidate} | ${value.reference} | ${value.difference} | ${percent(value.precision)} | ${percent(value.recall)} |`,
    )
    .join("\n");
  const captureReasonKeys = new Set([
    ...Object.keys(slice.diagnostics.captureReasons.candidate),
    ...Object.keys(slice.diagnostics.captureReasons.reference),
  ]);
  const captureReasonRows = [...captureReasonKeys]
    .sort(
      (lhs, rhs) =>
        (slice.diagnostics.captureReasons.candidate[rhs] ?? 0) -
        (slice.diagnostics.captureReasons.candidate[lhs] ?? 0),
    )
    .slice(0, 20)
    .map(
      (key) =>
        `| ${markdownCell(key)} | ${slice.diagnostics.captureReasons.candidate[key] ?? 0} | ${slice.diagnostics.captureReasons.reference[key] ?? 0} |`,
    )
    .join("\n");
  const semanticRows = Object.entries(slice.diagnostics.paired.semantics.fields)
    .filter(([, value]) => value.compared > 0)
    .map(
      ([field, value]) =>
        `| ${markdownCell(field)} | ${value.compared} | ${value.agreed} | ${percent(value.agreement)} |`,
    )
    .join("\n");
  const semanticMismatchRows = slice.diagnostics.paired.semantics.topMismatches
    .map(
      (value) =>
        `| ${markdownCell(value.kind)} | ${markdownCell(value.application)} | ${markdownCell(value.field)} | ${value.count} |`,
    )
    .join("\n");
  const latency = slice.diagnostics.paired.latencyMilliseconds;
  const duplicateBursts = slice.diagnostics.paired.duplicateBursts;
  return (
    `## ${title}\n\n` +
    `- Common completed segments: ${slice.commonCompletedSegments}\n` +
    `- Candidate events: ${slice.candidate.events}\n` +
    `- Reference events: ${slice.reference.events}\n` +
    `- Exact timestamp/kind/app matches: ${slice.matches.exact.matches} (F1 ${percent(slice.matches.exact.f1)})\n` +
    `- ±${toleranceMilliseconds} ms kind/app matches: ${slice.matches.tolerant.matches} (precision ${percent(slice.matches.tolerant.precision)}, recall ${percent(slice.matches.tolerant.recall)}, F1 ${percent(slice.matches.tolerant.f1)})\n\n` +
    `| Event kind | Candidate | Reference | ± tolerance matches | Precision | Recall | F1 |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
    `### Per-segment diagnostics\n\n` +
    `| Segment | Candidate | Reference | Precision | Recall | F1 |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${segmentRows}\n\n` +
    `### Largest kind/application count gaps\n\n` +
    `| Kind | Application identity | Candidate | Reference | Difference | Precision | Recall |\n` +
    `| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${streamGapRows}\n\n` +
    `### Capture-reason diagnostics\n\n` +
    `| Kind / reason | Candidate | Reference |\n` +
    `| --- | ---: | ---: |\n${captureReasonRows}\n` +
    `\n### Paired latency and duplicate bursts\n\n` +
    `- Absolute capture delta p50: ${latency.p50 ?? "n/a"} ms\n` +
    `- Absolute capture delta p95: ${latency.p95 ?? "n/a"} ms\n` +
    `- Candidate duplicate-burst ratio: ${percent(duplicateBursts.candidate.burstRatio)}\n` +
    `- Reference duplicate-burst ratio: ${percent(duplicateBursts.reference.burstRatio)}\n\n` +
    `### Semantic agreement on time/kind/application matched pairs\n\n` +
    `| Field | Compared | Agreed | Agreement |\n` +
    `| --- | ---: | ---: | ---: |\n${semanticRows}\n\n` +
    `| Kind | Application identity | Field | Mismatches |\n` +
    `| --- | --- | --- | ---: |\n${semanticMismatchRows}\n`
  );
}

function dataQualityMarkdown(report) {
  const statuses = new Set([
    ...Object.keys(report.dataQuality.candidate.statusCounts),
    ...Object.keys(report.dataQuality.reference.statusCounts),
  ]);
  const rows = [...statuses]
    .map(
      (status) =>
        `| ${status} | ${report.dataQuality.candidate.statusCounts[status] ?? 0} | ${report.dataQuality.reference.statusCounts[status] ?? 0} |`,
    )
    .join("\n");
  const issueRows = [
    ...report.dataQuality.candidate.issues.map((issue) => ({ source: "candidate", ...issue })),
    ...report.dataQuality.reference.issues.map((issue) => ({ source: "reference", ...issue })),
  ]
    .slice(0, 100)
    .map(
      (issue) =>
        `| ${issue.source} | ${markdownCell(issue.segmentID)} | ${issue.status} | ${markdownCell(issue.reason ?? "n/a")} |`,
    )
    .join("\n");
  return (
    `## Input data quality\n\n` +
    `Only segments classified as complete on both sides enter headline metrics.\n\n` +
    `| Status | Candidate | Reference |\n| --- | ---: | ---: |\n${rows}\n\n` +
    `| Source | Segment | Status | Reason |\n| --- | --- | --- | --- |\n${issueRows}\n`
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
    `# DeskLore paired evaluation\n\nGenerated at ${report.generatedAt}. Schema ${report.schemaVersion}; evaluator ${report.evaluatorVersion}.\n\n` +
    `Matching uses bundle identifier when available and app name as fallback. ` +
    `Excluded bundles: ${report.excludedBundles.join(", ") || "none"}. ` +
    `The reference is an observational comparator, not ground truth.\n\n` +
    `Candidate adapter/settings: ${report.provenance.candidate.adapter} / ${report.provenance.candidate.recorderSettings}. ` +
    `Reference adapter/settings: ${report.provenance.reference.adapter} / ${report.provenance.reference.recorderSettings}.\n\n` +
    dataQualityMarkdown(report) +
    `\n` +
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
    dataset.segments
      .filter((segment) => segment.status === "complete")
      .map((segment) => segment.id),
  );
}

function segmentStartedAt(dataset, id) {
  const segment = dataset.segments.find((item) => item.id === id);
  return Date.parse(segment?.startedAt ?? "");
}

export async function run(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  const candidateRoot = path.resolve(
    args.get("candidate") ??
      path.join(os.homedir(), "Library/Application Support/DeskLore/history"),
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
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: reportSchemaVersion,
    evaluatorVersion,
    generatedAt,
    metricScope: {
      headline: "one-to-one timestamp/kind/application reference similarity",
      semantic: "field agreement on headline-matched pairs",
      referenceRole: "observational comparator, not ground truth",
    },
    toleranceMilliseconds,
    excludedBundles: [...excludedBundles].sort((lhs, rhs) => lhs.localeCompare(rhs)),
    since: Number.isFinite(since) ? new Date(since).toISOString() : undefined,
    recentSegmentLimit: recentSegmentCount,
    dataQuality: {
      candidate: candidateDataset.dataQuality,
      reference: referenceDataset.dataQuality,
    },
    provenance: {
      candidate: datasetProvenance(
        candidateDataset,
        "candidate",
        args.get("candidate-settings"),
        generatedAt,
      ),
      reference: datasetProvenance(
        referenceDataset,
        "reference",
        args.get("reference-settings"),
        generatedAt,
      ),
    },
    overall,
    recent,
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
