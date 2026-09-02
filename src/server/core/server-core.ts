import { EventEmitter } from "node:events";
import {
  type CollectorPort,
  type CredentialStore,
  type ServerCoreConfig,
  type ServerCoreDependencies,
} from "./ports.js";
import type { NativePermissionCommand } from "../api/messages.js";
import type {
  ApplicationUsageSummary,
  HistorySnapshot,
  DesktopSnapshot,
  HistoryRecovery,
  LLMConfigurationInput,
  TimelineRollup,
  ObservationPolicy,
  TimelineApplication,
  TimelineDocument,
} from "../../shared/contracts/index.js";
import type { AppLocale } from "../../shared/i18n/index.js";
import { translate } from "../../shared/i18n/index.js";
import { defaultObservationPolicy } from "../../shared/defaults.js";
import { validateModelConfiguration } from "../../shared/model.js";
import {
  classifyKeyboardEvent,
  EventBurstCoalescer,
  EventCoalescer,
} from "../history/events/coalescer.js";
import { RecorderAvailabilityTracker } from "../history/availability/tracker.js";
import { recorderAvailabilityHeartbeatMilliseconds } from "../history/availability/contracts.js";
import {
  allowsApplication,
  allowsDomain,
  applyObservationPolicy,
  normalizeObservationPolicy,
  observationDecision,
} from "../history/policy/policy.js";
import {
  defaultLLMSettings,
  defaultVisualSettings,
  HistorySettingsStore,
} from "../history/settings/store.js";
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
} from "../history/storage/repository.js";
import {
  TimelineRepository,
  type LLMRuntime,
  type LLMUnavailable,
} from "../history/timeline/repository.js";
import { TimelineRollupRepository } from "../history/rollup/repository.js";
import { UsageTracker } from "../history/usage/tracker.js";
import type {
  HistorySearchResponse,
  TimelineRollupRecord,
  HistoryEvent,
  TimelineDocumentRecord,
  TimelineLLMSettings,
  VisualSettings,
  UsageStateEvent,
} from "../history/contracts.js";
import { VisualEnrichmentCoordinator } from "../history/visual/coordinator.js";

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

