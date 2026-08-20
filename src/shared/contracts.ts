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
  task?: string;
  progression: string[];
  outcome?: string;
  openLoops: string[];
  activityState?: string;
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
  tasks: string[];
  outcomes: string[];
  openLoops: string[];
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
}

export interface LLMSettings {
  enabled: boolean;
  memorySynthesisEnabled: boolean;
  model: string;
  endpoint: string;
  apiKeyConfigured: boolean;
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
  lastError?: string;
}

export interface DesktopSnapshot {
  connectionState: AgentConnectionState;
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

export interface ComputerHistoryAPI {
  getSnapshot(): Promise<DesktopSnapshot>;
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
  removeLLMAPIKey(): Promise<DesktopSnapshot>;
  openDocument(id: string): Promise<DesktopSnapshot>;
  deleteDocument(id: string): Promise<DesktopSnapshot>;
  revealStorage(): Promise<DesktopSnapshot>;
  getApplicationIcon(iconPath: string): Promise<string | undefined>;
  searchMemory(query: string): Promise<HistorySearchResponse>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
}
