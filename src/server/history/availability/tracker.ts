import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteOwnedFile } from "../../../platform/node/atomic-owned-file.js";
import type { CollectorConnection } from "../../core/ports.js";
import type { UsageStateEvent } from "../contracts.js";
import { ensureStorage, type StorageLayout } from "../storage/repository.js";
import {
  recorderAvailabilityHeartbeatMilliseconds,
  recorderAvailabilitySchemaVersion,
  type RecorderAvailabilityRun,
  type RecorderAvailabilityTransition,
} from "./contracts.js";

export type { RecorderAvailabilityRun } from "./contracts.js";

function stateFrom(
  connection: CollectorConnection,
  blocker?: string,
): Omit<RecorderAvailabilityTransition, "timestamp" | "trigger"> {
  const recorderState = connection.snapshot?.recorderState;
  const accessibilityGranted = connection.snapshot?.health.accessibilityGranted;
  const interactionMonitorActive = connection.snapshot?.health.interactionMonitorActive;
  let reason = blocker;
  if (!reason && connection.connectionState !== "connected") {
    reason = `collector_${connection.connectionState}`;
  }
  if (!reason && recorderState !== "running") reason = `recorder_${recorderState ?? "unknown"}`;
  if (!reason && accessibilityGranted !== true) reason = "accessibility_unavailable";
  if (!reason && interactionMonitorActive !== true) reason = "interaction_monitor_inactive";
  return {
    state: reason ? "unavailable" : "available",
    reason: reason ?? "recorder_running",
    connectionState: connection.connectionState,
    recorderState,
    accessibilityGranted,
    interactionMonitorActive,
  };
}

function signature(transition: RecorderAvailabilityTransition): string {
  return JSON.stringify({
    state: transition.state,
    reason: transition.reason,
    connectionState: transition.connectionState,
    recorderState: transition.recorderState,
    accessibilityGranted: transition.accessibilityGranted,
    interactionMonitorActive: transition.interactionMonitorActive,
  });
}

export class RecorderAvailabilityTracker {
  private run?: RecorderAvailabilityRun;
  private usageBlocker?: string;
  private transientBlocker?: string;
  private writeWork: Promise<unknown> = Promise.resolve();

  constructor(private readonly layout: StorageLayout) {}

  start(connection: CollectorConnection, date = new Date()): Promise<void> {
    return this.enqueue(async () => {
      if (this.run) {
        this.transientBlocker = undefined;
        await this.recordConnection(connection, "server_start", date);
        return;
      }
      await this.createRun(connection, "server_start", date);
    });
  }

  record(connection: CollectorConnection, trigger: string, date = new Date()): Promise<void> {
    return this.enqueue(async () => {
      this.transientBlocker = undefined;
      await this.recordConnection(connection, trigger, date);
    });
  }

  recordUsageState(connection: CollectorConnection, event: UsageStateEvent): Promise<void> {
    return this.enqueue(async () => {
      this.usageBlocker = event.state === "unavailable" ? event.reason : undefined;
      await this.recordConnection(connection, `usage_${event.reason}`, new Date(event.timestamp));
    });
  }

  recordUnavailable(
    reason: string,
    connection: CollectorConnection,
    date = new Date(),
  ): Promise<void> {
    return this.enqueue(async () => {
      this.transientBlocker = reason;
      await this.recordConnection(connection, reason, date);
    });
  }

  stop(connection: CollectorConnection, date = new Date()): Promise<void> {
    return this.enqueue(async () => {
      this.transientBlocker = "server_stopped";
      await this.recordConnection(connection, "server_stop", date);
      if (!this.run) return;
      this.run.endedAt = date.toISOString();
      this.run.lastHeartbeatAt = date.toISOString();
      await this.write();
    });
  }

  reset(connection: CollectorConnection, trigger: string, date = new Date()): Promise<void> {
    return this.enqueue(async () => {
      this.run = undefined;
      this.usageBlocker = undefined;
      this.transientBlocker = undefined;
      await this.createRun(connection, trigger, date);
    });
  }

  drain(): Promise<void> {
    return this.writeWork.then(() => undefined);
  }

  private async createRun(
    connection: CollectorConnection,
    trigger: string,
    date: Date,
  ): Promise<void> {
    const timestamp = date.toISOString();
    const transition = this.transition(connection, trigger, date);
    this.run = {
      schemaVersion: recorderAvailabilitySchemaVersion,
      runID: randomUUID(),
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      transitions: [transition],
    };
    await this.write();
  }

  private async recordConnection(
    connection: CollectorConnection,
    trigger: string,
    date: Date,
  ): Promise<void> {
    if (!this.run) {
      await this.createRun(connection, trigger, date);
      return;
    }
    const timestamp = date.toISOString();
    if (Date.parse(timestamp) < Date.parse(this.run.lastHeartbeatAt)) return;
    const transition = this.transition(connection, trigger, date);
    const previous = this.run.transitions.at(-1);
    const changed = !previous || signature(previous) !== signature(transition);
    const heartbeatDue =
      Date.parse(timestamp) - Date.parse(this.run.lastHeartbeatAt) >=
      recorderAvailabilityHeartbeatMilliseconds;
    if (!changed && trigger !== "heartbeat" && !heartbeatDue) return;
    if (changed) {
      this.run.transitions.push(transition);
    }
    this.run.lastHeartbeatAt = timestamp;
    await this.write();
  }

  private transition(
    connection: CollectorConnection,
    trigger: string,
    date: Date,
  ): RecorderAvailabilityTransition {
    return {
      timestamp: date.toISOString(),
      trigger,
      ...stateFrom(connection, this.usageBlocker ?? this.transientBlocker),
    };
  }

  private async write(): Promise<void> {
    const run = this.run;
    if (!run) return;
    await ensureStorage(this.layout);
    await mkdir(this.layout.recorderAvailability, { recursive: true, mode: 0o700 });
    await chmod(this.layout.recorderAvailability, 0o700);
    await atomicWriteOwnedFile(
      path.join(this.layout.recorderAvailability, `${run.runID}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeWork.then(operation, operation);
    this.writeWork = next.catch(() => undefined);
    return next;
  }
}
