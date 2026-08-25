import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { shell } from "electron";
import type {
  HistorySnapshot,
  DesktopSnapshot,
  HistoryRecovery,
  LLMConfigurationInput,
  MemoryRollup,
  ObservationPolicy,
  TimelineApplication,
  TimelineDocument,
} from "../../shared/contracts.js";
import type { AppLocale } from "../../shared/i18n.js";
import { translate } from "../../shared/i18n.js";
import { CollectorClient } from "../collector-client.js";
import { classifyKeyboardEvent, EventBurstCoalescer, EventCoalescer } from "./coalescer.js";
import {
  allowsApplication,
  allowsDomain,
  applyObservationPolicy,
  defaultObservationPolicy,
  normalizeObservationPolicy,
  observationDecision,
} from "./policy.js";
import { defaultVisualSettings, HistorySettingsStore, validateLLMSettings } from "./settings.js";
import {
  clearHistoryData,
  ensureStorage,
  hardenStoragePermissions,
  latestHistoryArchive,
  makeStorageLayout,
  pruneHistoryArchives,
  restoreHistoryData,
  SegmentStore,
  segmentIdentifier,
} from "./storage.js";
import { TimelineRepository, type LLMRuntime, type LLMUnavailable } from "./timeline.js";
import type { TimelineAgentSessionFactory } from "./timeline-agent-runtime.js";
import { MemoryRepository } from "./memory.js";
import type {
  HistorySearchResponse,
  MemoryRollupRecord,
  AXSufficiencyEvidence,
  HistoryEvent,
  TimelineDocumentRecord,
  TimelineLLMSettings,
  VisualEvidence,
  VisualSettings,
  EventEvidenceEnrichment,
} from "./types.js";
import {
  evaluateAXByRules,
  judgeAXWithLuna,
  shouldAssessVisualEvidence,
  understandVisualWithLuna,
  visualEvidenceFromCapture,
  type VisualCapturePayload,
  type VisualCaptureProvider,
} from "./visual.js";
import {
  VisualCaptureScheduler,
  VisualUnderstandingCache,
  visualPayloadSignature,
  visualWindowKey,
  visualCaptureLimits,
} from "./visual-scheduler.js";

const unsupportedContinuationPattern =
  /(?:未|尚未|没有)(?:观察到|看到|发现|确认)|\b(?:not observed|not seen|no evidence)\b/i;
const explicitContinuationPattern =
  /^(?:(?:继续|完成|确认|检查|验证|处理|补充|更新|实现|修复|提交|回复|跟进|整理|查看|测试|部署|发布|合并|创建|配置|调查)|(?:continue|finish|complete|confirm|check|verify|follow up|update|fix|test|ship|deploy)\b)/i;

