import type {
  CaptureHealth,
  CollectorConnectionState,
  RecorderState,
  TimelineApplication,
} from "../../shared/contracts/index.js";
import type { AppLocale } from "../../shared/i18n/index.js";
import type { TimelineAgentSessionFactory } from "../history/timeline/agent/runtime.js";
import type { HistoryEvent, UsageStateEvent } from "../history/contracts.js";
import type { VisualCaptureProvider } from "../history/visual/service.js";

export interface CollectorSnapshot {
  recorderState: RecorderState;
  activeApplication?: TimelineApplication;
  activeDomain?: string;
  health: CaptureHealth;
  lastError?: string;
}

export interface CollectorConnection {
  connectionState: CollectorConnectionState;
  snapshot?: CollectorSnapshot;
  connectionError?: string;
}

export type CollectorCommand =
  | "captureVisualEvidence"
  | "configureObservationPolicy"
  | "heartbeat"
  | "pause"
  | "quit"
  | "refreshPermissions"
  | "requestPermissions"
  | "requestScreenCapturePermission"
  | "resolveApplicationIcons"
  | "resume"
  | "start";

export interface CollectorPort {
  current(): CollectorConnection;
  start(): Promise<CollectorConnection>;
  stop(): Promise<CollectorConnection>;
  terminate(): void;
  request(
    command: CollectorCommand,
    payload?: Record<string, unknown>,
  ): Promise<CollectorConnection>;
  requestPayload<T>(
    command: CollectorCommand,
    payload?: Record<string, unknown>,
  ): Promise<T | undefined>;
  on(event: "snapshot", listener: (connection: CollectorConnection) => void): this;
  on(event: "event", listener: (event: HistoryEvent) => void): this;
  on(event: "usage-state", listener: (event: UsageStateEvent) => void): this;
}

export interface CredentialStore {
  has(): Promise<boolean>;
  load(): Promise<string | undefined>;
  save(apiKey: string, locale: AppLocale): Promise<void>;
  remove(): Promise<void>;
}

export interface ServerCoreConfig {
  storageRoot: string;
}

export interface ServerCoreDependencies {
  collector: CollectorPort;
  credentials: CredentialStore;
  timelineAgentSessions?: TimelineAgentSessionFactory;
  visualCapture?: VisualCaptureProvider;
}
