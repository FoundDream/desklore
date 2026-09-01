import type { DesktopSnapshot } from "../../shared/contracts/index.js";

export type NativePermissionCommand = "refreshPermissions" | "requestPermissions";

export type ServerCoreMethod =
  | "start"
  | "grantRecordingConsent"
  | "shutdown"
  | "pause"
  | "resume"
  | "requestNative"
  | "setActiveApplicationAllowed"
  | "setActiveDomainAllowed"
  | "updateObservationPolicy"
  | "setLocale"
  | "configureLLM"
  | "setLLMEnabled"
  | "setRollupSynthesisEnabled"
  | "configureVisual"
  | "requestScreenCapturePermission"
  | "removeLLMAPIKey"
  | "documentPath"
  | "deleteDocument"
  | "clearHistory"
  | "restoreHistory"
  | "storagePath"
  | "searchHistory";

export interface ServerCoreInitializeMessage {
  type: "initialize";
  storageRoot: string;
  collectorExecutableCandidates: string[];
  hostBundleIdentifier?: string;
  apiKey?: string;
}

export interface ServerCoreRequestMessage {
  type: "request";
  id: string;
  method: ServerCoreMethod;
  parameters: unknown[];
}

export interface ServerCoreReadyMessage {
  type: "ready";
  snapshot: DesktopSnapshot;
}

export interface ServerCoreStartupErrorMessage {
  type: "startup-error";
  error: string;
}

export interface ServerCoreResponseMessage {
  type: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface ServerCoreSnapshotMessage {
  type: "snapshot";
  snapshot: DesktopSnapshot;
}

export type ServerCoreInboundMessage = ServerCoreInitializeMessage | ServerCoreRequestMessage;

export type ServerCoreOutboundMessage =
  | ServerCoreReadyMessage
  | ServerCoreStartupErrorMessage
  | ServerCoreResponseMessage
  | ServerCoreSnapshotMessage;