function publicContinuationHint(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    unsupportedContinuationPattern.test(normalized) ||
    !explicitContinuationPattern.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

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

export class HistoryService extends EventEmitter {
  private readonly layout;
  private readonly segments;
  private readonly settingsStore;
  private readonly timeline;
  private readonly memory;
  private readonly coalescer = new EventCoalescer();
  private readonly burstCoalescer = new EventBurstCoalescer();
  private readonly applicationIconPaths = new Map<string, string>();
  private policy: ObservationPolicy = structuredClone(defaultObservationPolicy);
  private llmSettings: TimelineLLMSettings = {
    enabled: false,
    memorySynthesisEnabled: false,
    protocol: "responses",
    model: "gpt-5.6-luna",
    endpoint: "https://api.openai.com/v1/responses",
  };
  private apiKeyConfigured = false;
  private visualSettings: VisualSettings = { ...defaultVisualSettings };
  private locale: AppLocale = "en";
  private recordingConsentGranted = false;
  private documents: TimelineDocumentRecord[] = [];
  private memories: MemoryRollupRecord[] = [];
  private historyRecovery?: HistoryRecovery;
  private lastError?: string;
  private initialized = false;
  private captureWork: Promise<unknown> = Promise.resolve();
  private timelineWork: Promise<unknown> = Promise.resolve();
  private timelineAgentWork: Promise<unknown> = Promise.resolve();
  private visualWork: Promise<unknown> = Promise.resolve();
  private visualDecisionWork: Promise<unknown> = Promise.resolve();
  private visualCaptureWork: Promise<unknown> = Promise.resolve();
  private visualUnderstandingWork: Promise<unknown> = Promise.resolve();
  private timelineAgentEnabled = false;
  private timelineAgentTimer?: NodeJS.Timeout;
  private readonly pendingVisualIntents = new Map<string, PendingVisualIntent>();
  private readonly visualCaptureScheduler = new VisualCaptureScheduler();
  private readonly visualUnderstandingCache = new VisualUnderstandingCache();
  private flushTimer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private receivedNativeEvent = false;
  private currentCaptureSegmentID?: string;
  private readonly semanticHealth = {
    keyboardSubmitCount: 0,
    keyboardShortcutCount: 0,
    textInputEventCount: 0,
    selectionEventCount: 0,
    capturedEventCount: 0,
    persistedEventCount: 0,
    policyBlockedEventCount: 0,
    deduplicatedEventCount: 0,
    burstCoalescedEventCount: 0,
  };
  private readonly visualHealth = {
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
    lastDecisionReason: undefined as string | undefined,
    lastCaptureDecisionReason: undefined as string | undefined,
  };

  constructor(
    private readonly collector: CollectorClient,
    storageRoot: string,
    private readonly visualCaptureProvider?: VisualCaptureProvider,
    timelineAgentSessionFactory?: TimelineAgentSessionFactory,
  ) {
    super();
    this.layout = makeStorageLayout(storageRoot);
    this.segments = new SegmentStore(this.layout);
    this.settingsStore = new HistorySettingsStore(this.layout);
    this.timeline = new TimelineRepository(
      this.layout,
      this.segments,
      async () => this.llmRuntime(),
      () => this.locale,
      timelineAgentSessionFactory,
    );
    this.memory = new MemoryRepository(
      this.layout,
      async () => {
        if (!this.llmSettings.memorySynthesisEnabled) return undefined;
        const runtime = await this.llmRuntime();
        return runtime && !("failureReason" in runtime) ? runtime : undefined;
      },
      () => this.locale,
    );
    collector.on("snapshot", () => this.emitSnapshot());
    collector.on("event", (event: HistoryEvent) => {
      if (!this.receivedNativeEvent) {
        this.receivedNativeEvent = true;
        console.info("[desklore] Native event stream connected.");
      }
      void this.enqueueCapture(async () => this.processEvent(event)).catch((error) =>
        this.captureError(error),
      );
    });
  }

  current(): DesktopSnapshot {
    const native = this.collector.current();
    const snapshot: HistorySnapshot | undefined = native.snapshot
      ? {
          recorderState: native.snapshot.recorderState,
          storageRoot: this.layout.root,
          activeApplication: native.snapshot.activeApplication,
          activeApplicationAllowed: native.snapshot.activeApplication
            ? allowsApplication(this.policy, native.snapshot.activeApplication.bundleIdentifier)
            : undefined,
          activeDomain: native.snapshot.activeDomain,
          activeDomainAllowed: native.snapshot.activeDomain
            ? allowsDomain(this.policy, native.snapshot.activeDomain)
            : undefined,
          documents: this.documents.map((document) => this.publicDocument(document)),
          memories: this.memories.map((record) => this.publicMemory(record)),
          health: { ...native.snapshot.health, ...this.semanticHealth },
          llm: { ...this.llmSettings, apiKeyConfigured: this.apiKeyConfigured },
          visual: {
            ...this.visualSettings,
            ...this.visualHealth,
            providerStatus:
              this.visualSettings.captureMode === "off"
                ? "disabled"
                : (this.visualCaptureProvider?.status() ?? "unavailable"),
          },
          lastError: this.lastError ?? native.snapshot.lastError,
        }
      : undefined;
    return {
      locale: this.locale,
      connectionState: native.connectionState,
      recordingConsentGranted: this.recordingConsentGranted,
      observationPolicy: structuredClone(this.policy),
      history: snapshot,
      connectionError: native.connectionError,
      historyRecovery: this.historyRecovery,
    };
  }

  async start(): Promise<DesktopSnapshot> {
    await this.initialize();
    if (!this.recordingConsentGranted) return this.current();
    const recovered = await this.segments.recoverExpiredSegments();
    const completed = await this.segments.pendingClosedSegments();
    await this.collector.start();
    await this.syncObservationPolicyToCollector();
    await this.collector.request("start");
    this.timelineAgentEnabled = true;
    this.startTimers();
    await this.refreshDocuments();
    void this.enqueueTimeline(async () => {
      const byID = new Map(
        [...recovered, ...completed].map((segment) => [segment.metadata.id, segment]),
      );
      await this.timeline.generatePending(
        [...byID.values()].sort(
          (lhs, rhs) => Date.parse(lhs.metadata.startedAt) - Date.parse(rhs.metadata.startedAt),
        ),
      );
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
    return this.current();
  }

  async grantRecordingConsent(): Promise<DesktopSnapshot> {
    await this.initialize();
    if (!this.recordingConsentGranted) {
      await this.settingsStore.grantRecordingConsent();
      this.recordingConsentGranted = true;
      this.emitSnapshot();
    }
    return this.start();
  }

  async stop(): Promise<DesktopSnapshot> {
    this.timelineAgentEnabled = false;
    if (this.timelineAgentTimer) clearTimeout(this.timelineAgentTimer);
    this.timelineAgentTimer = undefined;
    this.timeline.abortAgentJobs();
    this.stopTimers();
    if (
      this.collector.current().connectionState === "connected" &&
      this.collector.current().snapshot?.recorderState === "running"
    ) {
      await this.collector.request("pause").catch(() => undefined);
    }
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    await this.captureWork;
    await this.visualWork;
    await this.collector.stop();
    await this.maintenance();
    await this.timelineAgentWork;
    await this.timelineWork;
    await this.timeline.pauseAgentJobs();
    return this.current();
  }

  async shutdown(): Promise<void> {
    await this.stop();
    this.timeline.disposeAgentRuntime();
  }

  terminate(): void {
    this.timelineAgentEnabled = false;
    if (this.timelineAgentTimer) clearTimeout(this.timelineAgentTimer);
    this.timelineAgentTimer = undefined;
    this.timeline.disposeAgentRuntime();
    this.cancelAllPendingVisualIntents();
    this.stopTimers();
    this.collector.terminate();
  }

  async pause(): Promise<DesktopSnapshot> {
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    await this.visualWork;
    await this.collector.request("pause");
    return this.current();
  }

  async resume(): Promise<DesktopSnapshot> {
    await this.collector.request("resume");
    return this.current();
  }

  async requestNative(command: string): Promise<DesktopSnapshot> {
    await this.collector.request(command);
    return this.current();
  }

  async setActiveApplicationAllowed(allowed: boolean): Promise<DesktopSnapshot> {
    const application = this.collector.current().snapshot?.activeApplication;
    if (!application) return this.current();
    const next = structuredClone(this.policy);
    next.allowedBundleIdentifiers = next.allowedBundleIdentifiers.filter(
      (id) => id !== application.bundleIdentifier,
    );
    next.blockedBundleIdentifiers = next.blockedBundleIdentifiers.filter(
      (id) => id !== application.bundleIdentifier,
    );
    if (allowed && next.defaultApplicationBehavior === "do_not_observe") {
      next.allowedBundleIdentifiers.push(application.bundleIdentifier);
    } else if (!allowed) {
      next.blockedBundleIdentifiers.push(application.bundleIdentifier);
    }
    return this.updateObservationPolicy(next);
  }

  async setActiveDomainAllowed(allowed: boolean): Promise<DesktopSnapshot> {
    const domain = this.collector.current().snapshot?.activeDomain;
    if (!domain) return this.current();
    const next = structuredClone(this.policy);
    next.allowedDomains = next.allowedDomains.filter((value) => value !== domain);
    next.blockedDomains = next.blockedDomains.filter((value) => value !== domain);
    if (allowed && next.defaultURLBehavior === "do_not_observe") {
      next.allowedDomains.push(domain);
    } else if (!allowed) {
      next.blockedDomains.push(domain);
    }
    return this.updateObservationPolicy(next);
  }

  async updateObservationPolicy(policy: ObservationPolicy): Promise<DesktopSnapshot> {
    await this.initialize();
    const next = normalizeObservationPolicy(policy);
    await this.settingsStore.savePolicy(next);
    this.policy = next;
    this.cancelAllPendingVisualIntents();
    if (this.collector.current().connectionState === "connected") {
      try {
        await this.syncObservationPolicyToCollector();
      } catch (error) {
        await this.collector.request("pause").catch(() => undefined);
        this.lastError =
          error instanceof Error ? error.message : "Failed to update observation policy";
        this.emitSnapshot();
        throw error;
      }
    }
    this.lastError = undefined;
    this.emitSnapshot();
    return this.current();
  }

  async setLocale(locale: AppLocale): Promise<DesktopSnapshot> {
    await this.initialize();
    await this.settingsStore.saveLocale(locale);
    this.locale = locale;
    this.wakeTimelineAgentJobs("locale_changed");
    this.lastError = undefined;
    this.emitSnapshot();
    return this.current();
  }

  async configureLLM(input: LLMConfigurationInput): Promise<DesktopSnapshot> {
    const next = {
      ...this.llmSettings,
      protocol: input.protocol,
      model: input.model.trim(),
      endpoint: input.endpoint.trim(),
    };
    if (!validateLLMSettings(next)) {
      this.lastError = translate(this.locale, "error.invalidModelSettings");
      this.emitSnapshot();
      return this.current();
    }
    const apiKey = input.apiKey.trim();
    if (apiKey) await this.settingsStore.saveAPIKey(apiKey, this.locale);
    await this.settingsStore.saveLLMSettings(next);
    this.llmSettings = next;
    this.visualUnderstandingCache.clear();
    this.apiKeyConfigured = await this.settingsStore.hasAPIKey();
    this.wakeTimelineAgentJobs("configuration_changed");
    this.lastError = undefined;
    void this.enqueueTimeline(async () => {
      const segments = await this.segments.pendingClosedSegments();
      for (const segment of segments) await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
    return this.current();
  }

  async setLLMEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    const next = { ...this.llmSettings, enabled };
    await this.settingsStore.saveLLMSettings(next);
    this.llmSettings = next;
    this.lastError = undefined;
    if (!enabled) this.timeline.abortAgentJobs();
    else this.wakeTimelineAgentJobs("model_enabled");
    return this.current();
  }

  async setMemorySynthesisEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    const next = { ...this.llmSettings, memorySynthesisEnabled: enabled };
    await this.settingsStore.saveLLMSettings(next);
    this.llmSettings = next;
    this.lastError = undefined;
    return this.current();
  }

  async configureVisual(input: VisualSettings): Promise<DesktopSnapshot> {
    const valid =
      ["rules", "luna"].includes(input.axJudge) &&
      ["off", "fallback"].includes(input.captureMode) &&
      ["off", "ocr", "luna"].includes(input.understandingMode);
    if (!valid) throw new Error("Invalid visual configuration");
    if (input.captureMode === "off") this.cancelAllPendingVisualIntents();
    await this.settingsStore.saveVisualSettings(input);
    this.visualSettings = { ...input };
    if (input.captureMode === "off" || input.understandingMode !== "luna") {
      this.visualUnderstandingCache.clear();
    }
    this.lastError = undefined;
    this.emitSnapshot();
    return this.current();
  }

  async requestScreenCapturePermission(): Promise<DesktopSnapshot> {
    if (!this.visualCaptureProvider) {
      this.lastError = translate(this.locale, "error.visualProviderUnavailable");
      this.emitSnapshot();
      return this.current();
    }
    await this.visualCaptureProvider.requestPermission();
    return this.current();
  }

  async removeLLMAPIKey(): Promise<DesktopSnapshot> {
    await this.settingsStore.removeAPIKey();
    this.visualUnderstandingCache.clear();
    this.apiKeyConfigured = Boolean(process.env.OPENAI_API_KEY);
    this.wakeTimelineAgentJobs("credential_changed");
    this.emitSnapshot();
    return this.current();
  }

  async openDocument(id: string): Promise<DesktopSnapshot> {
    const document = this.documents.find((item) => item.id === id);
    if (!document?.filePath) throw new Error("Timeline document not found");
    const error = await shell.openPath(document.filePath);
    if (error) this.lastError = error;
    this.emitSnapshot();
    return this.current();
  }

  async deleteDocument(id: string): Promise<DesktopSnapshot> {
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error("Timeline document not found");
    await this.timeline.deleteAgentJob(document.sourceSegmentID);
    await this.timelineAgentWork;
    await this.enqueueTimeline(async () => {
      await this.segments.deleteSegment(document.sourceSegmentID);
      await this.timeline.delete(document);
      await this.refreshDocuments();
    });
    return this.current();
  }

  async clearHistory(): Promise<DesktopSnapshot> {
    await this.initialize();
    this.stopTimers();
    this.timelineAgentEnabled = false;
    if (this.timelineAgentTimer) clearTimeout(this.timelineAgentTimer);
    this.timelineAgentTimer = undefined;
    this.timeline.abortAgentJobs();
    if (
      this.collector.current().connectionState === "connected" &&
      this.collector.current().snapshot?.recorderState === "running"
    ) {
      await this.collector.request("pause").catch(() => undefined);
    }
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    await this.captureWork;
    this.cancelAllPendingVisualIntents();
    await this.visualWork;
    await this.timelineAgentWork;
    await this.timelineWork;
    this.historyRecovery = await clearHistoryData(this.layout, {
      documentCount: this.documents.length,
      memoryCount: this.memories.length,
    });
    this.segments.reset();
    this.coalescer.reset();
    this.burstCoalescer.reset();
    this.documents = [];
    this.memories = [];
    this.applicationIconPaths.clear();
    this.visualUnderstandingCache.clear();
    this.currentCaptureSegmentID = undefined;
    this.lastError = undefined;
    if (this.collector.current().connectionState === "connected") this.startTimers();
    if (this.collector.current().connectionState === "connected") {
      this.timelineAgentEnabled = true;
      this.kickTimelineAgent();
    }
    this.emitSnapshot();
    return this.current();
  }

  async restoreHistory(id: string): Promise<DesktopSnapshot> {
    await this.initialize();
    this.stopTimers();
    this.timelineAgentEnabled = false;
    if (this.timelineAgentTimer) clearTimeout(this.timelineAgentTimer);
    this.timelineAgentTimer = undefined;
    this.timeline.abortAgentJobs();
    const wasRunning =
      this.collector.current().connectionState === "connected" &&
      this.collector.current().snapshot?.recorderState === "running";
    if (wasRunning) await this.collector.request("pause").catch(() => undefined);
    try {
      await this.enqueueCapture(async () => {
        for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
      });
      await this.captureWork;
      this.cancelAllPendingVisualIntents();
      await this.visualWork;
      await this.timelineAgentWork;
      await this.timelineWork;
      await restoreHistoryData(this.layout, id);
      this.segments.reset();
      this.coalescer.reset();
      this.burstCoalescer.reset();
      this.applicationIconPaths.clear();
      this.visualUnderstandingCache.clear();
      this.currentCaptureSegmentID = undefined;
      this.historyRecovery = await latestHistoryArchive(this.layout);
      this.lastError = undefined;
      await this.refreshDocuments();
    } catch (error) {
      if (wasRunning) await this.collector.request("resume").catch(() => undefined);
      if (this.collector.current().connectionState === "connected") {
        this.startTimers();
        this.timelineAgentEnabled = true;
        this.kickTimelineAgent();
      }
      throw error;
    }
    if (this.collector.current().connectionState === "connected") {
      this.startTimers();
      this.timelineAgentEnabled = true;
      this.kickTimelineAgent();
    }
    this.emitSnapshot();
    return this.current();
  }

  async revealStorage(): Promise<DesktopSnapshot> {
    const error = await shell.openPath(this.layout.timeline);
    if (error) this.lastError = error;
    this.emitSnapshot();
    return this.current();
  }

  searchMemory(query: string): HistorySearchResponse {
    return this.memory.search(query, this.documents, this.memories);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureStorage(this.layout);
    await hardenStoragePermissions(this.layout);
    [
      this.locale,
      this.policy,
      this.llmSettings,
      this.visualSettings,
      this.recordingConsentGranted,
    ] = await Promise.all([
      this.settingsStore.loadLocale(),
      this.settingsStore.loadPolicy(),
      this.settingsStore.loadLLMSettings(),
      this.settingsStore.loadVisualSettings(),
      this.settingsStore.hasRecordingConsent(),
    ]);
    this.apiKeyConfigured = await this.settingsStore.hasAPIKey();
    this.historyRecovery = await latestHistoryArchive(this.layout);
    this.documents = await this.timeline.loadDocuments();
    this.memories = await this.memory.refresh(this.documents);
    this.initialized = true;
  }

  private async processEvent(event: HistoryEvent): Promise<void> {
    const eventSegmentID = segmentIdentifier(new Date(event.timestamp));
    if (this.currentCaptureSegmentID && this.currentCaptureSegmentID !== eventSegmentID) {
      for (const pending of this.burstCoalescer.flushAll()) await this.persist(pending);
    }
    this.currentCaptureSegmentID = eventSegmentID;
    this.semanticHealth.capturedEventCount += 1;
    const sanitized = applyObservationPolicy(this.policy, event);
    const capturedClosed = await this.segments.recordMetric(event.timestamp, "captured");
    if (capturedClosed) this.scheduleTimeline(capturedClosed);
    if (!sanitized) {
      this.semanticHealth.policyBlockedEventCount += 1;
      const closed = await this.segments.recordSuppressed(event.timestamp);
      if (closed) this.scheduleTimeline(closed);
      return;
    }
    const normalized = this.coalescer.process(classifyKeyboardEvent(sanitized));
    if (!normalized) {
      this.semanticHealth.deduplicatedEventCount += 1;
      const closed = await this.segments.recordMetric(event.timestamp, "deduplicated");
      if (closed) this.scheduleTimeline(closed);
      return;
    }
    if (normalized.kind === "keyboard.submit") this.semanticHealth.keyboardSubmitCount += 1;
    if (normalized.kind === "keyboard.shortcut") this.semanticHealth.keyboardShortcutCount += 1;
    if (normalized.kind === "keyboard.text_input") this.semanticHealth.textInputEventCount += 1;
    if (normalized.kind === "selection.changed") this.semanticHealth.selectionEventCount += 1;
    const burst = this.burstCoalescer.ingest(normalized);
    if (burst.coalescedCount > 0) {
      this.semanticHealth.burstCoalescedEventCount += burst.coalescedCount;
      const closed = await this.segments.recordMetric(
        event.timestamp,
        "burstCoalesced",
        burst.coalescedCount,
      );
      if (closed) this.scheduleTimeline(closed);
    }
    for (const ready of burst.ready) await this.persist(ready);
  }

  private async persist(event: HistoryEvent): Promise<void> {
    const closed = await this.segments.append(event);
    this.semanticHealth.persistedEventCount += 1;
    this.scheduleVisualEnrichment(event);
    if (closed) this.scheduleTimeline(closed);
  }

  private scheduleTimeline(
    segment: NonNullable<Awaited<ReturnType<SegmentStore["closeExpired"]>>>,
  ): void {
    const pendingVisualWork = this.visualWork;
    void this.enqueueTimeline(async () => {
      await pendingVisualWork;
      await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
  }

  private async maintenance(): Promise<void> {
    for (const event of this.burstCoalescer.flushExpired()) await this.persist(event);
    const closed = await this.segments.closeExpired();
    if (closed) this.scheduleTimeline(closed);
    const recovered = await this.segments.recoverExpiredSegments();
    for (const segment of recovered) this.scheduleTimeline(segment);
    const completed = await this.segments.pendingClosedSegments();
    await this.segments.pruneVisualEvidence(new Date(Date.now() - 24 * 60 * 60 * 1_000));
    await this.segments.pruneSegments(new Date(Date.now() - 48 * 60 * 60 * 1_000));
    await pruneHistoryArchives(this.layout, new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000));
    this.historyRecovery = await latestHistoryArchive(this.layout);
    void this.enqueueTimeline(async () => {
      for (const segment of completed) await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
  }

  private async refreshDocuments(): Promise<void> {
    this.documents = await this.timeline.loadDocuments();
    this.memories = await this.memory.refresh(this.documents);
    const bundleIdentifiers = [
      ...new Set(
        this.documents
          .flatMap((document) => document.applications)
          .map((application) => application.bundleIdentifier)
          .filter((id) => !this.applicationIconPaths.has(id)),
      ),
    ];
    if (bundleIdentifiers.length && this.collector.current().connectionState === "connected") {
      try {
        const payload = await this.collector.requestPayload<{ iconPaths?: Record<string, string> }>(
          "resolveApplicationIcons",
          { bundleIdentifiers },
        );
        for (const [id, iconPath] of Object.entries(payload?.iconPaths ?? {})) {
          this.applicationIconPaths.set(id, iconPath);
        }
      } catch {
        // Timeline content remains usable when an application bundle is no longer installed.
      }
    }
    this.emitSnapshot();
  }

  private publicDocument(document: TimelineDocumentRecord): TimelineDocument {
    return {
      id: document.id,
      startedAt: document.startedAt,
      endedAt: document.endedAt,
      title: document.title,
      description: document.description,
      applications: document.applications.map((application): TimelineApplication => ({
        ...application,
        iconPath: this.applicationIconPaths.get(application.bundleIdentifier),
      })),
      generatorType: document.generator.type,
      generatorFailureReason: document.generator.failureReason,
    };
  }

  private publicMemory(record: MemoryRollupRecord): MemoryRollup {
    return {
      id: record.id,
      kind: record.kind,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      title: record.title,
      description: record.description,
      continuationHint: publicContinuationHint(record.continuationHint),
      applications: record.applications.slice(0, 6).map((application): TimelineApplication => ({
        ...application,
        iconPath: this.applicationIconPaths.get(application.bundleIdentifier),
      })),
      sourceDocumentIDs: record.sourceDocumentIDs,
    };
  }

  private async llmRuntime(): Promise<LLMRuntime | LLMUnavailable | undefined> {
    if (!this.llmSettings.enabled) return undefined;
    const apiKey = await this.settingsStore.loadAPIKey();
    return apiKey
      ? { settings: this.llmSettings, apiKey }
      : { settings: this.llmSettings, failureReason: "api_key_missing" };
  }

  private async configuredLLMRuntime(): Promise<LLMRuntime | undefined> {
    const apiKey = await this.settingsStore.loadAPIKey();
    return apiKey ? { settings: this.llmSettings, apiKey } : undefined;
  }

  private scheduleVisualEnrichment(event: HistoryEvent): void {
    if (!shouldAssessVisualEvidence(event)) return;
    const settings = { ...this.visualSettings };
    if (settings.axJudge === "rules" && settings.captureMode === "off") {
      return;
    }
    const ruleDecision = evaluateAXByRules(event);
    const assessmentStartedAt = new Date().toISOString();
    const intentKey = visualWindowKey(event);
    this.cancelPendingVisualIntent(intentKey);
    const evaluation = this.evaluateVisualEvidence(event, settings, ruleDecision);
    const shouldCreateIntent =
      settings.captureMode === "fallback" &&
      (ruleDecision.decision === "needs_visual" ||
        (ruleDecision.decision === "uncertain" && settings.axJudge === "luna"));
    const task = shouldCreateIntent
      ? this.runVisualIntent(event, settings, intentKey, assessmentStartedAt, evaluation)
      : evaluation.then((result) =>
          this.completeVisualEvidence(
            event,
            settings,
            result,
            {
              kind: "decision_cancelled",
            },
            assessmentStartedAt,
          ),
        );
    void this.trackVisual(task).catch((error) => this.captureError(error));
  }

  private evaluateVisualEvidence(
    event: HistoryEvent,
    settings: VisualSettings,
    ruleDecision: ReturnType<typeof evaluateAXByRules>,
  ): Promise<VisualEvaluation> {
    const runtime =
      settings.axJudge === "luna" || settings.understandingMode === "luna"
        ? this.configuredLLMRuntime()
        : Promise.resolve(undefined);
    const decision =
      settings.axJudge === "luna" && ruleDecision.decision === "uncertain"
        ? this.enqueueVisualDecision(async () => {
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

  private runVisualIntent(
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
        if (this.pendingVisualIntents.get(intentKey) === pending) {
          this.pendingVisualIntents.delete(intentKey);
        }
        if (pending.decision && pending.decision.decision !== "needs_visual") {
          resolve({ kind: "decision_cancelled" });
          return;
        }
        this.visualHealth.captureCandidateCount += 1;
        void this.enqueueVisualCapture(() =>
          this.captureVisualEvidence(event, settings.understandingMode),
        ).then((capture) => resolve({ kind: "candidate", capture }), reject);
      }, visualCaptureLimits.settleMilliseconds);
      pending = {
        timer,
        settled: false,
        resolve,
      };
      this.pendingVisualIntents.set(intentKey, pending);
    });
    void evaluation
      .then(({ axSufficiency }) => {
        pending.decision = axSufficiency;
        if (!pending.settled && axSufficiency.decision !== "needs_visual") {
          pending.settled = true;
          clearTimeout(pending.timer);
          if (this.pendingVisualIntents.get(intentKey) === pending) {
            this.pendingVisualIntents.delete(intentKey);
          }
          pending.resolve({ kind: "decision_cancelled" });
        }
      })
      .catch(() => undefined);
    return Promise.all([evaluation, candidate]).then(([result, outcome]) =>
      this.completeVisualEvidence(event, settings, result, outcome, assessmentStartedAt),
    );
  }

  private cancelPendingVisualIntent(
    intentKey: string,
    outcome: "coalesced" | "decision_cancelled" = "coalesced",
  ): void {
    const pending = this.pendingVisualIntents.get(intentKey);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingVisualIntents.delete(intentKey);
    if (outcome === "coalesced") this.visualHealth.captureCoalescedCount += 1;
    pending.resolve({ kind: outcome });
  }

  private cancelAllPendingVisualIntents(): void {
    for (const intentKey of this.pendingVisualIntents.keys()) {
      this.cancelPendingVisualIntent(intentKey, "decision_cancelled");
    }
  }

  private async completeVisualEvidence(
    event: HistoryEvent,
    settings: VisualSettings,
    evaluation: VisualEvaluation,
    outcome: VisualCandidateOutcome,
    assessmentStartedAt: string,
  ): Promise<void> {
    const { axSufficiency, runtime } = evaluation;

    this.visualHealth.judgedEventCount += 1;
    if (axSufficiency.decision === "needs_visual") this.visualHealth.needsVisualCount += 1;
    if (axSufficiency.decision === "uncertain") this.visualHealth.uncertainCount += 1;
    this.visualHealth.lastDecisionReason = axSufficiency.reasons.join(",").slice(0, 240);

    let visual: VisualEvidence | undefined;
    const capture = outcome.kind === "candidate" ? outcome.capture : undefined;
    if (capture) this.observeVisualCapture(capture.payload);
    if (settings.captureMode === "fallback" && axSufficiency.decision === "needs_visual") {
      if (capture) {
        visual = await this.processVisualCandidate(event, settings, runtime, capture);
      } else if (outcome.kind === "coalesced") {
        visual = {
          requestID: randomUUID().toLowerCase(),
          status: "blocked",
          provider: this.visualCaptureProvider?.id ?? "none",
          reason: "visual_intent_coalesced",
          privacy: "not_captured",
        };
        this.visualHealth.lastCaptureDecisionReason = "visual_intent_coalesced";
      }
    } else if (settings.captureMode === "fallback" && axSufficiency.decision === "uncertain") {
      this.visualHealth.visualGapCount += 1;
      if (capture?.payload.status === "captured") {
        visual = this.discardVisualCandidate(capture, "candidate_discarded_ax_uncertain");
      } else if (outcome.kind === "coalesced") {
        visual = {
          requestID: randomUUID().toLowerCase(),
          status: "blocked",
          provider: this.visualCaptureProvider?.id ?? "none",
          reason: "visual_intent_coalesced",
          privacy: "not_captured",
        };
      } else {
        visual = {
          requestID: capture?.requestID ?? randomUUID().toLowerCase(),
          status: "unavailable",
          provider: capture?.payload.provider ?? this.visualCaptureProvider?.id ?? "none",
          reason: "ax_judge_uncertain",
          privacy: "not_captured",
        };
      }
      this.visualHealth.lastCaptureDecisionReason = visual.reason;
    } else if (axSufficiency.decision === "enough" && capture?.payload.status === "captured") {
      visual = this.discardVisualCandidate(capture, "candidate_discarded_ax_enough");
    }

    const enrichment: EventEvidenceEnrichment = {
      schemaVersion: 1,
      eventID: event.id,
      eventTimestamp: event.timestamp,
      assessmentStartedAt,
      createdAt: new Date().toISOString(),
      axSufficiency,
      visual,
    };
    await this.segments.appendEvidence(enrichment);
    this.emitSnapshot();
  }

  private observeVisualCapture(payload: VisualCapturePayload): void {
    if (payload.status === "captured") this.visualHealth.captureSucceededCount += 1;
    else if (payload.status === "blocked") this.visualHealth.captureBlockedCount += 1;
    else this.visualHealth.captureFailedCount += 1;
  }

  private discardVisualCandidate(capture: VisualCaptureResponse, reason: string): VisualEvidence {
    this.visualHealth.captureDiscardedCount += 1;
    this.visualHealth.lastCaptureDecisionReason = reason;
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

  private async processVisualCandidate(
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
    const cached = signature ? this.visualUnderstandingCache.get(windowKey, signature) : undefined;
    if (cached) {
      visual.understanding = cached.understanding;
      visual.confidence = cached.confidence;
      visual.privacy = "redacted_remote";
      visual.reason = "visual_reused";
      this.visualHealth.visualUnchangedCount += 1;
      this.visualHealth.visualReusedCount += 1;
      this.visualHealth.lastCaptureDecisionReason = "visual_reused";
      return visual;
    }
    try {
      this.visualHealth.visionCalledCount += 1;
      const result = await this.enqueueVisualUnderstanding(() =>
        understandVisualWithLuna(event, capture.payload, runtime),
      );
      visual.understanding = result.understanding;
      visual.confidence = result.confidence;
      visual.privacy = "redacted_remote";
      this.visualHealth.lastCaptureDecisionReason = "vision_called";
      if (signature) {
        this.visualUnderstandingCache.set(windowKey, signature, {
          ...result,
          createdAtMilliseconds: Date.now(),
        });
      }
    } catch (error) {
      visual.reason = `visual_model_${error instanceof Error ? error.message : "failed"}`;
      this.visualHealth.lastCaptureDecisionReason = visual.reason;
    }
    return visual;
  }

  private async captureVisualEvidence(
    event: HistoryEvent,
    understandingMode: VisualSettings["understandingMode"] = this.visualSettings.understandingMode,
    nowMilliseconds = Date.now(),
  ): Promise<{ requestID: string; payload: VisualCapturePayload }> {
    const requestID = randomUUID().toLowerCase();
    if (!observationDecision(this.policy, event).allowed) {
      return {
        requestID,
        payload: {
          status: "blocked",
          reason: "policy_excluded",
          provider: this.visualCaptureProvider?.id ?? "none",
        },
      };
    }
    if (!this.visualCaptureProvider) {
      this.visualCaptureScheduler.recordProviderFailure(nowMilliseconds);
      this.visualHealth.lastCaptureDecisionReason = "provider_unavailable";
      return {
        requestID,
        payload: {
          status: "unavailable",
          reason: "provider_unavailable",
          provider: "none",
        },
      };
    }
    const gate = this.visualCaptureScheduler.reserve(event, nowMilliseconds);
    if (!gate.allowed) {
      if (gate.reason === "window_cooldown") this.visualHealth.captureCooldownCount += 1;
      if (gate.reason === "provider_backoff") this.visualHealth.captureBackoffCount += 1;
      this.visualHealth.lastCaptureDecisionReason = gate.reason;
      return {
        requestID,
        payload: {
          status: "blocked",
          reason: gate.reason,
          provider: this.visualCaptureProvider.id,
        },
      };
    }
    const providerStatus = this.visualCaptureProvider.status();
    if (providerStatus !== "ready") {
      this.visualCaptureScheduler.recordProviderFailure(nowMilliseconds);
      const reason = `provider_${providerStatus}`;
      this.visualHealth.lastCaptureDecisionReason = reason;
      return {
        requestID,
        payload: {
          status: "unavailable",
          reason,
          provider: this.visualCaptureProvider.id,
        },
      };
    }
    this.visualHealth.captureRequestedCount += 1;
    this.visualHealth.lastCaptureDecisionReason = "capture_requested";
    const eventTime = Date.parse(event.timestamp);
    const eventExpiresAt = Number.isFinite(eventTime)
      ? Math.min(nowMilliseconds + 8_000, eventTime + 8_000)
      : nowMilliseconds + 8_000;
    try {
      const payload = await this.visualCaptureProvider.capture({
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
        this.visualCaptureScheduler.recordProviderSuccess();
        this.visualHealth.lastCaptureDecisionReason = "captured";
      } else if (
        payload.status === "failed" ||
        (payload.status === "unavailable" &&
          payload.reason !== "request_expired" &&
          payload.reason !== "target_window_unavailable")
      ) {
        this.visualCaptureScheduler.recordProviderFailure(nowMilliseconds);
        this.visualHealth.lastCaptureDecisionReason = payload.reason ?? payload.status;
      } else {
        this.visualHealth.lastCaptureDecisionReason = payload.reason ?? payload.status;
      }
      return {
        requestID,
        payload,
      };
    } catch (error) {
      this.visualCaptureScheduler.recordProviderFailure(nowMilliseconds);
      const reason = `provider_${error instanceof Error ? error.message : "request_failed"}`;
      this.visualHealth.lastCaptureDecisionReason = reason;
      return {
        requestID,
        payload: {
          status: "failed",
          reason,
          provider: this.visualCaptureProvider.id,
        },
      };
    }
  }

  private async syncObservationPolicyToCollector(): Promise<void> {
    await this.collector.request("configureObservationPolicy", {
      observationPolicy: this.policy,
    });
  }

  private kickTimelineAgent(delayMilliseconds = 0): void {
    if (!this.timelineAgentEnabled || this.timelineAgentTimer) return;
    this.timelineAgentTimer = setTimeout(
      () => {
        this.timelineAgentTimer = undefined;
        if (!this.timelineAgentEnabled) return;
        void this.enqueueTimelineAgent(async () => {
          const segments = await this.segments.pendingClosedSegments();
          const outcome = await this.timeline.advanceNextAgentJob(segments);
          if (outcome.upgraded) {
            await this.enqueueTimeline(async () => this.refreshDocuments());
          }
          return outcome;
        })
          .then((outcome) => {
            if (!this.timelineAgentEnabled || !outcome.pending) return;
            if (outcome.processed) {
              this.kickTimelineAgent();
              return;
            }
            if (outcome.nextWakeAt) {
              this.kickTimelineAgent(Math.max(1_000, Date.parse(outcome.nextWakeAt) - Date.now()));
            }
          })
          .catch((error) => this.captureError(error));
      },
      Math.max(0, delayMilliseconds),
    );
  }

  private wakeTimelineAgentJobs(reason: string): void {
    this.timeline.abortAgentJobs();
    void this.enqueueTimelineAgent(async () => this.timeline.wakeAgentJobs(reason))
      .then(() => this.kickTimelineAgent())
      .catch((error) => this.captureError(error));
  }

  private startTimers(): void {
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        void this.enqueueCapture(async () => {
          for (const event of this.burstCoalescer.flushExpired()) await this.persist(event);
        }).catch((error) => this.captureError(error));
      }, 250);
    }
    if (!this.maintenanceTimer) {
      this.maintenanceTimer = setInterval(() => {
        void this.enqueueCapture(async () => this.maintenance()).catch((error) =>
          this.captureError(error),
        );
      }, 30_000);
    }
  }

  private stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.flushTimer = undefined;
    this.maintenanceTimer = undefined;
  }

  private enqueueCapture<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.captureWork.then(operation, operation);
    this.captureWork = next.catch(() => undefined);
    return next;
  }

  private enqueueTimeline<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.timelineWork.then(operation, operation);
    this.timelineWork = next.catch(() => undefined);
    return next;
  }

  private enqueueTimelineAgent<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.timelineAgentWork.then(operation, operation);
    this.timelineAgentWork = next.catch(() => undefined);
    return next;
  }

  private enqueueVisualDecision<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.visualDecisionWork.then(operation, operation);
    this.visualDecisionWork = next.catch(() => undefined);
    return next;
  }

  private enqueueVisualCapture<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.visualCaptureWork.then(operation, operation);
    this.visualCaptureWork = next.catch(() => undefined);
    return next;
  }

  private enqueueVisualUnderstanding<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.visualUnderstandingWork.then(operation, operation);
    this.visualUnderstandingWork = next.catch(() => undefined);
    return next;
  }

  private trackVisual<T>(task: Promise<T>): Promise<T> {
    const observed = task.catch(() => undefined);
    this.visualWork = Promise.all([this.visualWork, observed]).then(() => undefined);
    return task;
  }

  private captureError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    console.error("[desklore] History pipeline failed:", error);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.current());
  }
}
