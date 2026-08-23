import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VisualCapturePolicyScheduler,
  visualCaptureLimits,
} from "../src/main/history/visual-policy.ts";

const defaultExcludedBundles = new Set([
  "com.github.Electron",
  "com.ziwen.computer-history.desktop",
]);
const axDecisions = new Set(["enough", "needs_visual", "uncertain"]);

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      values.set(key.slice(2), value);
      index += 1;
    } else {
      values.set(key.slice(2), "true");
    }
  }
  return values;
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((lhs, rhs) => rhs[1] - lhs[1]));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contentFingerprint(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized ? hash(normalized) : undefined;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value) {
  return typeof value === "string" && value ? value : undefined;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

function dateArgument(value, name) {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

function windowIdentity(applicationKey, runtimeIdentifier) {
  const stable = runtimeIdentifier !== undefined;
  const raw = `${applicationKey}\u001f${stable ? `id:${runtimeIdentifier}` : "unresolved"}`;
  return {
    applicationKey,
    windowKey: raw,
    windowKeyHash: hash(raw).slice(0, 16),
    hasStableWindowIdentity: stable,
    runtimeIdentifier,
  };
}

function normalizedTraceRecord(event, evidence, segmentID) {
  const eventID = string(event.id)?.toLowerCase();
  const timestamp = string(evidence.event_timestamp ?? evidence.eventTimestamp ?? event.timestamp);
  const timestampMilliseconds = timestamp ? Date.parse(timestamp) : Number.NaN;
  const application = event.application ?? event.app ?? {};
  const bundleIdentifier = string(application.bundle_identifier ?? application.bundleIdentifier);
  const applicationName = string(application.name) ?? "<missing>";
  const applicationKey = bundleIdentifier ?? applicationName;
  const runtimeIdentifier = number(
    event.window?.runtime_identifier ?? event.window?.runtimeIdentifier,
  );
  const ax = evidence.ax_sufficiency ?? evidence.axSufficiency;
  const decision = string(ax?.decision);
  if (!eventID || !Number.isFinite(timestampMilliseconds) || !axDecisions.has(decision)) {
    return undefined;
  }
  const visual = evidence.visual;
  const identity = windowIdentity(applicationKey, runtimeIdentifier);
  const visualStatus = string(visual?.status);
  const visualReason = string(visual?.reason);
  const ocrText = string(visual?.ocr_text ?? visual?.ocrText);
  const understanding = string(visual?.understanding);
  const privacy = string(visual?.privacy);
  const observedReuse = visualReason === "visual_reused";
  const observedVisionCall =
    visualStatus === "captured" &&
    !observedReuse &&
    ((privacy === "redacted_remote" && understanding !== undefined) ||
      visualReason?.startsWith("visual_model_") === true);
  const axJudgedAt = string(ax?.judged_at ?? ax?.judgedAt);
  const parsedAxJudgedAtMilliseconds = axJudgedAt ? Date.parse(axJudgedAt) : Number.NaN;
  const assessmentStartedAt = string(
    evidence.assessment_started_at ?? evidence.assessmentStartedAt,
  );
  const parsedAssessmentStartedAtMilliseconds = assessmentStartedAt
    ? Date.parse(assessmentStartedAt)
    : Number.NaN;
  const assessmentTimestampSource = Number.isFinite(parsedAssessmentStartedAtMilliseconds)
    ? "assessment_started_at"
    : string(ax?.source) === "rules" && Number.isFinite(parsedAxJudgedAtMilliseconds)
      ? "ax_judged_at_fallback"
      : "event_timestamp_fallback";
  const assessmentStartedAtMilliseconds = Number.isFinite(parsedAssessmentStartedAtMilliseconds)
    ? parsedAssessmentStartedAtMilliseconds
    : assessmentTimestampSource === "ax_judged_at_fallback"
      ? parsedAxJudgedAtMilliseconds
      : timestampMilliseconds;
  return {
    eventID,
    timestamp,
    timestampMilliseconds,
    segmentID,
    kind: string(event.kind) ?? "unknown",
    application: applicationKey,
    bundleIdentifier,
    ...identity,
    axDecision: decision,
    axSource: string(ax?.source) ?? "unknown",
    axJudgedAt,
    axJudgmentTimestampObserved: Number.isFinite(parsedAxJudgedAtMilliseconds),
    axJudgedAtMilliseconds: Number.isFinite(parsedAxJudgedAtMilliseconds)
      ? parsedAxJudgedAtMilliseconds
      : timestampMilliseconds,
    assessmentStartedAt,
    assessmentStartedAtMilliseconds,
    assessmentTimestampSource,
    visualStatus,
    visualReason,
    observedOCR: ocrText !== undefined,
    observedUnderstanding: understanding !== undefined,
    observedReuse,
    observedVisionCall,
    contentFingerprint: contentFingerprint(ocrText),
  };
}

async function readJSONLines(filePath) {
  try {
    const contents = await readFile(filePath, "utf8");
    const values = [];
    let malformedLines = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        malformedLines += 1;
      }
    }
    return { values, malformedLines };
  } catch (error) {
    if (error.code === "ENOENT") return { values: [], malformedLines: 0 };
    throw error;
  }
}

