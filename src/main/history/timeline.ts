import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AppLocale } from "../../shared/i18n.js";
import { translate } from "../../shared/i18n.js";
import { decodeTimelineMarkdown, encodeTimelineMarkdown } from "./markdown.js";
import type { ModelRuntime } from "./model-client.js";
import { atomicWriteOwnedFile } from "./owned-file.js";
import { sanitizeEvent } from "./policy.js";
import { segmentDurationMilliseconds, type SegmentStore, type StorageLayout } from "./storage.js";
import {
  TimelineAgentDiagnosticsRepository,
  timelineAgentProvider,
  type TimelineAgentRunRecord,
} from "./timeline-diagnostics.js";
import { TimelineAgentError } from "./timeline-agent.js";
import { TimelineAgentJobRepository, type TimelineAgentJob } from "./timeline-agent-jobs.js";
import {
  InProcessTimelineAgentSessionFactory,
  validWorkerResult,
  type TimelineAgentRuntimeSession,
  type TimelineAgentStepMetrics,
  type TimelineAgentSessionFactory,
} from "./timeline-agent-runtime.js";
import type {
  ClosedSegment,
  HistoryApplication,
  HistoryEvent,
  TimelineDocumentRecord,
  TimelineLLMSettings,
} from "./types.js";

const excludedBundleIdentifiers = new Set([
  "com.desklore.desktop",
  "com.apple.loginwindow",
  "com.apple.ScreenSaver.Engine",
  "com.apple.SecurityAgent",
]);

export interface TimelineContext {
  priorSummaries: Array<{
    startedAt: string;
    endedAt: string;
    title: string;
    description: string;
    continuationHint?: string;
  }>;
}

export type LLMRuntime = ModelRuntime;

export interface LLMUnavailable {
  settings: TimelineLLMSettings;
  failureReason: string;
}

type LLMRuntimeProvider = () => Promise<LLMRuntime | LLMUnavailable | undefined>;

function isExcludedEvent(event: HistoryEvent): boolean {
  if (excludedBundleIdentifiers.has(event.application.bundleIdentifier)) return true;
  return (
    event.application.bundleIdentifier === "com.github.Electron" &&
    event.window?.title === "DeskLore"
  );
}

