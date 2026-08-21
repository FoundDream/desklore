import { EventEmitter } from "node:events";
import { shell } from "electron";
import type {
  AgentSnapshot,
  DesktopSnapshot,
  LLMConfigurationInput,
  MemoryRollup,
  TimelineApplication,
  TimelineDocument,
} from "../../shared/contracts.js";
import { AgentClient } from "../agent-client.js";
import { classifyKeyboardEvent, EventBurstCoalescer, EventCoalescer } from "./coalescer.js";
import {
  allowsApplication,
  allowsDomain,
  applyObservationPolicy,
  defaultObservationPolicy,
} from "./policy.js";
import { HistorySettingsStore, validateLLMSettings } from "./settings.js";
import {
  ensureStorage,
  hardenStoragePermissions,
  makeStorageLayout,
  SegmentStore,
  segmentIdentifier,
} from "./storage.js";
import { TimelineRepository, type LLMRuntime, type LLMUnavailable } from "./timeline.js";
import { MemoryRepository } from "./memory.js";
import type {
  HistorySearchResponse,
  MemoryRollupRecord,
  HistoryEvent,
  ObservationPolicy,
  TimelineDocumentRecord,
  TimelineLLMSettings,
} from "./types.js";

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
    model: "gpt-5.6-luna",
    endpoint: "https://api.openai.com/v1/responses",
  };
  private apiKeyConfigured = false;
  private documents: TimelineDocumentRecord[] = [];
  private memories: MemoryRollupRecord[] = [];
  private lastError?: string;
  private initialized = false;
  private captureWork: Promise<unknown> = Promise.resolve();
  private timelineWork: Promise<unknown> = Promise.resolve();
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

  constructor(
    private readonly collector: AgentClient,
    storageRoot: string,
  ) {
    super();
    this.layout = makeStorageLayout(storageRoot);
    this.segments = new SegmentStore(this.layout);
    this.settingsStore = new HistorySettingsStore(this.layout);
    this.timeline = new TimelineRepository(this.layout, this.segments, async () =>
      this.llmRuntime(),
    );
    this.memory = new MemoryRepository(this.layout, async () => {
      if (!this.llmSettings.memorySynthesisEnabled) return undefined;
      const runtime = await this.llmRuntime();
      return runtime && !("failureReason" in runtime) ? runtime : undefined;
    });
    collector.on("snapshot", () => this.emitSnapshot());
    collector.on("event", (event: HistoryEvent) => {
      if (!this.receivedNativeEvent) {
        this.receivedNativeEvent = true;
        console.info("[computer-history] Native event stream connected.");
      }
      void this.enqueueCapture(async () => this.processEvent(event)).catch((error) =>
        this.captureError(error),
      );
    });
  }

  current(): DesktopSnapshot {
    const native = this.collector.current();
    const snapshot: AgentSnapshot | undefined = native.agent
      ? {
          recorderState: native.agent.recorderState,
          storageRoot: this.layout.root,
          activeApplication: native.agent.activeApplication,
          activeApplicationAllowed: native.agent.activeApplication
            ? allowsApplication(this.policy, native.agent.activeApplication.bundleIdentifier)
            : undefined,
          activeDomain: native.agent.activeDomain,
          activeDomainAllowed: native.agent.activeDomain
            ? allowsDomain(this.policy, native.agent.activeDomain)
            : undefined,
          documents: this.documents.map((document) => this.publicDocument(document)),
          memories: this.memories.map((record) => this.publicMemory(record)),
          health: { ...native.agent.health, ...this.semanticHealth },
          llm: { ...this.llmSettings, apiKeyConfigured: this.apiKeyConfigured },
          lastError: this.lastError ?? native.agent.lastError,
        }
      : undefined;
    return {
      connectionState: native.connectionState,
      agent: snapshot,
      connectionError: native.connectionError,
    };
  }

  async start(): Promise<DesktopSnapshot> {
    await this.initialize();
    const recovered = await this.segments.recoverExpiredSegments();
    const completed = await this.segments.pendingClosedSegments();
    await this.collector.start();
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
      await this.timeline.retryFallbackDocuments([...byID.values()], new Date(), 0);
      await this.refreshDocuments();
    }).catch((error) => this.captureError(error));
    return this.current();
  }

  async stop(): Promise<DesktopSnapshot> {
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
    this.stopTimers();
    await this.collector.stop();
    return this.current();
  }

  terminate(): void {
    this.stopTimers();
    this.collector.terminate();
  }

  async pause(): Promise<DesktopSnapshot> {
    await this.enqueueCapture(async () => {
      for (const event of this.burstCoalescer.flushAll()) await this.persist(event);
    });
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
    const application = this.collector.current().agent?.activeApplication;
    if (!application) return this.current();
    this.policy.allowedBundleIdentifiers = this.policy.allowedBundleIdentifiers.filter(
      (id) => id !== application.bundleIdentifier,
    );
    this.policy.blockedBundleIdentifiers = this.policy.blockedBundleIdentifiers.filter(
      (id) => id !== application.bundleIdentifier,
    );
    (allowed ? this.policy.allowedBundleIdentifiers : this.policy.blockedBundleIdentifiers).push(
      application.bundleIdentifier,
    );
    await this.settingsStore.savePolicy(this.policy);
    this.emitSnapshot();
    return this.current();
  }

  async setActiveDomainAllowed(allowed: boolean): Promise<DesktopSnapshot> {
    const domain = this.collector.current().agent?.activeDomain;
    if (!domain) return this.current();
    this.policy.allowedDomains = this.policy.allowedDomains.filter((value) => value !== domain);
    this.policy.blockedDomains = this.policy.blockedDomains.filter((value) => value !== domain);
    (allowed ? this.policy.allowedDomains : this.policy.blockedDomains).push(domain);
    await this.settingsStore.savePolicy(this.policy);
    this.emitSnapshot();
    return this.current();
  }

  async configureLLM(input: LLMConfigurationInput): Promise<DesktopSnapshot> {
    const next = {
      enabled: input.enabled,
      memorySynthesisEnabled: input.memorySynthesisEnabled,
      model: input.model.trim(),
      endpoint: input.endpoint.trim(),
    };
    if (!validateLLMSettings(next)) {
      this.lastError = "模型名称或 Endpoint 无效；远程地址必须使用 HTTPS。";
      this.emitSnapshot();
      return this.current();
    }
    const apiKey = input.apiKey.trim();
    if (apiKey) await this.settingsStore.saveAPIKey(apiKey);
    await this.settingsStore.saveLLMSettings(next);
    this.llmSettings = next;
    this.apiKeyConfigured = await this.settingsStore.hasAPIKey();
    this.lastError = undefined;
    void this.enqueueTimeline(async () => {
      const segments = await this.segments.pendingClosedSegments();
      await this.timeline.retryFallbackDocuments(segments, new Date(), 0);
      await this.refreshDocuments();
    }).catch((error) => this.captureError(error));
    return this.current();
  }

  async removeLLMAPIKey(): Promise<DesktopSnapshot> {
    await this.settingsStore.removeAPIKey();
    this.apiKeyConfigured = Boolean(process.env.OPENAI_API_KEY);
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
    await this.enqueueTimeline(async () => {
      const document = this.documents.find((item) => item.id === id);
      if (!document) throw new Error("Timeline document not found");
      await this.timeline.delete(document);
      await this.refreshDocuments();
    });
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
    [this.policy, this.llmSettings] = await Promise.all([
      this.settingsStore.loadPolicy(),
      this.settingsStore.loadLLMSettings(),
    ]);
    this.apiKeyConfigured = await this.settingsStore.hasAPIKey();
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
    const capturedClosed = await this.segments.recordMetric(event.timestamp, "captured");
    if (capturedClosed) this.scheduleTimeline(capturedClosed);
    const sanitized = applyObservationPolicy(this.policy, classifyKeyboardEvent(event));
    if (!sanitized) {
      this.semanticHealth.policyBlockedEventCount += 1;
      const closed = await this.segments.recordSuppressed(event.timestamp);
      if (closed) this.scheduleTimeline(closed);
      return;
    }
    const normalized = this.coalescer.process(sanitized);
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
    if (closed) this.scheduleTimeline(closed);
  }

  private scheduleTimeline(
    segment: NonNullable<Awaited<ReturnType<SegmentStore["closeExpired"]>>>,
  ): void {
    void this.enqueueTimeline(async () => {
      await this.timeline.generateIfNeeded(segment);
      await this.refreshDocuments();
    }).catch((error) => this.captureError(error));
  }

  private async maintenance(): Promise<void> {
    for (const event of this.burstCoalescer.flushExpired()) await this.persist(event);
    const closed = await this.segments.closeExpired();
    if (closed) this.scheduleTimeline(closed);
    const recovered = await this.segments.recoverExpiredSegments();
    for (const segment of recovered) this.scheduleTimeline(segment);
    const completed = await this.segments.pendingClosedSegments();
    await this.segments.pruneSegments(new Date(Date.now() - 48 * 60 * 60 * 1_000));
    void this.enqueueTimeline(async () => {
      await this.timeline.retryFallbackDocuments(completed);
      await this.refreshDocuments();
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

  private captureError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    console.error("[computer-history] History pipeline failed:", error);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.current());
  }
}