async function readTrace(root, includeOpen) {
  const segmentsRoot = path.join(root, "segments");
  const entries = await readdir(segmentsRoot, { withFileTypes: true });
  const records = [];
  let segmentsRead = 0;
  let openSegmentsSkipped = 0;
  let evidenceRows = 0;
  let malformedLines = 0;
  let unmatchedEvidenceRows = 0;
  let invalidEvidenceRows = 0;

  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(segmentsRoot, entry.name);
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));
    } catch {
      continue;
    }
    const completed = Boolean(metadata.ended_at ?? metadata.endedAt);
    if (!completed && !includeOpen) {
      openSegmentsSkipped += 1;
      continue;
    }

    const [eventsFile, evidenceFile] = await Promise.all([
      readJSONLines(path.join(directory, "events.jsonl")),
      readJSONLines(path.join(directory, "evidence.jsonl")),
    ]);
    malformedLines += eventsFile.malformedLines + evidenceFile.malformedLines;
    if (evidenceFile.values.length === 0) continue;
    segmentsRead += 1;
    evidenceRows += evidenceFile.values.length;
    const eventsByID = new Map(
      eventsFile.values
        .map((event) => [string(event.id)?.toLowerCase(), event])
        .filter(([id]) => id !== undefined),
    );
    const evidenceByID = new Map();
    for (const evidence of evidenceFile.values) {
      const eventID = string(evidence.event_id ?? evidence.eventID)?.toLowerCase();
      if (!eventID) {
        invalidEvidenceRows += 1;
        continue;
      }
      const previous = evidenceByID.get(eventID) ?? {};
      evidenceByID.set(eventID, {
        ...previous,
        ...evidence,
        ax_sufficiency: evidence.ax_sufficiency ?? previous.ax_sufficiency,
        visual: evidence.visual ?? previous.visual,
      });
    }
    for (const [eventID, evidence] of evidenceByID) {
      const event = eventsByID.get(eventID);
      if (!event) {
        unmatchedEvidenceRows += 1;
        continue;
      }
      const record = normalizedTraceRecord(event, evidence, entry.name);
      if (record) records.push(record);
      else invalidEvidenceRows += 1;
    }
  }

  return {
    records,
    quality: {
      segmentsRead,
      openSegmentsSkipped,
      evidenceRows,
      malformedLines,
      unmatchedEvidenceRows,
      invalidEvidenceRows,
    },
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

function compatibleWindow(checkpoint, capture) {
  if (checkpoint.applicationKey !== capture.applicationKey) return false;
  if (!checkpoint.hasStableWindowIdentity || !capture.hasStableWindowIdentity) return true;
  return checkpoint.runtimeIdentifier === capture.runtimeIdentifier;
}

function nextCompatibleCapture(checkpoint, capturesByApplication) {
  const captures = capturesByApplication.get(checkpoint.applicationKey) ?? [];
  let low = 0;
  let high = captures.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (captures[middle].candidate.captureTimestampMilliseconds < checkpoint.timestampMilliseconds)
      low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < captures.length; index += 1) {
    const capture = captures[index];
    if (compatibleWindow(checkpoint, capture)) return capture;
  }
  return undefined;
}