export class ServerCore extends EventEmitter {
  private readonly layout;
  private readonly segments;
  private readonly settingsStore;
  private readonly timeline;
  private readonly rollup;
  private readonly usage;
  private readonly recorderAvailability;
  private readonly collector: CollectorPort;
  private readonly credentials: CredentialStore;
  private readonly visual;
  private shutdownWork?: Promise<void>;
  private readonly coalescer = new EventCoalescer();
  private readonly burstCoalescer = new EventBurstCoalescer();
  private readonly applicationIconPaths = new Map<string, string>();
  private policy: ObservationPolicy = structuredClone(defaultObservationPolicy);
  private llmSettings: TimelineLLMSettings = { ...defaultLLMSettings };
  private apiKeyConfigured = false;
  private visualSettings: VisualSettings = { ...defaultVisualSettings };
  private locale: AppLocale = "en";
  private recordingConsentGranted = false;
  private documents: TimelineDocumentRecord[] = [];
  private rollups: TimelineRollupRecord[] = [];
  private historyRecovery?: HistoryRecovery;
  private lastError?: string;
  private initialized = false;
  private captureWork: Promise<unknown> = Promise.resolve();
  private timelineWork: Promise<unknown> = Promise.resolve();
  private timelineAgentWork: Promise<unknown> = Promise.resolve();
  private timelineAgentEnabled = false;
  private timelineAgentTimer?: NodeJS.Timeout;
  private timelineAgentWakeAt?: number;
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
  constructor(config: ServerCoreConfig, dependencies: ServerCoreDependencies) {
    super();
    this.collector = dependencies.collector;
    this.credentials = dependencies.credentials;
    this.layout = makeStorageLayout(config.storageRoot);
    this.segments = new SegmentStore(this.layout);
    this.settingsStore = new HistorySettingsStore(this.layout);
    this.timeline = new TimelineRepository(
      this.layout,
      this.segments,
      async () => this.llmRuntime(),
      () => this.locale,
      dependencies.timelineAgentSessions,
    );
    this.rollup = new TimelineRollupRepository(
      this.layout,
      async () => {
        if (!this.llmSettings.rollupSynthesisEnabled) return undefined;
        const runtime = await this.llmRuntime();
        return runtime && !("failureReason" in runtime) ? runtime : undefined;
      },
      () => this.locale,
    );
    this.usage = new UsageTracker(this.layout);
    this.recorderAvailability = new RecorderAvailabilityTracker(this.layout);
    this.visual = new VisualEnrichmentCoordinator({
      provider: dependencies.visualCapture,
      appendEvidence: (enrichment) => this.segments.appendEvidence(enrichment),
      eventAllowed: (event) => observationDecision(this.policy, event).allowed,
      configuredRuntime: () => this.configuredLLMRuntime(),
      onChanged: () => this.emitSnapshot(),
      onError: (error) => this.captureError(error),
    });
    this.collector.on("snapshot", () => {
      if (this.initialized) {
        void this.enqueueCapture(async () => {
          const connection = this.collector.current();
          await this.recorderAvailability.record(connection, "collector_snapshot");
          if (connection.connectionState !== "connected") {
            await this.usage.end(new Date(), "collector_disconnected");
          }
          this.emitSnapshot();
        }).catch((error) => this.captureError(error));
      }
      this.emitSnapshot();
    });
    this.collector.on("event", (event: HistoryEvent) => {
      if (!this.receivedNativeEvent) {
        this.receivedNativeEvent = true;
        console.info("[desklore] Native event stream connected.");
      }
      void this.enqueueCapture(async () => this.processEvent(event)).catch((error) =>
        this.captureError(error),
      );
    });
    this.collector.on("usage-state", (event: UsageStateEvent) => {
      void this.enqueueCapture(async () => {
        await this.recorderAvailability.recordUsageState(this.collector.current(), event);
        await this.usage.transition(event);
        if (event.application) {
          await this.resolveApplicationIcons([event.application.bundleIdentifier]);
        }
        this.emitSnapshot();
      }).catch((error) => this.captureError(error));
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
          rollups: this.rollups.map((record) => this.publicRollup(record)),
          usage: this.publicUsageSummary(this.usage.summary()),
          health: { ...native.snapshot.health, ...this.semanticHealth },
          llm: { ...this.llmSettings, apiKeyConfigured: this.apiKeyConfigured },
          visual: {
            ...this.visualSettings,
            ...this.visual.health(),
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

  async prepare(): Promise<DesktopSnapshot> {
    await this.initialize();
    return this.current();
  }

  async start(): Promise<DesktopSnapshot> {
    await this.initialize();
    if (!this.recordingConsentGranted) {
      return this.current();
    }
    const recovered = await this.segments.recoverExpiredSegments();
    const completed = await this.segments.pendingClosedSegments();
    await this.collector.start();
    await this.syncObservationPolicyToCollector();
    await this.collector.request("start");
    await this.captureWork;
    await this.recorderAvailability.record(this.collector.current(), "recorder_started");
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

  private async stop(): Promise<DesktopSnapshot> {
    this.timelineAgentEnabled = false;
    this.clearTimelineAgentTimer();
    this.timeline.abortAgentJobs();
    this.stopTimers();
    if (
      this.collector.current().connectionState === "connected" &&
      this.collector.current().snapshot?.recorderState === "running"
    ) {
      await this.collector.request("pause").catch(() => undefined);
      await this.captureWork;
    }
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    await this.captureWork;
    await this.visual.drain();
    await this.collector.stop();
    await this.maintenance();
    await this.recorderAvailability.stop(this.collector.current());
    await this.timelineAgentWork;
    await this.timelineWork;
    await this.timeline.pauseAgentJobs();
    return this.current();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.shutdownWork = (async () => {
      await this.stop();
      this.timeline.disposeAgentRuntime();
    })();
    return this.shutdownWork;
  }

  terminate(): void {
    this.timelineAgentEnabled = false;
    this.clearTimelineAgentTimer();
    this.timeline.disposeAgentRuntime();
    this.visual.cancelPending();
    this.stopTimers();
    this.collector.terminate();
  }

  async pause(): Promise<DesktopSnapshot> {
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    await this.visual.drain();
    await this.collector.request("pause");
    await this.captureWork;
    return this.current();
  }

  async resume(): Promise<DesktopSnapshot> {
    await this.collector.request("resume");
    await this.captureWork;
    return this.current();
  }

  async requestNative(command: NativePermissionCommand): Promise<DesktopSnapshot> {
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
    this.visual.cancelPending();
    if (this.collector.current().connectionState === "connected") {
      try {
        await this.syncObservationPolicyToCollector();
        await this.captureWork;
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
    if (!validateModelConfiguration(next)) {
      this.lastError = translate(this.locale, "error.invalidModelSettings");
      this.emitSnapshot();
      return this.current();
    }
    const apiKey = input.apiKey.trim();
    if (apiKey) await this.credentials.save(apiKey, this.locale);
    await this.settingsStore.saveLLMSettings(next);
    this.llmSettings = next;
    this.visual.clearCache();
    this.apiKeyConfigured = await this.credentials.has();
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

  async setRollupSynthesisEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    const next = { ...this.llmSettings, rollupSynthesisEnabled: enabled };
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
    await this.settingsStore.saveVisualSettings(input);
    this.visualSettings = { ...input };
    this.visual.configure(input);
    this.lastError = undefined;
    this.emitSnapshot();
    return this.current();
  }

  async requestScreenCapturePermission(): Promise<DesktopSnapshot> {
    if (!this.visual.providerAvailable()) {
      this.lastError = translate(this.locale, "error.visualProviderUnavailable");
      this.emitSnapshot();
      return this.current();
    }
    await this.visual.requestPermission();
    return this.current();
  }

  async removeLLMAPIKey(): Promise<DesktopSnapshot> {
    await this.credentials.remove();
    this.visual.clearCache();
    this.apiKeyConfigured = await this.credentials.has();
    this.wakeTimelineAgentJobs("credential_changed");
    this.emitSnapshot();
    return this.current();
  }

  documentPath(id: string): string {
    const document = this.documents.find((item) => item.id === id);
    if (!document?.filePath) throw new Error("Timeline document not found");
    return document.filePath;
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
    this.clearTimelineAgentTimer();
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
    this.visual.cancelPending();
    await this.visual.drain();
    await this.timelineAgentWork;
    await this.timelineWork;
    this.historyRecovery = await clearHistoryData(this.layout, {
      documentCount: this.documents.length,
      rollupCount: this.rollups.length,
    });
    await this.usage.reload();
    await this.recorderAvailability.reset(this.collector.current(), "history_cleared");
    this.segments.reset();
    this.coalescer.reset();
    this.burstCoalescer.reset();
    this.documents = [];
    this.rollups = [];
    this.applicationIconPaths.clear();
    this.visual.clearCache();
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
    this.clearTimelineAgentTimer();
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
      this.visual.cancelPending();
      await this.visual.drain();
      await this.timelineAgentWork;
      await this.timelineWork;
      await restoreHistoryData(this.layout, id);
      await this.usage.reload();
      await this.recorderAvailability.reset(this.collector.current(), "history_restored");
      this.segments.reset();
      this.coalescer.reset();
      this.burstCoalescer.reset();
      this.applicationIconPaths.clear();
      this.visual.clearCache();
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

  storagePath(): string {
    return this.layout.timeline;
  }

  searchHistory(query: string): HistorySearchResponse {
    return this.rollup.search(query, this.documents, this.rollups);
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
    this.visual.configure(this.visualSettings);
    this.apiKeyConfigured = await this.credentials.has();
    await this.usage.initialize();
    await this.recorderAvailability.start(this.collector.current());
    this.historyRecovery = await latestHistoryArchive(this.layout);
    this.documents = await this.timeline.loadDocuments();
    this.rollups = await this.rollup.refresh(this.documents);
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
    this.visual.schedule(event);
    if (closed) this.scheduleTimeline(closed);
  }

  private scheduleTimeline(
    segment: NonNullable<Awaited<ReturnType<SegmentStore["closeExpired"]>>>,
  ): void {
    const pendingVisualWork = this.visual.drain();
    void this.enqueueTimeline(async () => {
      await pendingVisualWork;
      await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
  }

  private async maintenance(): Promise<void> {
    if (this.collector.current().connectionState === "connected") {
      try {
        await this.collector.request("heartbeat");
        await this.recorderAvailability.record(this.collector.current(), "heartbeat", new Date());
      } catch {
        await this.recorderAvailability.recordUnavailable(
          "collector_heartbeat_failed",
          this.collector.current(),
          new Date(),
        );
      }
    } else {
      await this.recorderAvailability.record(this.collector.current(), "heartbeat", new Date());
    }
    for (const event of this.burstCoalescer.flushExpired()) await this.persist(event);
    await this.usage.checkpoint();
    const closed = await this.segments.closeExpired();
    if (closed) this.scheduleTimeline(closed);
    const recovered = await this.segments.recoverExpiredSegments();
    for (const segment of recovered) this.scheduleTimeline(segment);
    const completed = await this.segments.pendingClosedSegments();
    await this.segments.pruneVisualEvidence(new Date(Date.now() - 24 * 60 * 60 * 1_000));
    await this.segments.pruneSegments(new Date(Date.now() - 48 * 60 * 60 * 1_000));
    await pruneHistoryArchives(this.layout, new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000));
    this.historyRecovery = await latestHistoryArchive(this.layout);
    this.emitSnapshot();
    void this.enqueueTimeline(async () => {
      for (const segment of completed) await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
      this.kickTimelineAgent();
    }).catch((error) => this.captureError(error));
  }

  private async refreshDocuments(): Promise<void> {
    this.documents = await this.timeline.loadDocuments();
    this.rollups = await this.rollup.refresh(this.documents);
    const bundleIdentifiers = [
      ...new Set(
        [
          ...this.documents.flatMap((document) => document.applications),
          ...this.usage
            .summary()
            .last7Days.flatMap((day) => day.applications.map((item) => item.application)),
        ]
          .map((application) => application.bundleIdentifier)
          .filter((id) => !this.applicationIconPaths.has(id)),
      ),
    ];
    await this.resolveApplicationIcons(bundleIdentifiers);
    this.emitSnapshot();
  }

  private async resolveApplicationIcons(bundleIdentifiers: string[]): Promise<void> {
    const unresolved = [...new Set(bundleIdentifiers)].filter(
      (id) => !this.applicationIconPaths.has(id),
    );
    if (unresolved.length && this.collector.current().connectionState === "connected") {
      try {
        const payload = await this.collector.requestPayload<{ iconPaths?: Record<string, string> }>(
          "resolveApplicationIcons",
          { bundleIdentifiers: unresolved },
        );
        for (const [id, iconPath] of Object.entries(payload?.iconPaths ?? {})) {
          this.applicationIconPaths.set(id, iconPath);
        }
      } catch {
        // Timeline content remains usable when an application bundle is no longer installed.
      }
    }
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

  private publicRollup(record: TimelineRollupRecord): TimelineRollup {
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
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

  private publicUsageSummary(summary: ApplicationUsageSummary): ApplicationUsageSummary {
    const mapDay = (day: ApplicationUsageSummary["today"]): ApplicationUsageSummary["today"] => ({
      ...day,
      applications: day.applications.map((item) => ({
        ...item,
        application: {
          ...item.application,
          iconPath: this.applicationIconPaths.get(item.application.bundleIdentifier),
        },
      })),
    });
    return {
      today: mapDay(summary.today),
      last7Days: summary.last7Days.map(mapDay),
    };
  }

  private async llmRuntime(): Promise<LLMRuntime | LLMUnavailable | undefined> {
    if (!this.llmSettings.enabled) return undefined;
    const apiKey = await this.credentials.load();
    return apiKey
      ? { settings: this.llmSettings, apiKey }
      : { settings: this.llmSettings, failureReason: "api_key_missing" };
  }

  private async configuredLLMRuntime(): Promise<LLMRuntime | undefined> {
    const apiKey = await this.credentials.load();
    return apiKey ? { settings: this.llmSettings, apiKey } : undefined;
  }

  private async syncObservationPolicyToCollector(): Promise<void> {
    await this.collector.request("configureObservationPolicy", {
      observationPolicy: this.policy,
    });
  }

  private kickTimelineAgent(delayMilliseconds = 0): void {
    if (!this.timelineAgentEnabled) return;
    const delay = Math.max(0, delayMilliseconds);
    const wakeAt = Date.now() + delay;
    if (this.timelineAgentTimer) {
      if ((this.timelineAgentWakeAt ?? Number.NEGATIVE_INFINITY) <= wakeAt) return;
      this.clearTimelineAgentTimer();
    }
    const timer = setTimeout(() => {
      if (this.timelineAgentTimer !== timer) return;
      this.timelineAgentTimer = undefined;
      this.timelineAgentWakeAt = undefined;
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
    }, delay);
    this.timelineAgentTimer = timer;
    this.timelineAgentWakeAt = wakeAt;
  }

  private clearTimelineAgentTimer(): void {
    if (this.timelineAgentTimer) clearTimeout(this.timelineAgentTimer);
    this.timelineAgentTimer = undefined;
    this.timelineAgentWakeAt = undefined;
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
      }, recorderAvailabilityHeartbeatMilliseconds);
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

  private captureError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    console.error("[desklore] History pipeline failed:", error);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.current());
  }
}
