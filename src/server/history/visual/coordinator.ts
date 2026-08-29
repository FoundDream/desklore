import { randomUUID } from "node:crypto";
import type { VisualHealth } from "../../../shared/contracts/index.js";
import type {
  AXSufficiencyEvidence,
  EventEvidenceEnrichment,
  HistoryEvent,
  VisualEvidence,
  VisualSettings,
} from "../contracts.js";
import type { LLMRuntime } from "../timeline/repository.js";
import {
  evaluateAXByRules,
  judgeAXWithLuna,
  shouldAssessVisualEvidence,
  understandVisualWithLuna,
  visualEvidenceFromCapture,
  type VisualCapturePayload,
  type VisualCaptureProvider,
} from "./service.js";
import {
  VisualCaptureScheduler,
  VisualUnderstandingCache,
  visualCaptureLimits,
  visualPayloadSignature,
  visualWindowKey,
} from "./scheduler.js";

interface VisualEvaluation {
  axSufficiency: AXSufficiencyEvidence;
  runtime?: LLMRuntime;
}

interface VisualCaptureResponse {
  requestID: string;
  payload: VisualCapturePayload;
}

type VisualCandidateOutcome =
  | { kind: "candidate"; capture: VisualCaptureResponse }
  | { kind: "coalesced" }
  | { kind: "decision_cancelled" };

interface PendingVisualIntent {
  timer: NodeJS.Timeout;
  settled: boolean;
  decision?: AXSufficiencyEvidence;
  resolve: (outcome: VisualCandidateOutcome) => void;
}

export interface VisualEnrichmentCoordinatorOptions {
  provider?: VisualCaptureProvider;
  appendEvidence: (enrichment: EventEvidenceEnrichment) => Promise<void>;
  eventAllowed: (event: HistoryEvent) => boolean;
  configuredRuntime: () => Promise<LLMRuntime | undefined>;
  onChanged: () => void;
  onError: (error: unknown) => void;
}

export class VisualEnrichmentCoordinator {
  private settings: VisualSettings = {
    axJudge: "rules",
    captureMode: "off",
    understandingMode: "off",
  };
  private work: Promise<unknown> = Promise.resolve();
  private decisionWork: Promise<unknown> = Promise.resolve();
  private captureWork: Promise<unknown> = Promise.resolve();
  private understandingWork: Promise<unknown> = Promise.resolve();
  private readonly pendingIntents = new Map<string, PendingVisualIntent>();
  private readonly captureScheduler = new VisualCaptureScheduler();
  private readonly understandingCache = new VisualUnderstandingCache();
  private readonly healthState: Omit<VisualHealth, "providerStatus"> = {
    judgedEventCount: 0,
    needsVisualCount: 0,
    uncertainCount: 0,
    captureRequestedCount: 0,
    captureSucceededCount: 0,
    captureCandidateCount: 0,
    captureDiscardedCount: 0,
    captureCoalescedCount: 0,
    captureBlockedCount: 0,
    captureFailedCount: 0,
    captureCooldownCount: 0,
    captureBackoffCount: 0,
    visualGapCount: 0,
    visualUnchangedCount: 0,
    visualReusedCount: 0,
    visionCalledCount: 0,
    lastDecisionReason: undefined,
    lastCaptureDecisionReason: undefined,
  };

  constructor(private readonly options: VisualEnrichmentCoordinatorOptions) {}

  health(): VisualHealth {
    return {
      ...this.healthState,
      providerStatus:
        this.settings.captureMode === "off"
          ? "disabled"
          : (this.options.provider?.status() ?? "unavailable"),
    };
  }

  providerAvailable(): boolean {
    return Boolean(this.options.provider);
  }

  configure(settings: VisualSettings): void {
    if (settings.captureMode === "off") this.cancelPending();
    if (settings.captureMode === "off" || settings.understandingMode !== "luna") {
      this.clearCache();
    }
    this.settings = { ...settings };
  }