function activeMinuteCount(decisions) {
  return new Set(
    decisions
      .filter((decision) => decision.baseline.captureRequested)
      .map((decision) => Math.floor(decision.timestampMilliseconds / 60_000)),
  ).size;
}

function rate(count, minutes) {
  return minutes > 0 ? count / minutes : 0;
}

export function replayVisualPolicy(records, options = {}) {
  const limits = {
    ...visualCaptureLimits,
    ...options.limits,
    providerBackoffMilliseconds: visualCaptureLimits.providerBackoffMilliseconds,
  };
  const coverageMilliseconds = options.coverageMilliseconds ?? 15_000;
  const scheduler = new VisualCapturePolicyScheduler(limits);
  const ordered = [...records].sort(
    (lhs, rhs) =>
      lhs.assessmentStartedAtMilliseconds - rhs.assessmentStartedAtMilliseconds ||
      lhs.eventID.localeCompare(rhs.eventID),
  );
  const decisions = ordered.map((record) => {
    const baselineCaptureRequested = record.axDecision !== "enough";
    return {
      ...record,
      baseline: {
        captureRequested: baselineCaptureRequested,
        visionCallUpperBound: baselineCaptureRequested,
      },
      candidate: {
        intentCreated: false,
        captureRequested: false,
        captureTimestampMilliseconds: undefined,
        visionCallUpperBound: false,
        discarded: false,
        coalesced: false,
        reason: "no_visual_intent",
        retryAfterMilliseconds: undefined,
      },
      proxy: {
        meaningfulOCRCheckpoint: false,
        coveredWithinDeadline: undefined,
        candidateDelayMilliseconds: undefined,
      },
    };
  });

  const pendingByWindow = new Map();
  const firePending = (decision) => {
    const dueAt = decision.assessmentStartedAtMilliseconds + limits.settleMilliseconds;
    pendingByWindow.delete(decision.windowKey);
    if (decision.axJudgedAtMilliseconds <= dueAt && decision.axDecision !== "needs_visual") {
      decision.candidate.reason = `ax_${decision.axDecision}_before_settle`;
      return;
    }
    const gate = scheduler.reserve(
      {
        applicationKey: decision.applicationKey,
        windowKey: decision.windowKey,
        hasStableWindowIdentity: decision.hasStableWindowIdentity,
      },
      dueAt,
    );
    decision.candidate.captureRequested = gate.allowed;
    decision.candidate.captureTimestampMilliseconds = gate.allowed ? dueAt : undefined;
    decision.candidate.reason = gate.reason;
    decision.candidate.retryAfterMilliseconds = gate.retryAfterMilliseconds;
    if (!gate.allowed) return;
    if (decision.axDecision === "needs_visual") {
      decision.candidate.visionCallUpperBound = true;
      return;
    }
    decision.candidate.discarded = true;
    decision.candidate.reason = `candidate_discarded_ax_${decision.axDecision}`;
  };
  const firePendingThrough = (timestampMilliseconds) => {
    const due = [...pendingByWindow.values()]
      .filter(
        (decision) =>
          decision.assessmentStartedAtMilliseconds + limits.settleMilliseconds <=
          timestampMilliseconds,
      )
      .sort(
        (lhs, rhs) =>
          lhs.assessmentStartedAtMilliseconds - rhs.assessmentStartedAtMilliseconds ||
          lhs.eventID.localeCompare(rhs.eventID),
      );
    for (const decision of due) {
      if (pendingByWindow.get(decision.windowKey) === decision) firePending(decision);
    }
  };

  for (const decision of decisions) {
    firePendingThrough(decision.assessmentStartedAtMilliseconds);
    const pending = pendingByWindow.get(decision.windowKey);
    if (pending) {
      pendingByWindow.delete(decision.windowKey);
      pending.candidate.coalesced = true;
      pending.candidate.reason = "intent_coalesced";
    }
    const createsIntent =
      decision.axSource.startsWith("luna") || decision.axDecision === "needs_visual";
    if (!createsIntent) continue;
    decision.candidate.intentCreated = true;
    decision.candidate.reason = "settling";
    pendingByWindow.set(decision.windowKey, decision);
  }
  firePendingThrough(Number.POSITIVE_INFINITY);

  const checkpoints = [];
  const previousFingerprintByWindow = new Map();
  for (const decision of decisions) {
    if (
      !decision.baseline.captureRequested ||
      decision.visualStatus !== "captured" ||
      !decision.contentFingerprint
    ) {
      continue;
    }
    const previous = previousFingerprintByWindow.get(decision.windowKey);
    previousFingerprintByWindow.set(decision.windowKey, decision.contentFingerprint);
    if (previous === decision.contentFingerprint) continue;
    decision.proxy.meaningfulOCRCheckpoint = true;
    checkpoints.push(decision);
  }

  const capturesByApplication = new Map();
  for (const decision of decisions) {
    if (!decision.candidate.captureRequested) continue;
    const captures = capturesByApplication.get(decision.applicationKey) ?? [];
    captures.push(decision);
    capturesByApplication.set(decision.applicationKey, captures);
  }
  const coveredDelays = [];
  const misses = [];
  for (const checkpoint of checkpoints) {
    const capture = nextCompatibleCapture(checkpoint, capturesByApplication);
    const delay = capture
      ? capture.candidate.captureTimestampMilliseconds - checkpoint.timestampMilliseconds
      : undefined;
    const covered = delay !== undefined && delay <= coverageMilliseconds;
    checkpoint.proxy.coveredWithinDeadline = covered;
    checkpoint.proxy.candidateDelayMilliseconds = delay;
    if (covered) coveredDelays.push(delay);
    else {
      misses.push({
        eventID: checkpoint.eventID,
        timestamp: checkpoint.timestamp,
        application: checkpoint.application,
        windowKeyHash: checkpoint.windowKeyHash,
        stableWindowIdentity: checkpoint.hasStableWindowIdentity,
        nextCandidateDelayMilliseconds: delay,
      });
    }
  }

  const baselineCaptureRequests = decisions.filter(
    (decision) => decision.baseline.captureRequested,
  ).length;
  const candidateCaptureRequests = decisions.filter(
    (decision) => decision.candidate.captureRequested,
  ).length;
  const candidateVisionCalls = decisions.filter(
    (decision) => decision.candidate.visionCallUpperBound,
  ).length;
  const candidateIntents = decisions.filter((decision) => decision.candidate.intentCreated).length;
  const candidateCoalesced = decisions.filter((decision) => decision.candidate.coalesced).length;
  const candidateDiscarded = decisions.filter((decision) => decision.candidate.discarded).length;
  const activeMinutes = activeMinuteCount(decisions);
  const firstTimestamp = decisions[0]?.timestampMilliseconds;
  const lastTimestamp = decisions.at(-1)?.timestampMilliseconds;
  const wallClockMinutes =
    firstTimestamp === undefined || lastTimestamp === undefined
      ? 0
      : (lastTimestamp - firstTimestamp) / 60_000;
  const observedCaptured = decisions.filter(
    (decision) => decision.baseline.captureRequested && decision.visualStatus === "captured",
  ).length;
  const reduction =
    baselineCaptureRequests > 0
      ? (baselineCaptureRequests - candidateCaptureRequests) / baselineCaptureRequests
      : 0;
  const coveredCheckpoints = checkpoints.length - misses.length;

  return {
    decisions,
    summary: {
      trace: {
        decisions: decisions.length,
        enough: decisions.filter((decision) => decision.axDecision === "enough").length,
        needsVisual: decisions.filter((decision) => decision.axDecision === "needs_visual").length,
        uncertain: decisions.filter((decision) => decision.axDecision === "uncertain").length,
        missingAXJudgmentTimestamps: decisions.filter(
          (decision) => !decision.axJudgmentTimestampObserved,
        ).length,
        assessmentTimeSources: countBy(decisions, (decision) => decision.assessmentTimestampSource),
        unresolvedWindowIdentity: decisions.filter((decision) => !decision.hasStableWindowIdentity)
          .length,
        activeMinutes,
        wallClockMinutes,
      },
      baseline: {
        policy: "capture_every_non_enough_decision",
        screenshotRequests: baselineCaptureRequests,
        screenshotsPerActiveMinute: rate(baselineCaptureRequests, activeMinutes),
        visionCallsUpperBound: baselineCaptureRequests,
      },
      candidate: {
        policy: "per_window_settle_then_parallel_ax_and_candidate_capture",
        intents: candidateIntents,
        coalescedIntents: candidateCoalesced,
        screenshotRequests: candidateCaptureRequests,
        discardedScreenshots: candidateDiscarded,
        screenshotsPerActiveMinute: rate(candidateCaptureRequests, activeMinutes),
        visionCallsUpperBound: candidateVisionCalls,
        gateReasons: countBy(decisions, (decision) => decision.candidate.reason),
      },
      delta: {
        screenshotRequestReduction: reduction,
        screenshotRequestsSaved: baselineCaptureRequests - candidateCaptureRequests,
        visionCallUpperBoundReduction:
          baselineCaptureRequests > 0
            ? (baselineCaptureRequests - candidateVisionCalls) / baselineCaptureRequests
            : 0,
      },
      observed: {
        baselineRequestedEventsWithCapturedFrame: observedCaptured,
        baselineCaptureObservationRate:
          baselineCaptureRequests > 0 ? observedCaptured / baselineCaptureRequests : 0,
        visualStatuses: countBy(decisions, (decision) => decision.visualStatus ?? "not_recorded"),
        visualReasons: countBy(decisions, (decision) => decision.visualReason ?? "not_recorded"),
        visionCalls: decisions.filter((decision) => decision.observedVisionCall).length,
        visualReuses: decisions.filter((decision) => decision.observedReuse).length,
      },
      fidelityProxy: {
        method: "captured_local_ocr_fingerprint_change_to_next_candidate_capture_time",
        deadlineMilliseconds: coverageMilliseconds,
        meaningfulOCRCheckpoints: checkpoints.length,
        coveredCheckpoints,
        coverage: checkpoints.length > 0 ? coveredCheckpoints / checkpoints.length : null,
        p50DelayMilliseconds: percentile(coveredDelays, 0.5),
        p95DelayMilliseconds: percentile(coveredDelays, 0.95),
        missedCheckpoints: misses.length,
        capturedFramesWithoutOCR: decisions.filter(
          (decision) => decision.visualStatus === "captured" && !decision.observedOCR,
        ).length,
        interpretation:
          "Trigger-coverage proxy only. It does not score non-text visual changes or image understanding quality.",
      },
      worstMisses: misses
        .sort(
          (lhs, rhs) =>
            (rhs.nextCandidateDelayMilliseconds ?? Number.POSITIVE_INFINITY) -
            (lhs.nextCandidateDelayMilliseconds ?? Number.POSITIVE_INFINITY),
        )
        .slice(0, 20),
    },
  };
}