function orderedApplications(events: HistoryEvent[]): HistoryApplication[] {
  const counts = new Map<string, { application: HistoryApplication; count: number }>();
  for (const event of events) {
    const current = counts.get(event.application.bundleIdentifier);
    counts.set(event.application.bundleIdentifier, {
      application: event.application,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...counts.values()]
    .sort(
      (lhs, rhs) =>
        rhs.count - lhs.count || lhs.application.name.localeCompare(rhs.application.name),
    )
    .map((item) => item.application);
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function semanticBody(
  input: {
    description: string;
    continuationHint?: string;
    claims: TimelineDocumentRecord["claims"];
  },
  locale: AppLocale,
): string {
  const lines = [`## ${translate(locale, "history.recordingSummary")}`, "", input.description];
  if (input.continuationHint) {
    lines.push(
      "",
      `## ${translate(locale, "history.continueFromHere")}`,
      "",
      input.continuationHint,
    );
  }
  if (input.claims.length) {
    lines.push(
      "",
      `## ${translate(locale, "history.evidenceClaims")}`,
      "",
      ...input.claims.map(
        (claim) =>
          `- ${claim.text} (${claim.evidenceEventIDs.map((id) => `event:${id}`).join(", ")})`,
      ),
    );
  }
  return lines.join("\n");
}

export function rawActivityRecord(
  segment: ClosedSegment,
  events: HistoryEvent[],
  locale: AppLocale = "en",
): TimelineDocumentRecord {
  const applications = orderedApplications(events);
  const titleCounts = new Map<string, number>();
  for (const event of events) {
    const title = normalized(event.window?.title);
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const dominantWindow = [...titleCounts].sort((lhs, rhs) => rhs[1] - lhs[1])[0]?.[0];
  const title =
    dominantWindow ??
    (applications[0]
      ? translate(locale, "history.usedApplication", { application: applications[0].name })
      : translate(locale, "history.computerActivity"));
  const names = applications.slice(0, 3).map((application) => application.name);
  const description = names.length
    ? translate(locale, "history.recordedInteractions", {
        count: events.length,
        applications: names.join(locale === "zh-CN" ? "、" : ", "),
      })
    : translate(locale, "history.noActivity");
  const body = makeRawActivityBody(events, locale);
  return {
    schemaVersion: 4,
    id: randomUUID().toLowerCase(),
    sourceSegmentID: segment.metadata.id,
    startedAt: segment.metadata.startedAt,
    endedAt:
      segment.metadata.endedAt ??
      new Date(Date.parse(segment.metadata.startedAt) + segmentDurationMilliseconds).toISOString(),
    title,
    description,
    claims: [],
    applications,
    evidenceEventIDs: [],
    generator: { type: "raw", version: 1 },
    createdAt: new Date().toISOString(),
    body,
  };
}

function makeRawActivityBody(events: HistoryEvent[], locale: AppLocale): string {
  if (!events.length) {
    return `## ${translate(locale, "history.activityHeading")}\n\n${translate(locale, "history.noActivity")}`;
  }
  const sorted = [...events].sort(
    (lhs, rhs) => Date.parse(lhs.timestamp) - Date.parse(rhs.timestamp),
  );
  const runs: Array<{
    application: HistoryApplication;
    windowTitle?: string;
    startedAt: string;
    endedAt: string;
  }> = [];
  for (const event of sorted) {
    const last = runs.at(-1);
    if (
      last &&
      Date.parse(event.timestamp) - Date.parse(last.endedAt) <= 120_000 &&
      last.application.bundleIdentifier === event.application.bundleIdentifier &&
      last.windowTitle === event.window?.title
    ) {
      last.endedAt = event.timestamp;
    } else {
      runs.push({
        application: event.application,
        windowTitle: event.window?.title,
        startedAt: event.timestamp,
        endedAt: event.timestamp,
      });
    }
  }
  const time = (value: string): string =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const lines = [`## ${translate(locale, "history.activityHeading")}`, ""];
  for (const run of runs) {
    lines.push(
      `- ${time(run.startedAt)}–${time(run.endedAt)}${locale === "zh-CN" ? "：" : ": "}${run.application.name}${
        normalized(run.windowTitle)
          ? `${locale === "zh-CN" ? "：" : ": "}${normalized(run.windowTitle)}`
          : ""
      }`,
    );
  }
  const references = [
    ...new Set(events.map((event) => normalized(event.window?.url)).filter(Boolean)),
  ].slice(0, 8) as string[];
  if (references.length) {
    lines.push(
      "",
      `## ${translate(locale, "history.relatedLocations")}`,
      "",
      ...references.map((item) => `- ${item}`),
    );
  }
  return lines.join("\n");
}

class TimelineLLMError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

function normalizedTimelineError(error: unknown): TimelineLLMError {
  if (error instanceof TimelineAgentError) {
    return new TimelineLLMError(error.reason, error.retryable);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new TimelineLLMError("network_timeout", true);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.cause as
    | NodeJS.ErrnoException
    | undefined;
  if (code?.code === "ENOTFOUND") return new TimelineLLMError("network_dns_failed", true);
  if (code?.code === "ECONNREFUSED") {
    return new TimelineLLMError("network_cannot_connect", true);
  }
  return new TimelineLLMError("network_request_failed", true);
}

interface TimelineRunMetrics {
  turns: number;
  toolCalls: Record<string, number>;
  inspectedEventCount: number;
  evidenceBytes: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  submissionAttempts: number;
  normalizedDuplicateCount: number;
  uninspectedEvidenceCount: number;
}

function emptyTimelineRunMetrics(): TimelineRunMetrics {
  return {
    turns: 0,
    toolCalls: {},
    inspectedEventCount: 0,
    evidenceBytes: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInputTokens: 0,
    submissionAttempts: 0,
    normalizedDuplicateCount: 0,
    uninspectedEvidenceCount: 0,
  };
}

function mergeTimelineRunMetrics(
  target: TimelineRunMetrics,
  delta: TimelineAgentStepMetrics,
): void {
  target.turns += delta.turns;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.estimatedInputTokens += delta.estimatedInputTokens;
  target.submissionAttempts += delta.submissionAttempts;
  target.normalizedDuplicateCount += delta.normalizedDuplicateCount;
  target.uninspectedEvidenceCount += delta.uninspectedEvidenceCount;
  target.inspectedEventCount = Math.max(target.inspectedEventCount, delta.inspectedEventCount);
  target.evidenceBytes = Math.max(target.evidenceBytes, delta.evidenceBytes);
  for (const [name, count] of Object.entries(delta.toolCalls)) {
    target.toolCalls[name] = (target.toolCalls[name] ?? 0) + count;
  }
}

function runRecord(
  segment: ClosedSegment,
  runtime: LLMRuntime,
  retry: boolean,
  id: string,
  startedAt: Date,
  metrics: TimelineRunMetrics,
  terminalState: TimelineAgentRunRecord["terminalState"],
  failureReason?: string,
): TimelineAgentRunRecord {
  const finishedAt = new Date();
  return {
    schemaVersion: 2,
    id,
    sourceSegmentID: segment.metadata.id,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model: runtime.settings.model,
    provider: timelineAgentProvider(runtime.settings.endpoint),
    protocol: runtime.settings.protocol,
    retry,
    ...metrics,
    latencyMilliseconds: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    terminalState,
    failureReason,
  };
}

const timelineAgentRuntimeVersion = 3;

function runtimeFingerprint(
  segment: ClosedSegment,
  runtime: LLMRuntime | LLMUnavailable | undefined,
  locale: AppLocale,
): string {
  const settings = runtime?.settings;
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceSegmentID: segment.metadata.id,
        runtimeVersion: timelineAgentRuntimeVersion,
        model: settings?.model ?? "disabled",
        protocol: settings?.protocol ?? "responses",
        endpoint: settings?.endpoint ?? "",
        locale,
        availability: runtime
          ? "failureReason" in runtime
            ? runtime.failureReason
            : "ready"
          : "disabled",
      }),
    )
    .digest("hex");
}

function retryDate(job: TimelineAgentJob, date: Date): string {
  const exponent = Math.min(10, Math.max(0, job.totalProviderRequests - 1));
  const base = Math.min(6 * 60 * 60 * 1_000, 30_000 * 2 ** exponent);
  const jitter = Number.parseInt(job.id.slice(0, 4), 16) % Math.max(1, Math.floor(base / 5));
  return new Date(date.getTime() + base + jitter).toISOString();
}

function runtimeRetryDate(job: TimelineAgentJob, date: Date): string {
  const exponent = Math.min(5, Math.max(0, job.totalRuntimeFailures - 1));
  const base = Math.min(5 * 60 * 1_000, 15_000 * 2 ** exponent);
  const jitter = Number.parseInt(job.id.slice(0, 4), 16) % Math.max(1, Math.floor(base / 5));
  return new Date(date.getTime() + base + jitter).toISOString();
}

function isWorkerRuntimeFailure(reason: string): boolean {
  return [
    "agent_worker_crashed",
    "agent_worker_failed",
    "agent_worker_session_missing",
    "agent_worker_startup_timeout",
    "agent_worker_stopped",
    "agent_worker_timeout",
  ].includes(reason);
}

function eligible(job: TimelineAgentJob, date: Date): boolean {
  if (["succeeded", "cancelled", "source_unavailable"].includes(job.status)) return false;
  return !job.nextEligibleAt || Date.parse(job.nextEligibleAt) <= date.getTime();
}

export class TimelineRepository {
  private readonly generationInFlight = new Set<string>();
  private readonly diagnostics: TimelineAgentDiagnosticsRepository;
  private readonly jobs: TimelineAgentJobRepository;
  private readonly activeSessions = new Map<
    string,
    {
      session: TimelineAgentRuntimeSession;
      runID: string;
      startedAt: Date;
      retry: boolean;
      metrics: TimelineRunMetrics;
    }
  >();
  private lastScheduledSegmentID?: string;

  constructor(
    private readonly layout: StorageLayout,
    private readonly segments: SegmentStore,
    private readonly llmRuntime: LLMRuntimeProvider,
    private readonly locale: () => AppLocale = () => "en",
    private readonly sessionFactory: TimelineAgentSessionFactory = new InProcessTimelineAgentSessionFactory(),
  ) {
    this.diagnostics = new TimelineAgentDiagnosticsRepository(layout);
    this.jobs = new TimelineAgentJobRepository(layout);
  }

  async generateIfNeeded(segment: ClosedSegment): Promise<TimelineDocumentRecord | undefined> {
    if (this.generationInFlight.has(segment.metadata.id)) return undefined;
    this.generationInFlight.add(segment.metadata.id);
    try {
      const existing = await this.loadDocuments();
      const current = existing.find((document) => document.sourceSegmentID === segment.metadata.id);
      if (current) {
        if (this.isRawDocument(current)) await this.ensureJob(segment, current);
        return undefined;
      }
      const events = (await this.segments.readEvents(segment)).filter(
        (event) => !isExcludedEvent(event),
      );
      if (!events.length) return undefined;
      const runtime = await this.llmRuntime();
      const baseline = rawActivityRecord(segment, events, this.locale());
      const document: TimelineDocumentRecord = {
        ...baseline,
        generator: {
          type: "raw-baseline",
          version: 1,
          ...(runtime && "failureReason" in runtime
            ? { model: runtime.settings.model, failureReason: runtime.failureReason }
            : {}),
        },
      };
      const refreshed = await this.loadDocuments();
      if (refreshed.some((item) => item.sourceSegmentID === segment.metadata.id)) return undefined;
      const destination = path.join(this.layout.timeline, this.filename(document));
      await atomicWriteOwnedFile(destination, encodeTimelineMarkdown(document));
      const saved = { ...document, filePath: destination };
      await this.ensureJob(segment, saved, runtime);
      return saved;
    } finally {
      this.generationInFlight.delete(segment.metadata.id);
    }
  }

  async generatePending(segments: ClosedSegment[]): Promise<TimelineDocumentRecord[]> {
    const generated: TimelineDocumentRecord[] = [];
    for (const segment of segments) {
      const document = await this.generateIfNeeded(segment);
      if (document) generated.push(document);
    }
    return generated;
  }

  async advanceNextAgentJob(
    segments: ClosedSegment[],
    date = new Date(),
  ): Promise<{ processed: boolean; upgraded: boolean; pending: boolean; nextWakeAt?: string }> {
    const runtime = await this.llmRuntime();
    const documents = await this.loadDocuments();
    const documentsBySegment = new Map(
      documents.map((document) => [document.sourceSegmentID, document]),
    );
    const segmentsByID = new Map(segments.map((segment) => [segment.metadata.id, segment]));
    for (const segment of segments) {
      const document = documentsBySegment.get(segment.metadata.id);
      if (document && this.isRawDocument(document))
        await this.ensureJob(segment, document, runtime);
    }
    const jobs = await this.jobs.load();
    const pendingJobs = jobs.filter(
      (job) => !["succeeded", "cancelled", "source_unavailable"].includes(job.status),
    );
    const nextWakeAt = pendingJobs
      .map((job) => job.nextEligibleAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    const runnable = pendingJobs.filter((job) => {
      const segment = segmentsByID.get(job.sourceSegmentID);
      if (!segment) return false;
      const fingerprint = runtimeFingerprint(segment, runtime, this.locale());
      if (job.fingerprint !== fingerprint) return true;
      if (job.status === "waiting_configuration" && job.fingerprint === fingerprint) return false;
      if (job.status === "stalled" && !job.nextEligibleAt && job.fingerprint === fingerprint) {
        return false;
      }
      return eligible(job, date);
    });
    if (!runnable.length) {
      for (const job of pendingJobs) {
        if (!segmentsByID.has(job.sourceSegmentID)) {
          this.activeSessions.get(job.sourceSegmentID)?.session.abort();
          this.activeSessions.delete(job.sourceSegmentID);
          await this.jobs.update(job.id, { status: "source_unavailable" }, date);
        }
      }
      return { processed: false, upgraded: false, pending: pendingJobs.length > 0, nextWakeAt };
    }
    const previousIndex = runnable.findIndex(
      (job) => job.sourceSegmentID === this.lastScheduledSegmentID,
    );
    const job = runnable[(previousIndex + 1) % runnable.length]!;
    this.lastScheduledSegmentID = job.sourceSegmentID;
    const segment = segmentsByID.get(job.sourceSegmentID)!;
    const document = documentsBySegment.get(job.sourceSegmentID);
    if (!document?.filePath || !this.isRawDocument(document)) {
      await this.jobs.update(job.id, { status: "succeeded", nextEligibleAt: undefined }, date);
      return { processed: true, upgraded: false, pending: runnable.length > 1, nextWakeAt };
    }
    const fingerprint = runtimeFingerprint(segment, runtime, this.locale());
    if (!runtime || "failureReason" in runtime) {
      this.activeSessions.get(job.sourceSegmentID)?.session.abort();
      this.activeSessions.delete(job.sourceSegmentID);
      await this.jobs.update(
        job.id,
        {
          fingerprint,
          status: "waiting_configuration",
          failureClass:
            runtime && "failureReason" in runtime ? runtime.failureReason : "llm_disabled",
          failureSignature:
            runtime && "failureReason" in runtime ? runtime.failureReason : "llm_disabled",
          nextEligibleAt: undefined,
        },
        date,
      );
      return { processed: true, upgraded: false, pending: true, nextWakeAt };
    }
    if (job.fingerprint !== fingerprint) {
      this.activeSessions.get(job.sourceSegmentID)?.session.abort();
      this.activeSessions.delete(job.sourceSegmentID);
      await this.jobs.update(
        job.id,
        {
          fingerprint,
          status: "queued",
          wakeReason: "runtime_changed",
          failureClass: undefined,
          failureSignature: undefined,
          noProgressStreak: 0,
          nextEligibleAt: undefined,
        },
        date,
      );
    }
    const events = (await this.segments.readEvents(segment)).filter(
      (event) => !isExcludedEvent(event),
    );
    if (!events.length) {
      await this.jobs.update(job.id, { status: "source_unavailable" }, date);
      return { processed: true, upgraded: false, pending: runnable.length > 1, nextWakeAt };
    }
    let active = this.activeSessions.get(job.sourceSegmentID);
    const metrics = active?.metrics ?? emptyTimelineRunMetrics();
    const runID = active?.runID ?? randomUUID().toLowerCase();
    const startedAt = active?.startedAt ?? date;
    const retry = active?.retry ?? job.totalProviderRequests > 0;
    let lastStepMetrics: TimelineAgentStepMetrics | undefined;
    await this.jobs.update(job.id, { status: "running", wakeReason: "scheduler" }, date);
    try {
      if (!active) {
        active = {
          session: await this.sessionFactory.create({
            events: events.map((event) => sanitizeEvent(event)),
            priorSummaries: this.context(
              documents.filter((item) => item.id !== document.id),
              segment.metadata.startedAt,
            ).priorSummaries,
            runtime,
            locale: this.locale(),
          }),
          runID,
          startedAt,
          retry,
          metrics,
        };
        this.activeSessions.set(job.sourceSegmentID, active);
      }
      const runtimeStep = await active.session.step();
      lastStepMetrics = runtimeStep.metrics;
      mergeTimelineRunMetrics(active.metrics, runtimeStep.metrics);
      const { step } = runtimeStep;
      const turnDelta = runtimeStep.metrics.turns;
      const toolDelta = Object.values(runtimeStep.metrics.toolCalls).reduce(
        (sum, value) => sum + value,
        0,
      );
      const submissionDelta = runtimeStep.metrics.submissionAttempts;
      const totals = {
        totalTurns: job.totalTurns + turnDelta,
        totalProviderRequests: job.totalProviderRequests + turnDelta,
        totalToolCalls: job.totalToolCalls + toolDelta,
        totalSubmissions: job.totalSubmissions + submissionDelta,
      };
      if (step.state === "succeeded") {
        const sourceEventIDs = new Set(events.map((event) => event.id.toLowerCase()));
        if (!validWorkerResult(step.result, runtimeStep.inspectedEventIDs, sourceEventIDs)) {
          throw new TimelineAgentError("agent_worker_invalid_evidence", false);
        }
        const upgraded: TimelineDocumentRecord = {
          ...document,
          title: step.result.title,
          description: step.result.description,
          continuationHint: step.result.continuationHint,
          claims: step.result.claims,
          evidenceEventIDs: step.result.evidenceEventIDs,
          generator: {
            type: "agent",
            version: timelineAgentRuntimeVersion,
            model: runtime.settings.model,
          },
          body: semanticBody(step.result, this.locale()),
        };
        await atomicWriteOwnedFile(document.filePath, encodeTimelineMarkdown(upgraded));
        await this.jobs.update(
          job.id,
          {
            ...totals,
            status: "succeeded",
            failureClass: undefined,
            failureSignature: undefined,
            noProgressStreak: 0,
            nextEligibleAt: undefined,
          },
          date,
        );
        await this.diagnostics
          .append(runRecord(segment, runtime, retry, runID, startedAt, active.metrics, "succeeded"))
          .catch(() => undefined);
        active.session.dispose();
        this.activeSessions.delete(job.sourceSegmentID);
        return { processed: true, upgraded: true, pending: runnable.length > 1, nextWakeAt };
      }
      if (step.state === "stalled") {
        const updated = { ...job, ...totals };
        await this.jobs.update(
          job.id,
          {
            ...totals,
            status: "stalled",
            failureClass: "agent_stalled",
            failureSignature: "no_progress",
            noProgressStreak: step.noProgressStreak,
            nextEligibleAt: retryDate(updated, date),
          },
          date,
        );
        await this.diagnostics
          .append(
            runRecord(
              segment,
              runtime,
              retry,
              runID,
              startedAt,
              active.metrics,
              "fallback",
              "agent_stalled",
            ),
          )
          .catch(() => undefined);
        active.session.dispose();
        this.activeSessions.delete(job.sourceSegmentID);
        return { processed: true, upgraded: false, pending: true, nextWakeAt };
      }
      await this.jobs.update(
        job.id,
        {
          ...totals,
          status: "queued",
          failureClass: undefined,
          failureSignature: undefined,
          noProgressStreak: step.noProgressStreak,
          nextEligibleAt: undefined,
        },
        date,
      );
      return { processed: true, upgraded: false, pending: true, nextWakeAt };
    } catch (error) {
      const normalized = normalizedTimelineError(error);
      const workerRuntimeFailure = isWorkerRuntimeFailure(normalized.reason);
      const turnDelta = lastStepMetrics?.turns ?? 0;
      const toolDelta = Object.values(lastStepMetrics?.toolCalls ?? {}).reduce(
        (sum, value) => sum + value,
        0,
      );
      const submissionDelta = lastStepMetrics?.submissionAttempts ?? 0;
      const updated = {
        ...job,
        totalTurns: job.totalTurns + turnDelta,
        totalProviderRequests:
          job.totalProviderRequests + (workerRuntimeFailure ? turnDelta : Math.max(1, turnDelta)),
        totalRuntimeFailures: job.totalRuntimeFailures + (workerRuntimeFailure ? 1 : 0),
        totalToolCalls: job.totalToolCalls + toolDelta,
        totalSubmissions: job.totalSubmissions + submissionDelta,
      };
      await this.jobs.update(
        job.id,
        {
          totalTurns: updated.totalTurns,
          totalProviderRequests: updated.totalProviderRequests,
          totalRuntimeFailures: updated.totalRuntimeFailures,
          totalToolCalls: updated.totalToolCalls,
          totalSubmissions: updated.totalSubmissions,
          status: normalized.retryable
            ? workerRuntimeFailure
              ? "waiting_runtime"
              : "waiting_provider"
            : "stalled",
          failureClass: normalized.reason,
          failureSignature: normalized.reason,
          nextEligibleAt: normalized.retryable
            ? workerRuntimeFailure
              ? runtimeRetryDate(updated, date)
              : retryDate(updated, date)
            : undefined,
        },
        date,
      );
      await this.diagnostics
        .append(
          runRecord(
            segment,
            runtime,
            retry,
            runID,
            startedAt,
            metrics,
            "fallback",
            normalized.reason,
          ),
        )
        .catch(() => undefined);
      active?.session.dispose();
      this.activeSessions.delete(job.sourceSegmentID);
      return { processed: true, upgraded: false, pending: true, nextWakeAt };
    }
  }

  abortAgentJobs(): void {
    for (const active of this.activeSessions.values()) active.session.abort();
    this.activeSessions.clear();
  }

  async pauseAgentJobs(date = new Date()): Promise<void> {
    this.abortAgentJobs();
    const jobs = await this.jobs.load();
    for (const job of jobs) {
      if (
        ![
          "baseline_ready",
          "queued",
          "running",
          "waiting_runtime",
          "waiting_provider",
          "waiting_configuration",
          "paused",
        ].includes(job.status)
      ) {
        continue;
      }
      await this.jobs.update(job.id, { status: "paused", wakeReason: "app_stopped" }, date);
    }
  }

  async wakeAgentJobs(reason: string, date = new Date()): Promise<void> {
    this.abortAgentJobs();
    const jobs = await this.jobs.load();
    for (const job of jobs) {
      if (["succeeded", "cancelled", "source_unavailable"].includes(job.status)) continue;
      await this.jobs.update(
        job.id,
        {
          status: "queued",
          wakeReason: reason,
          failureClass: undefined,
          failureSignature: undefined,
          noProgressStreak: 0,
          nextEligibleAt: undefined,
        },
        date,
      );
    }
  }

  disposeAgentRuntime(): void {
    this.abortAgentJobs();
    this.sessionFactory.dispose?.();
  }

  async deleteAgentJob(sourceSegmentID: string): Promise<void> {
    this.activeSessions.get(sourceSegmentID)?.session.abort();
    this.activeSessions.delete(sourceSegmentID);
    await this.jobs.deleteBySegment(sourceSegmentID);
  }

  /** Compatibility shim for callers migrating to the turn-based scheduler. */
  async retryFallbackDocuments(
    segments: ClosedSegment[],
    date = new Date(),
    _cooldownMilliseconds?: number,
    _maximumDocuments?: number,
  ): Promise<number> {
    const outcome = await this.advanceNextAgentJob(segments, date);
    return outcome.upgraded ? 1 : 0;
  }

  async loadDocuments(): Promise<TimelineDocumentRecord[]> {
    const entries = await readdir(this.layout.timeline, { withFileTypes: true });
    const decoded: TimelineDocumentRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      const filePath = path.join(this.layout.timeline, entry.name);
      try {
        const document = decodeTimelineMarkdown(await readFile(filePath, "utf8"), filePath);
        const applications = document.applications.filter(
          (app) => !excludedBundleIdentifiers.has(app.bundleIdentifier),
        );
        if (applications.length) {
          decoded.push({ ...document, applications });
        }
      } catch {
        // Preserve malformed files for manual recovery without exposing them in the UI.
      }
    }
    const bySegment = new Map<string, TimelineDocumentRecord>();
    for (const document of decoded) {
      const current = bySegment.get(document.sourceSegmentID);
      bySegment.set(
        document.sourceSegmentID,
        current ? this.preferredDocument(current, document) : document,
      );
    }
    return [...bySegment.values()].sort(
      (lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt),
    );
  }

  async delete(document: TimelineDocumentRecord): Promise<void> {
    if (
      !document.filePath ||
      path.dirname(document.filePath) !== path.normalize(this.layout.timeline)
    ) {
      throw new Error("Timeline document is outside the storage directory");
    }
    await this.deleteAgentJob(document.sourceSegmentID);
    await rm(document.filePath);
  }

  private preferredDocument(
    lhs: TimelineDocumentRecord,
    rhs: TimelineDocumentRecord,
  ): TimelineDocumentRecord {
    const priority = (document: TimelineDocumentRecord): number =>
      document.generator.type === "agent" ? 2 : document.generator.failureReason ? 0 : 1;
    const difference = priority(lhs) - priority(rhs);
    if (difference !== 0) return difference > 0 ? lhs : rhs;
    return Date.parse(lhs.createdAt) >= Date.parse(rhs.createdAt) ? lhs : rhs;
  }

  private isRawDocument(document: TimelineDocumentRecord): boolean {
    return (
      document.generator.type === "raw" ||
      document.generator.type === "rules" ||
      document.generator.type.startsWith("raw-") ||
      document.generator.type.startsWith("rules-")
    );
  }

  private async ensureJob(
    segment: ClosedSegment,
    document: TimelineDocumentRecord,
    providedRuntime?: LLMRuntime | LLMUnavailable,
  ): Promise<TimelineAgentJob> {
    const runtime = providedRuntime ?? (await this.llmRuntime());
    const fingerprint = runtimeFingerprint(segment, runtime, this.locale());
    const existing = (await this.jobs.load()).find(
      (job) => job.sourceSegmentID === segment.metadata.id,
    );
    if (!existing) {
      const created = await this.jobs.create(segment.metadata.id, document.id, fingerprint);
      return (
        (await this.jobs.update(created.id, {
          status: !runtime || "failureReason" in runtime ? "waiting_configuration" : "queued",
          failureClass:
            runtime && "failureReason" in runtime
              ? runtime.failureReason
              : runtime
                ? undefined
                : "llm_disabled",
          failureSignature:
            runtime && "failureReason" in runtime
              ? runtime.failureReason
              : runtime
                ? undefined
                : "llm_disabled",
        })) ?? created
      );
    }
    if (existing.fingerprint !== fingerprint || existing.documentID !== document.id) {
      this.activeSessions.get(segment.metadata.id)?.session.abort();
      this.activeSessions.delete(segment.metadata.id);
      return (
        (await this.jobs.update(existing.id, {
          documentID: document.id,
          fingerprint,
          status: !runtime || "failureReason" in runtime ? "waiting_configuration" : "queued",
          wakeReason: "runtime_changed",
          failureClass: undefined,
          failureSignature: undefined,
          noProgressStreak: 0,
          nextEligibleAt: undefined,
        })) ?? existing
      );
    }
    return existing;
  }

  private context(documents: TimelineDocumentRecord[], before: string): TimelineContext {
    return {
      priorSummaries: documents
        .filter((document) => Date.parse(document.endedAt) <= Date.parse(before))
        .sort((lhs, rhs) => Date.parse(rhs.endedAt) - Date.parse(lhs.endedAt))
        .slice(0, 2)
        .reverse()
        .map(({ startedAt, endedAt, title, description, continuationHint }) => ({
          startedAt,
          endedAt,
          title,
          description,
          continuationHint,
        })),
    };
  }

  private filename(document: TimelineDocumentRecord): string {
    const slug =
      document.title
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .join("-")
        .slice(0, 64) || "activity";
    return `${document.sourceSegmentID}-${document.id}-10min-${slug}.md`;
  }
}