  schedule(event: HistoryEvent): void {
    if (!shouldAssessVisualEvidence(event)) return;
    const settingsSnapshot = { ...this.settings };
    if (settingsSnapshot.axJudge === "rules" && settingsSnapshot.captureMode === "off") return;

    const ruleDecision = evaluateAXByRules(event);
    const assessmentStartedAt = new Date().toISOString();
    const intentKey = visualWindowKey(event);
    this.cancelIntent(intentKey);
    const evaluation = this.evaluate(event, settingsSnapshot, ruleDecision);
    const shouldCreateIntent =
      settingsSnapshot.captureMode === "fallback" &&
      (ruleDecision.decision === "needs_visual" ||
        (ruleDecision.decision === "uncertain" && settingsSnapshot.axJudge === "luna"));
    const task = shouldCreateIntent
      ? this.runIntent(event, settingsSnapshot, intentKey, assessmentStartedAt, evaluation)
      : evaluation.then((result) =>
          this.complete(
            event,
            settingsSnapshot,
            result,
            { kind: "decision_cancelled" },
            assessmentStartedAt,
          ),
        );
    void this.track(task).catch(this.options.onError);
  }

  async drain(): Promise<void> {
    await this.work;
  }

  cancelPending(): void {
    for (const intentKey of this.pendingIntents.keys()) {
      this.cancelIntent(intentKey, "decision_cancelled");
    }
  }

  clearCache(): void {
    this.understandingCache.clear();
  }

  async requestPermission(): Promise<void> {
    if (!this.options.provider) throw new Error("Visual capture provider is unavailable");
    await this.options.provider.requestPermission();
  }

  async capture(
    event: HistoryEvent,
    understandingMode: VisualSettings["understandingMode"] = this.settings.understandingMode,
    nowMilliseconds = Date.now(),
  ): Promise<VisualCaptureResponse> {
    const requestID = randomUUID().toLowerCase();
    if (!this.options.eventAllowed(event)) {
      return {
        requestID,
        payload: {
          status: "blocked",
          reason: "policy_excluded",
          provider: this.options.provider?.id ?? "none",
        },
      };
    }
    const provider = this.options.provider;
    if (!provider) {
      this.captureScheduler.recordProviderFailure(nowMilliseconds);
      this.healthState.lastCaptureDecisionReason = "provider_unavailable";
      return {
        requestID,
        payload: { status: "unavailable", reason: "provider_unavailable", provider: "none" },
      };
    }
    const gate = this.captureScheduler.reserve(event, nowMilliseconds);
    if (!gate.allowed) {
      if (gate.reason === "window_cooldown") this.healthState.captureCooldownCount += 1;
      if (gate.reason === "provider_backoff") this.healthState.captureBackoffCount += 1;
      this.healthState.lastCaptureDecisionReason = gate.reason;
      return {
        requestID,
        payload: { status: "blocked", reason: gate.reason, provider: provider.id },
      };
    }
    const providerStatus = provider.status();
    if (providerStatus !== "ready") {
      this.captureScheduler.recordProviderFailure(nowMilliseconds);
      const reason = `provider_${providerStatus}`;
      this.healthState.lastCaptureDecisionReason = reason;
      return {
        requestID,
        payload: { status: "unavailable", reason, provider: provider.id },
      };
    }
    this.healthState.captureRequestedCount += 1;
    this.healthState.lastCaptureDecisionReason = "capture_requested";
    const eventTime = Date.parse(event.timestamp);
    const eventExpiresAt = Number.isFinite(eventTime)
      ? Math.min(nowMilliseconds + 8_000, eventTime + 8_000)
      : nowMilliseconds + 8_000;
    try {
      const payload = await provider.capture({
        requestID,
        eventID: event.id,
        bundleIdentifier: event.application.bundleIdentifier,
        windowRuntimeIdentifier: event.window?.runtimeIdentifier,
        windowTitle: event.window?.title,
        url: event.window?.url,
        isPrivateBrowsing: event.window?.isPrivateBrowsing === true,
        expiresAt: new Date(eventExpiresAt).toISOString(),
        includeImage: understandingMode === "luna",
      });
      if (payload.status === "captured") {
        this.captureScheduler.recordProviderSuccess();
        this.healthState.lastCaptureDecisionReason = "captured";
      } else if (
        payload.status === "failed" ||
        (payload.status === "unavailable" &&
          payload.reason !== "request_expired" &&
          payload.reason !== "target_window_unavailable")
      ) {
        this.captureScheduler.recordProviderFailure(nowMilliseconds);
        this.healthState.lastCaptureDecisionReason = payload.reason ?? payload.status;
      } else {
        this.healthState.lastCaptureDecisionReason = payload.reason ?? payload.status;
      }
      return { requestID, payload };
    } catch (error) {
      this.captureScheduler.recordProviderFailure(nowMilliseconds);
      const reason = `provider_${error instanceof Error ? error.message : "request_failed"}`;
      this.healthState.lastCaptureDecisionReason = reason;
      return {
        requestID,
        payload: { status: "failed", reason, provider: provider.id },
      };
    }
  }