function serializableDecision(decision) {
  return {
    schema_version: 2,
    event_id: decision.eventID,
    event_timestamp: decision.timestamp,
    segment_id: decision.segmentID,
    kind: decision.kind,
    application: decision.application,
    window_key_hash: decision.windowKeyHash,
    stable_window_identity: decision.hasStableWindowIdentity,
    ax_decision: decision.axDecision,
    ax_source: decision.axSource,
    ax_judged_at: decision.axJudgedAt,
    assessment_started_at: decision.assessmentStartedAt,
    assessment_time_source: decision.assessmentTimestampSource,
    baseline: {
      capture_requested: decision.baseline.captureRequested,
      vision_call_upper_bound: decision.baseline.visionCallUpperBound,
    },
    candidate: {
      intent_created: decision.candidate.intentCreated,
      intent_coalesced: decision.candidate.coalesced,
      capture_requested: decision.candidate.captureRequested,
      capture_timestamp:
        decision.candidate.captureTimestampMilliseconds === undefined
          ? undefined
          : new Date(decision.candidate.captureTimestampMilliseconds).toISOString(),
      discarded: decision.candidate.discarded,
      vision_call_upper_bound: decision.candidate.visionCallUpperBound,
      reason: decision.candidate.reason,
      retry_after_ms: decision.candidate.retryAfterMilliseconds,
    },
    observed: {
      visual_status: decision.visualStatus,
      visual_reason: decision.visualReason,
      ocr_text_present: decision.observedOCR,
      understanding_present: decision.observedUnderstanding,
      vision_called: decision.observedVisionCall,
      visual_reused: decision.observedReuse,
    },
    fidelity_proxy: {
      meaningful_ocr_checkpoint: decision.proxy.meaningfulOCRCheckpoint,
      covered_within_deadline: decision.proxy.coveredWithinDeadline,
      candidate_delay_ms: decision.proxy.candidateDelayMilliseconds,
    },
  };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function decimal(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function milliseconds(value) {
  return value === null || value === undefined ? "n/a" : `${value} ms`;
}

function markdown(report) {
  const { trace, baseline, candidate, delta, observed, fidelityProxy } = report.comparison;
  const assessmentTimeSources = Object.entries(trace.assessmentTimeSources)
    .map(([source, count]) => `${source}: ${count}`)
    .join(", ");
  const gateRows = Object.entries(candidate.gateReasons)
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n");
  const missRows = report.comparison.worstMisses
    .map(
      (miss) =>
        `| ${miss.timestamp} | ${miss.application.replaceAll("|", "\\|")} | ${miss.windowKeyHash} | ${miss.stableWindowIdentity ? "yes" : "no"} | ${milliseconds(miss.nextCandidateDelayMilliseconds)} |`,
    )
    .join("\n");
  return (
    `# Computer History visual policy benchmark\n\n` +
    `Generated at ${report.generatedAt}. This is a same-input policy replay: it does not take screenshots or call a model.\n\n` +
    `Input: ${report.input.root}. Completed evidence-bearing segments: ${report.dataQuality.segmentsRead}; ` +
    `open segments skipped: ${report.dataQuality.openSegmentsSkipped}.\n\n` +
    `Candidate policy: last-event-wins per window, a ${report.policy.settleMilliseconds} ms settle delay, ` +
    `then AX judgment and a transient screenshot candidate proceed independently. ` +
    `Candidates are discarded when AX resolves to enough or uncertain, while final needs_visual candidates may continue to image processing. ` +
    `A ${report.policy.windowCooldownMilliseconds} ms per-window cooldown still applies at capture time. ` +
    `There is no global hard capture quota. ` +
    `Provider backoff is excluded because replay has no provider outcomes.\n\n` +
    `## A/B result\n\n` +
    `| Metric | Baseline | Candidate |\n| --- | ---: | ---: |\n` +
    `| Screenshot requests | ${baseline.screenshotRequests} | ${candidate.screenshotRequests} |\n` +
    `| Screenshots / active minute | ${decimal(baseline.screenshotsPerActiveMinute)} | ${decimal(candidate.screenshotsPerActiveMinute)} |\n` +
    `| Vision calls, upper bound | ${baseline.visionCallsUpperBound} | ${candidate.visionCallsUpperBound} |\n\n` +
    `Request reduction: ${percent(delta.screenshotRequestReduction)} (${delta.screenshotRequestsSaved} fewer requests). ` +
    `The candidate created ${candidate.intents} intents, coalesced ${candidate.coalescedIntents}, and discarded ` +
    `${candidate.discardedScreenshots} transient screenshots before image processing. ` +
    `The trace contains ${trace.decisions} judged events across ${trace.activeMinutes} active minutes ` +
    `(${trace.needsVisual} needs_visual, ${trace.uncertain} uncertain, ${trace.enough} enough); ` +
    `${trace.unresolvedWindowIdentity} decisions lack a stable window ID and ` +
    `${trace.missingAXJudgmentTimestamps} lack an AX judgment timestamp. ` +
    `Assessment-time sources: ${assessmentTimeSources}.\n\n` +
    `## Candidate decisions\n\n| Reason | Events |\n| --- | ---: |\n${gateRows}\n\n` +
    `## Fidelity proxy\n\n` +
    `Captured local-OCR fingerprint changes are treated as visual checkpoints. A checkpoint is covered when ` +
    `the candidate would take a compatible-window screenshot within ${fidelityProxy.deadlineMilliseconds} ms.\n\n` +
    `- Checkpoints: ${fidelityProxy.meaningfulOCRCheckpoints}\n` +
    `- Covered: ${fidelityProxy.coveredCheckpoints} (${percent(fidelityProxy.coverage)})\n` +
    `- Delay: p50 ${milliseconds(fidelityProxy.p50DelayMilliseconds)}, p95 ${milliseconds(fidelityProxy.p95DelayMilliseconds)}\n` +
    `- Missed: ${fidelityProxy.missedCheckpoints}\n` +
    `- Captured frames without OCR: ${fidelityProxy.capturedFramesWithoutOCR}\n\n` +
    `This proxy does not measure non-text visual changes or whether Luna understood the image correctly. ` +
    `Its completeness is bounded by the observed capture rate: ${percent(observed.baselineCaptureObservationRate)} ` +
    `of baseline-requested events have a captured frame in this trace.\n\n` +
    `## Observed outcomes in the source trace\n\n` +
    `Observed Luna calls: ${observed.visionCalls}; unchanged-image reuses: ${observed.visualReuses}. ` +
    `These are historical outcomes, not replayed estimates. Image egress bytes are unavailable because pixels are not persisted.\n\n` +
    `## Worst missed OCR checkpoints\n\n` +
    `| Timestamp | Application | Window key | Stable identity | Next candidate trigger |\n` +
    `| --- | --- | --- | --- | ---: |\n${missRows}\n`
  );
}

export async function run(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  const inputRoot = path.resolve(
    args.get("input") ??
      path.join(os.homedir(), "Library/Application Support/ComputerHistoryDesktop"),
  );
  const outputDirectory = path.resolve(args.get("output") ?? ".eval-data/visual-policy");
  const includeOpen = args.get("include-open") === "true";
  const since = dateArgument(args.get("since"), "since");
  const until = dateArgument(args.get("until"), "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("--since must not be later than --until");
  }
  const coverageMilliseconds = positiveInteger(args.get("coverage-ms"), 15_000, "coverage-ms");
  const limits = {
    ...visualCaptureLimits,
    settleMilliseconds: positiveInteger(
      args.get("settle-ms"),
      visualCaptureLimits.settleMilliseconds,
      "settle-ms",
    ),
    windowCooldownMilliseconds: positiveInteger(
      args.get("window-cooldown-ms"),
      visualCaptureLimits.windowCooldownMilliseconds,
      "window-cooldown-ms",
    ),
  };
  const excludedBundles = new Set(defaultExcludedBundles);
  for (const bundle of (args.get("exclude-bundles") ?? "").split(",")) {
    if (bundle.trim()) excludedBundles.add(bundle.trim());
  }

  const trace = await readTrace(inputRoot, includeOpen);
  const records = trace.records.filter(
    (record) =>
      !excludedBundles.has(record.bundleIdentifier) &&
      (since === undefined || record.timestampMilliseconds >= since) &&
      (until === undefined || record.timestampMilliseconds <= until),
  );
  const replay = replayVisualPolicy(records, { coverageMilliseconds, limits });
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    input: {
      root: inputRoot,
      includeOpen,
      since: since === undefined ? undefined : new Date(since).toISOString(),
      until: until === undefined ? undefined : new Date(until).toISOString(),
      excludedBundles: [...excludedBundles].sort((lhs, rhs) => lhs.localeCompare(rhs)),
    },
    policy: limits,
    dataQuality: {
      ...trace.quality,
      selectedDecisions: records.length,
      rawPixelsRead: false,
      ocrOrUnderstandingTextWrittenToReport: false,
    },
    comparison: replay.summary,
  };
  const rendered = markdown(report);
  const decisionsJSONL = replay.decisions
    .map((decision) => JSON.stringify(serializableDecision(decision)))
    .join("\n");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(outputDirectory, "report.md"), rendered, { mode: 0o600 }),
    writeFile(
      path.join(outputDirectory, "decisions.jsonl"),
      decisionsJSONL ? `${decisionsJSONL}\n` : "",
      { mode: 0o600 },
    ),
  ]);
  process.stdout.write(`${rendered}\n`);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await run();
