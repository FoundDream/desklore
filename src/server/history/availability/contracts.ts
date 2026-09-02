import type { CollectorConnectionState, RecorderState } from "../../../shared/contracts/index.js";

export const recorderAvailabilitySchemaVersion = 1;
export const recorderAvailabilityHeartbeatMilliseconds = 30_000;
export const recorderAvailabilityStaleMilliseconds = 90_000;

export type RecorderAvailabilityState = "available" | "unavailable";

export interface RecorderAvailabilityTransition {
  timestamp: string;
  state: RecorderAvailabilityState;
  reason: string;
  trigger: string;
  connectionState: CollectorConnectionState;
  recorderState?: RecorderState;
  accessibilityGranted?: boolean;
  interactionMonitorActive?: boolean;
}

export interface RecorderAvailabilityRun {
  schemaVersion: 1;
  runID: string;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt?: string;
  transitions: RecorderAvailabilityTransition[];
}