  private evaluate(
    event: HistoryEvent,
    settings: VisualSettings,
    ruleDecision: ReturnType<typeof evaluateAXByRules>,
  ): Promise<VisualEvaluation> {
    const runtime =
      settings.axJudge === "luna" || settings.understandingMode === "luna"
        ? this.options.configuredRuntime()
        : Promise.resolve(undefined);
    const decision =
      settings.axJudge === "luna" && ruleDecision.decision === "uncertain"
        ? this.enqueueDecision(async () => {
            const configuredRuntime = await runtime;
            return configuredRuntime
              ? judgeAXWithLuna(event, configuredRuntime)
              : {
                  ...ruleDecision,
                  source: "luna_fallback" as const,
                  reasons: [...ruleDecision.reasons, "luna_unavailable"],
                };
          })
        : Promise.resolve(ruleDecision);
    return Promise.all([runtime, decision]).then(([configuredRuntime, axSufficiency]) => ({
      runtime: configuredRuntime,
      axSufficiency,
    }));
  }

  private runIntent(
    event: HistoryEvent,
    settings: VisualSettings,
    intentKey: string,
    assessmentStartedAt: string,
    evaluation: Promise<VisualEvaluation>,
  ): Promise<void> {
    let pending!: PendingVisualIntent;
    const candidate = new Promise<VisualCandidateOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.settled = true;
        if (this.pendingIntents.get(intentKey) === pending) this.pendingIntents.delete(intentKey);
        if (pending.decision && pending.decision.decision !== "needs_visual") {
          resolve({ kind: "decision_cancelled" });
          return;
        }
        this.healthState.captureCandidateCount += 1;
        void this.enqueueCapture(() => this.capture(event, settings.understandingMode)).then(
          (capture) => resolve({ kind: "candidate", capture }),
          reject,
        );
      }, visualCaptureLimits.settleMilliseconds);
      pending = { timer, settled: false, resolve };
      this.pendingIntents.set(intentKey, pending);
    });
    void evaluation
      .then(({ axSufficiency }) => {
        pending.decision = axSufficiency;
        if (!pending.settled && axSufficiency.decision !== "needs_visual") {
          pending.settled = true;
          clearTimeout(pending.timer);
          if (this.pendingIntents.get(intentKey) === pending) this.pendingIntents.delete(intentKey);
          pending.resolve({ kind: "decision_cancelled" });
        }
      })
      .catch(() => undefined);
    return Promise.all([evaluation, candidate]).then(([result, outcome]) =>
      this.complete(event, settings, result, outcome, assessmentStartedAt),
    );
  }

  private cancelIntent(
    intentKey: string,
    outcome: "coalesced" | "decision_cancelled" = "coalesced",
  ): void {
    const pending = this.pendingIntents.get(intentKey);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingIntents.delete(intentKey);
    if (outcome === "coalesced") this.healthState.captureCoalescedCount += 1;
    pending.resolve({ kind: outcome });
  }

  private async complete(
    event: HistoryEvent,
    settings: VisualSettings,
    evaluation: VisualEvaluation,
    outcome: VisualCandidateOutcome,
    assessmentStartedAt: string,
  ): Promise<void> {
    const { axSufficiency, runtime } = evaluation;
    this.healthState.judgedEventCount += 1;
    if (axSufficiency.decision === "needs_visual") this.healthState.needsVisualCount += 1;
    if (axSufficiency.decision === "uncertain") this.healthState.uncertainCount += 1;
    this.healthState.lastDecisionReason = axSufficiency.reasons.join(",").slice(0, 240);

    let visual: VisualEvidence | undefined;
    const capture = outcome.kind === "candidate" ? outcome.capture : undefined;
    if (capture) this.observeCapture(capture.payload);
    if (settings.captureMode === "fallback" && axSufficiency.decision === "needs_visual") {
      if (capture) {
        visual = await this.processCandidate(event, settings, runtime, capture);
      } else if (outcome.kind === "coalesced") {
        visual = {
          requestID: randomUUID().toLowerCase(),
          status: "blocked",
          provider: this.options.provider?.id ?? "none",
          reason: "visual_intent_coalesced",
          privacy: "not_captured",
        };
        this.healthState.lastCaptureDecisionReason = "visual_intent_coalesced";
      }
    } else if (settings.captureMode === "fallback" && axSufficiency.decision === "uncertain") {
      this.healthState.visualGapCount += 1;
      if (capture?.payload.status === "captured") {
        visual = this.discardCandidate(capture, "candidate_discarded_ax_uncertain");
      } else if (outcome.kind === "coalesced") {
        visual = {
          requestID: randomUUID().toLowerCase(),
          status: "blocked",
          provider: this.options.provider?.id ?? "none",
          reason: "visual_intent_coalesced",
          privacy: "not_captured",
        };
      } else {
        visual = {
          requestID: capture?.requestID ?? randomUUID().toLowerCase(),
          status: "unavailable",
          provider: capture?.payload.provider ?? this.options.provider?.id ?? "none",
          reason: "ax_judge_uncertain",
          privacy: "not_captured",
        };
      }
      this.healthState.lastCaptureDecisionReason = visual.reason;
    } else if (axSufficiency.decision === "enough" && capture?.payload.status === "captured") {
      visual = this.discardCandidate(capture, "candidate_discarded_ax_enough");
    }

    await this.options.appendEvidence({
      schemaVersion: 1,
      eventID: event.id,
      eventTimestamp: event.timestamp,
      assessmentStartedAt,
      createdAt: new Date().toISOString(),
      axSufficiency,
      visual,
    });
    this.options.onChanged();
  }

  private observeCapture(payload: VisualCapturePayload): void {
    if (payload.status === "captured") this.healthState.captureSucceededCount += 1;
    else if (payload.status === "blocked") this.healthState.captureBlockedCount += 1;
    else this.healthState.captureFailedCount += 1;
  }

  private discardCandidate(capture: VisualCaptureResponse, reason: string): VisualEvidence {
    this.healthState.captureDiscardedCount += 1;
    this.healthState.lastCaptureDecisionReason = reason;
    return {
      requestID: capture.requestID,
      status: "discarded",
      provider: capture.payload.provider,
      reason,
      capturedAt: capture.payload.capturedAt,
      windowRuntimeIdentifier: capture.payload.windowRuntimeIdentifier,
      width: capture.payload.width,
      height: capture.payload.height,
      privacy: "not_captured",
    };
  }

  private async processCandidate(
    event: HistoryEvent,
    settings: VisualSettings,
    runtime: LLMRuntime | undefined,
    capture: VisualCaptureResponse,
  ): Promise<VisualEvidence> {
    const visual = visualEvidenceFromCapture(capture.requestID, capture.payload);
    if (capture.payload.status !== "captured") return visual;
    if (settings.understandingMode === "off") visual.ocrText = undefined;
    if (settings.understandingMode !== "luna" || !runtime || !capture.payload.imageBase64) {
      return visual;
    }
    const signature = visualPayloadSignature(capture.payload);
    const windowKey = visualWindowKey(event, capture.payload.windowRuntimeIdentifier);
    const cached = signature ? this.understandingCache.get(windowKey, signature) : undefined;
    if (cached) {
      visual.understanding = cached.understanding;
      visual.confidence = cached.confidence;
      visual.privacy = "redacted_remote";
      visual.reason = "visual_reused";
      this.healthState.visualUnchangedCount += 1;
      this.healthState.visualReusedCount += 1;
      this.healthState.lastCaptureDecisionReason = "visual_reused";
      return visual;
    }
    try {
      this.healthState.visionCalledCount += 1;
      const result = await this.enqueueUnderstanding(() =>
        understandVisualWithLuna(event, capture.payload, runtime),
      );
      visual.understanding = result.understanding;
      visual.confidence = result.confidence;
      visual.privacy = "redacted_remote";
      this.healthState.lastCaptureDecisionReason = "vision_called";
      if (signature) {
        this.understandingCache.set(windowKey, signature, {
          ...result,
          createdAtMilliseconds: Date.now(),
        });
      }
    } catch (error) {
      visual.reason = `visual_model_${error instanceof Error ? error.message : "failed"}`;
      this.healthState.lastCaptureDecisionReason = visual.reason;
    }
    return visual;
  }

  private enqueueDecision<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.decisionWork.then(operation, operation);
    this.decisionWork = next.catch(() => undefined);
    return next;
  }

  private enqueueCapture<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.captureWork.then(operation, operation);
    this.captureWork = next.catch(() => undefined);
    return next;
  }

  private enqueueUnderstanding<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.understandingWork.then(operation, operation);
    this.understandingWork = next.catch(() => undefined);
    return next;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    const observed = task.catch(() => undefined);
    this.work = Promise.all([this.work, observed]).then(() => undefined);
    return task;
  }
}
