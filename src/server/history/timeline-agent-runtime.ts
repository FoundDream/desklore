import type { AppLocale } from "../../shared/i18n.js";
import type { ModelRuntime } from "./model-client.js";
import {
  TimelineAgentSession,
  type TimelineAgentResult,
  type TimelineAgentRunObserver,
  type TimelineAgentSessionStep,
} from "./timeline-agent.js";
import type { HistoryEvent } from "./types.js";

export interface TimelineAgentStepMetrics {
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

export interface TimelineAgentRuntimeStep {
  step: TimelineAgentSessionStep;
  metrics: TimelineAgentStepMetrics;
  inspectedEventIDs: string[];
}

export interface TimelineAgentRuntimeSession {
  step(): Promise<TimelineAgentRuntimeStep>;
  abort(): void;
  dispose(): void;
}

export interface TimelineAgentSessionInput {
  events: HistoryEvent[];
  priorSummaries: unknown[];
  runtime: ModelRuntime;
  locale: AppLocale;
}

export interface TimelineAgentSessionFactory {
  create(input: TimelineAgentSessionInput): Promise<TimelineAgentRuntimeSession>;
  dispose?(): void;
}

function emptyMetrics(): TimelineAgentStepMetrics {
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

class InProcessTimelineAgentRuntimeSession implements TimelineAgentRuntimeSession {
  private metrics = emptyMetrics();
  private readonly session: TimelineAgentSession;

  constructor(input: TimelineAgentSessionInput) {
    const observer: TimelineAgentRunObserver = {
      onModelTurn: (usage) => {
        this.metrics.turns += 1;
        this.metrics.inputTokens += usage.inputTokens;
        this.metrics.outputTokens += usage.outputTokens;
      },
      onProviderRequest: (usage) => {
        this.metrics.estimatedInputTokens += usage.estimatedInputTokens;
      },
      onToolCall: ({ name }) => {
        this.metrics.toolCalls[name] = (this.metrics.toolCalls[name] ?? 0) + 1;
      },
      onEvidence: (usage) => {
        this.metrics.inspectedEventCount = usage.inspectedEventCount;
        this.metrics.evidenceBytes = usage.evidenceBytes;
      },
      onSubmission: (result) => {
        this.metrics.submissionAttempts += 1;
        this.metrics.normalizedDuplicateCount += result.normalizedDuplicateCount;
        this.metrics.uninspectedEvidenceCount += result.uninspectedEvidenceCount;
      },
    };
    this.session = new TimelineAgentSession(
      input.events,
      input.priorSummaries,
      input.runtime,
      input.locale,
      observer,
    );
  }

  async step(): Promise<TimelineAgentRuntimeStep> {
    this.metrics = emptyMetrics();
    const step = await this.session.step();
    return {
      step,
      metrics: this.metrics,
      inspectedEventIDs: this.session.inspectedEventIDs(),
    };
  }

  abort(): void {
    this.session.abort();
  }

  dispose(): void {
    this.session.abort();
  }
}

export class InProcessTimelineAgentSessionFactory implements TimelineAgentSessionFactory {
  async create(input: TimelineAgentSessionInput): Promise<TimelineAgentRuntimeSession> {
    return new InProcessTimelineAgentRuntimeSession(input);
  }
}

export function validWorkerResult(
  value: unknown,
  inspectedEventIDs: string[],
  sourceEventIDs: Set<string>,
): value is TimelineAgentResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<TimelineAgentResult>;
  if (
    typeof result.title !== "string" ||
    !result.title.trim() ||
    result.title.length > 120 ||
    typeof result.description !== "string" ||
    !result.description.trim() ||
    result.description.length > 1_800 ||
    (result.continuationHint !== undefined &&
      (typeof result.continuationHint !== "string" || result.continuationHint.length > 300)) ||
    !Array.isArray(result.claims) ||
    !result.claims.length ||
    result.claims.length > 16 ||
    !Array.isArray(result.evidenceEventIDs)
  ) {
    return false;
  }
  const inspected = new Set(inspectedEventIDs.map((id) => id.toLowerCase()));
  const validEvidenceIDs = (ids: unknown): ids is string[] =>
    Array.isArray(ids) &&
    ids.length > 0 &&
    new Set(ids).size === ids.length &&
    ids.every(
      (id) =>
        typeof id === "string" &&
        id === id.trim().toLowerCase() &&
        inspected.has(id) &&
        sourceEventIDs.has(id),
    );
  if (!validEvidenceIDs(result.evidenceEventIDs)) return false;
  if (
    !result.claims.every(
      (claim) =>
        claim &&
        typeof claim.text === "string" &&
        Boolean(claim.text.trim()) &&
        validEvidenceIDs(claim.evidenceEventIDs),
    )
  ) {
    return false;
  }
  const claimEvidence = new Set(result.claims.flatMap((claim) => claim.evidenceEventIDs));
  return (
    claimEvidence.size === result.evidenceEventIDs.length &&
    result.evidenceEventIDs.every((id) => claimEvidence.has(id))
  );
}
