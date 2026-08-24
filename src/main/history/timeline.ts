import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppLocale } from "../../shared/i18n.js";
import { translate } from "../../shared/i18n.js";
import { decodeTimelineMarkdown, encodeTimelineMarkdown } from "./markdown.js";
import type { ModelRuntime } from "./model-client.js";
import { segmentDurationMilliseconds, type SegmentStore, type StorageLayout } from "./storage.js";
import {
  TimelineAgentDiagnosticsRepository,
  timelineAgentProvider,
  type TimelineAgentRunRecord,
} from "./timeline-diagnostics.js";
import { runTimelineAgent, TimelineAgentError } from "./timeline-agent.js";
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
    schemaVersion: 1,
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

async function modelSummary(
  segment: ClosedSegment,
  events: HistoryEvent[],
  context: TimelineContext,
  runtime: LLMRuntime,
  locale: AppLocale,
  diagnostics: TimelineAgentDiagnosticsRepository,
  retry: boolean,
): Promise<TimelineDocumentRecord> {
  const runID = randomUUID().toLowerCase();
  const startedAt = new Date();
  const metrics: TimelineRunMetrics = {
    turns: 0,
    toolCalls: {},
    inspectedEventCount: 0,
    evidenceBytes: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  try {
    const draft = await runTimelineAgent(events, context.priorSummaries, runtime, locale, {
      onModelTurn: (usage) => {
        metrics.turns += 1;
        metrics.inputTokens += usage.inputTokens;
        metrics.outputTokens += usage.outputTokens;
      },
      onToolCall: ({ name }) => {
        metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
      },
      onEvidence: (usage) => {
        metrics.inspectedEventCount = usage.inspectedEventCount;
        metrics.evidenceBytes = usage.evidenceBytes;
      },
    });
    await diagnostics
      .append(runRecord(segment, runtime, retry, runID, startedAt, metrics, "succeeded"))
      .catch(() => undefined);
    return {
      schemaVersion: 4,
      id: randomUUID().toLowerCase(),
      sourceSegmentID: segment.metadata.id,
      startedAt: segment.metadata.startedAt,
      endedAt:
        segment.metadata.endedAt ??
        new Date(
          Date.parse(segment.metadata.startedAt) + segmentDurationMilliseconds,
        ).toISOString(),
      title: draft.title,
      description: draft.description,
      continuationHint: draft.continuationHint,
      claims: draft.claims,
      applications: orderedApplications(events),
      evidenceEventIDs: draft.evidenceEventIDs,
      generator: { type: "agent", version: 1, model: runtime.settings.model },
      createdAt: new Date().toISOString(),
      body: semanticBody(draft, locale),
    };
  } catch (error) {
    const normalized = normalizedTimelineError(error);
    await diagnostics
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
    throw normalized;
  }
}

async function summarizeWithFallback(
  segment: ClosedSegment,
  events: HistoryEvent[],
  context: TimelineContext,
  runtime: LLMRuntime | LLMUnavailable | undefined,
  locale: AppLocale,
  diagnostics: TimelineAgentDiagnosticsRepository,
  retry = false,
): Promise<TimelineDocumentRecord> {
  if (!runtime) return rawActivityRecord(segment, events, locale);
  if ("failureReason" in runtime) {
    const now = new Date();
    await diagnostics
      .append({
        schemaVersion: 1,
        id: randomUUID().toLowerCase(),
        sourceSegmentID: segment.metadata.id,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        model: runtime.settings.model,
        provider: "unavailable",
        protocol: runtime.settings.protocol,
        retry,
        turns: 0,
        toolCalls: {},
        inspectedEventCount: 0,
        evidenceBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMilliseconds: 0,
        terminalState: "fallback",
        failureReason: runtime.failureReason,
      })
      .catch(() => undefined);
    const fallback = rawActivityRecord(segment, events, locale);
    return {
      ...fallback,
      generator: {
        type: "raw-fallback",
        version: 1,
        model: runtime.settings.model,
        failureReason: runtime.failureReason,
      },
    };
  }
  try {
    return await modelSummary(segment, events, context, runtime, locale, diagnostics, retry);
  } catch (error) {
    const fallback = rawActivityRecord(segment, events, locale);
    return {
      ...fallback,
      generator: {
        type: "raw-fallback",
        version: 1,
        model: runtime.settings.model,
        failureReason: error instanceof TimelineLLMError ? error.reason : "unexpected_error",
      },
    };
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export class TimelineRepository {
  private readonly generationInFlight = new Set<string>();
  private readonly fallbackRetryDates = new Map<string, number>();
  private readonly diagnostics: TimelineAgentDiagnosticsRepository;

  constructor(
    private readonly layout: StorageLayout,
    private readonly segments: SegmentStore,
    private readonly llmRuntime: LLMRuntimeProvider,
    private readonly locale: () => AppLocale = () => "en",
  ) {
    this.diagnostics = new TimelineAgentDiagnosticsRepository(layout);
  }

  async generateIfNeeded(segment: ClosedSegment): Promise<TimelineDocumentRecord | undefined> {
    if (this.generationInFlight.has(segment.metadata.id)) return undefined;
    this.generationInFlight.add(segment.metadata.id);
    try {
      const existing = await this.loadDocuments();
      if (existing.some((document) => document.sourceSegmentID === segment.metadata.id)) {
        return undefined;
      }
      const events = (await this.segments.readEvents(segment)).filter(
        (event) => !isExcludedEvent(event),
      );
      if (!events.length) return undefined;
      const context = this.context(existing, segment.metadata.startedAt);
      const document = await summarizeWithFallback(
        segment,
        events,
        context,
        await this.llmRuntime(),
        this.locale(),
        this.diagnostics,
      );
      const refreshed = await this.loadDocuments();
      if (refreshed.some((item) => item.sourceSegmentID === segment.metadata.id)) return undefined;
      const destination = path.join(this.layout.timeline, this.filename(document));
      await atomicWrite(destination, encodeTimelineMarkdown(document));
      return { ...document, filePath: destination };
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

  async retryFallbackDocuments(
    segments: ClosedSegment[],
    date = new Date(),
    cooldownMilliseconds = 15 * 60 * 1_000,
    maximumDocuments = 2,
  ): Promise<number> {
    const runtime = await this.llmRuntime();
    if (!runtime || "failureReason" in runtime) return 0;
    const documents = await this.loadDocuments();
    const segmentsByID = new Map(segments.map((segment) => [segment.metadata.id, segment]));
    let upgraded = 0;
    let attempted = 0;
    for (const document of documents) {
      if (attempted >= maximumDocuments) break;
      if (!this.isRawDocument(document) || !document.filePath) continue;
      const segment = segmentsByID.get(document.sourceSegmentID);
      if (!segment || this.generationInFlight.has(segment.metadata.id)) continue;
      const lastAttempt = this.fallbackRetryDates.get(segment.metadata.id);
      if (lastAttempt && date.getTime() - lastAttempt < cooldownMilliseconds) continue;
      attempted += 1;
      this.fallbackRetryDates.set(segment.metadata.id, date.getTime());
      this.generationInFlight.add(segment.metadata.id);
      try {
        const events = (await this.segments.readEvents(segment)).filter(
          (event) => !isExcludedEvent(event),
        );
        if (!events.length) continue;
        const raw = await summarizeWithFallback(
          segment,
          events,
          this.context(
            documents.filter((item) => item.id !== document.id),
            segment.metadata.startedAt,
          ),
          runtime,
          this.locale(),
          this.diagnostics,
          true,
        );
        if (raw.generator.type !== "agent") {
          await atomicWrite(
            document.filePath,
            encodeTimelineMarkdown({
              ...raw,
              id: document.id,
              sourceSegmentID: document.sourceSegmentID,
              startedAt: document.startedAt,
              endedAt: document.endedAt,
              createdAt: document.createdAt,
              filePath: document.filePath,
            }),
          );
          continue;
        }
        await atomicWrite(
          document.filePath,
          encodeTimelineMarkdown({
            ...raw,
            id: document.id,
            sourceSegmentID: document.sourceSegmentID,
            startedAt: document.startedAt,
            endedAt: document.endedAt,
            createdAt: document.createdAt,
            filePath: document.filePath,
          }),
        );
        upgraded += 1;
      } finally {
        this.generationInFlight.delete(segment.metadata.id);
      }
    }
    return upgraded;
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
