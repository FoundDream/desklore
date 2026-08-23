import type { AppLocale } from "./i18n.js";

export type AgentConnectionState = "starting" | "connected" | "stopped" | "missing" | "failed";

export type RecorderState = "stopped" | "running" | "paused";

export interface TimelineApplication {
  bundleIdentifier: string;
  name: string;
  iconPath?: string;
}

export interface TimelineDocument {
  id: string;
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  applications: TimelineApplication[];
  generatorType: string;
  generatorFailureReason?: string;
}

export interface MemoryRollup {
  id: string;
  kind: "6h" | "day";
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  continuationHint?: string;
  applications: TimelineApplication[];
  sourceDocumentIDs: string[];
}

export interface HistorySearchMatch {
  id: string;
  kind: "10min" | "6h" | "day";
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  score: number;
  sourceDocumentIDs: string[];
  sourceSegmentIDs: string[];
}

export interface HistorySearchResponse {
  query: string;
  answer: string;
  matches: HistorySearchMatch[];
}

export interface CaptureHealth {
  accessibilityGranted: boolean;
  interactionMonitorActive: boolean;
  axObserverActive: boolean;
  axValueNotificationTargets: number;
  axSelectionNotificationTargets: number;
  returnKeyEventCount: number;
  keyboardSubmitCount: number;
  keyboardShortcutCount: number;
  textInputEventCount: number;
  selectionEventCount: number;
  capturedEventCount: number;
  persistedEventCount: number;
  policyBlockedEventCount: number;
  deduplicatedEventCount: number;
  burstCoalescedEventCount: number;
  lastAXSnapshotNodeCount: number;
  lastAXVisitedNodeCount: number;
  lastAXCaptureDurationMilliseconds: number;
  axSlowCaptureCount: number;
  axTruncatedCaptureCount: number;
  axCaptureBacklog: number;
  screenCaptureGranted: boolean;
}

export interface LLMSettings {
  enabled: boolean;
  memorySynthesisEnabled: boolean;
  model: string;
  endpoint: string;
  apiKeyConfigured: boolean;
}

export interface VisualSettings {
  axJudge: "rules" | "luna";
  captureMode: "off" | "fallback";
  understandingMode: "off" | "ocr" | "luna";
}

export interface VisualHealth {
  providerStatus: "disabled" | "permission_required" | "ready" | "unhealthy" | "unavailable";
  judgedEventCount: number;
  needsVisualCount: number;
  uncertainCount: number;
  captureRequestedCount: number;
  captureSucceededCount: number;
  captureCandidateCount: number;
  captureDiscardedCount: number;
  captureCoalescedCount: number;
  captureBlockedCount: number;
  captureFailedCount: number;
  captureCooldownCount: number;
  captureBackoffCount: number;
  visualGapCount: number;
  visualUnchangedCount: number;
  visualReusedCount: number;
  visionCalledCount: number;
  lastDecisionReason?: string;
  lastCaptureDecisionReason?: string;
}

export interface AgentSnapshot {
  recorderState: RecorderState;
  storageRoot: string;
  activeApplication?: TimelineApplication;
  activeApplicationAllowed?: boolean;
  activeDomain?: string;
  activeDomainAllowed?: boolean;
  documents: TimelineDocument[];
  memories: MemoryRollup[];
  health: CaptureHealth;
  llm: LLMSettings;
  visual: VisualSettings & VisualHealth;
  lastError?: string;
}

export interface DesktopSnapshot {
  locale: AppLocale;
  connectionState: AgentConnectionState;
  recordingConsentGranted: boolean;
  agent?: AgentSnapshot;
  connectionError?: string;
}

export interface LLMConfigurationInput {
  enabled: boolean;
  memorySynthesisEnabled: boolean;
  model: string;
  endpoint: string;
  apiKey: string;
}

export type VisualConfigurationInput = VisualSettings;

export interface ComputerHistoryAPI {
  getSnapshot(): Promise<DesktopSnapshot>;
  setLocale(locale: AppLocale): Promise<DesktopSnapshot>;
  grantRecordingConsent(): Promise<DesktopSnapshot>;
  startAgent(): Promise<DesktopSnapshot>;
  stopAgent(): Promise<DesktopSnapshot>;
  pause(): Promise<DesktopSnapshot>;
  resume(): Promise<DesktopSnapshot>;
  refreshPermissions(): Promise<DesktopSnapshot>;
  requestPermissions(): Promise<DesktopSnapshot>;
  allowActiveApplication(): Promise<DesktopSnapshot>;
  blockActiveApplication(): Promise<DesktopSnapshot>;
  allowActiveDomain(): Promise<DesktopSnapshot>;
  blockActiveDomain(): Promise<DesktopSnapshot>;
  configureLLM(input: LLMConfigurationInput): Promise<DesktopSnapshot>;
  setLLMEnabled(enabled: boolean): Promise<DesktopSnapshot>;
  setMemorySynthesisEnabled(enabled: boolean): Promise<DesktopSnapshot>;
  configureVisual(input: VisualConfigurationInput): Promise<DesktopSnapshot>;
  requestScreenCapturePermission(): Promise<DesktopSnapshot>;
  removeLLMAPIKey(): Promise<DesktopSnapshot>;
  openDocument(id: string): Promise<DesktopSnapshot>;
  deleteDocument(id: string): Promise<DesktopSnapshot>;
  clearHistory(): Promise<DesktopSnapshot>;
  revealStorage(): Promise<DesktopSnapshot>;
  getApplicationIcon(iconPath: string): Promise<string | undefined>;
  searchMemory(query: string): Promise<HistorySearchResponse>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
}
