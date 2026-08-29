import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { CollectorConnectionState } from "../shared/contracts.js";
import type {
  CollectorCommand,
  CollectorConnection,
  CollectorPort,
  CollectorSnapshot,
} from "./ports.js";
import {
  normalizeHistoryEvent,
  normalizeUsageStateEvent,
  type HistoryEvent,
  type UsageStateEvent,
} from "./history/types.js";

export type { CollectorConnection, CollectorSnapshot } from "./ports.js";

interface CollectorMessage {
  type: "snapshot" | "event" | "usage_state" | "response" | "error";
  requestID?: string;
  snapshot?: CollectorSnapshot;
  event?: unknown;
  usageState?: unknown;
  payload?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (message: CollectorMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class CollectorClient extends EventEmitter implements CollectorPort {
  private process?: ChildProcessWithoutNullStreams;
  private state: CollectorConnectionState = "stopped";
  private snapshot?: CollectorSnapshot;
  private connectionError?: string;
  private stdoutBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly executableCandidates: string[],
    private readonly hostBundleIdentifier?: string,
  ) {
    super();
  }

  current(): CollectorConnection {
    return {
      connectionState: this.state,
      snapshot: this.snapshot,
      connectionError: this.connectionError,
    };
  }

  async start(): Promise<CollectorConnection> {
    if (this.process && this.process.exitCode === null) return this.current();
    const executable = await this.findExecutable();
    if (!executable) {
      this.updateState("missing", "DeskLore Collector was not built");
      return this.current();
    }

    this.updateState("starting");
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DESKLORE_HOST_BUNDLE_ID: this.hostBundleIdentifier,
      },
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) this.connectionError = message.slice(-1_000);
    });
    child.once("spawn", () => this.updateState("connected"));
    child.once("error", (error) => {
      this.process = undefined;
      this.rejectPending(error);
      this.updateState("failed", error.message);
    });
    child.once("exit", (code, signal) => {
      this.process = undefined;
      this.snapshot = undefined;
      const expected = code === 0 || signal === "SIGTERM";
      if (!expected) {
        console.error(
          `[desklore] Native collector exited unexpectedly: ${code ?? signal}`,
          this.connectionError ?? "No native error output",
        );
      }
      this.rejectPending(new Error("Collector stopped"));
      this.updateState(
        expected ? "stopped" : "failed",
        expected ? undefined : `Collector exited with ${code ?? signal}`,
      );
    });
    return this.current();
  }

  async stop(): Promise<CollectorConnection> {
    const child = this.process;
    if (!child || child.exitCode !== null) {
      this.snapshot = undefined;
      this.updateState("stopped");
      return this.current();
    }
    try {
      await this.request("quit");
    } catch {
      child.kill("SIGTERM");
    }
    this.snapshot = undefined;
    this.updateState("stopped");
    return this.current();
  }

  terminate(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.stdin.end();
      this.process.kill("SIGTERM");
    }
    this.process = undefined;
    this.snapshot = undefined;
    this.rejectPending(new Error("Application is quitting"));
  }

  async request(
    command: CollectorCommand,
    payload: Record<string, unknown> = {},
  ): Promise<CollectorConnection> {
    await this.requestMessage(command, payload);
    return this.current();
  }

  async requestPayload<T>(
    command: CollectorCommand,
    payload: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    return (await this.requestMessage(command, payload)).payload as T | undefined;
  }

  private async requestMessage(
    command: CollectorCommand,
    payload: Record<string, unknown>,
  ): Promise<CollectorMessage> {
    if (!this.process || this.process.exitCode === null) await this.start();
    if (!this.process || this.process.exitCode !== null) {
      throw new Error(this.connectionError ?? "Collector is unavailable");
    }
    const id = randomUUID();
    return new Promise<CollectorMessage>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`Collector timed out while handling ${command}`));
        },
        command === "captureVisualEvidence" ? 20_000 : 8_000,
      );
      this.pending.set(id, { resolve, reject, timeout });
      this.process?.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  }

  private async findExecutable(): Promise<string | undefined> {
    for (const candidate of this.executableCandidates) {
      try {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next development or packaged location.
      }
    }
    return undefined;
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: CollectorMessage;
    try {
      message = JSON.parse(line) as CollectorMessage;
    } catch {
      this.updateState("failed", "Collector emitted invalid JSON");
      return;
    }
    if (message.snapshot) {
      this.snapshot = message.snapshot;
      this.updateState("connected");
    }
    if (message.type === "event" && message.event) {
      try {
        this.emit("event", normalizeHistoryEvent(message.event) satisfies HistoryEvent);
      } catch (error) {
        this.connectionError = error instanceof Error ? error.message : "Invalid native event";
        console.error("[desklore] Rejected an invalid native event:", error);
        this.emit("snapshot", this.current());
      }
    }
    if (message.type === "usage_state" && message.usageState) {
      try {
        this.emit(
          "usage-state",
          normalizeUsageStateEvent(message.usageState) satisfies UsageStateEvent,
        );
      } catch (error) {
        this.connectionError = error instanceof Error ? error.message : "Invalid usage state";
        console.error("[desklore] Rejected an invalid usage state:", error);
        this.emit("snapshot", this.current());
      }
    }
    if (message.requestID) {
      const pending = this.pending.get(message.requestID);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.requestID);
        if (message.type === "error") {
          pending.reject(new Error(message.error ?? "Collector command failed"));
        } else {
          pending.resolve(message);
        }
      }
    }
  }

  private updateState(state: CollectorConnectionState, error?: string): void {
    this.state = state;
    this.connectionError = error;
    this.emit("snapshot", this.current());
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function collectorExecutableCandidates(
  appPath: string,
  resourcesPath: string,
  projectRoot: string,
): string[] {
  const relative = path.join("DeskLore Collector.app", "Contents", "MacOS", "DeskLoreCollector");
  return [
    process.env.DESKLORE_COLLECTOR_PATH,
    path.join(resourcesPath, "native", relative),
    path.join(projectRoot, "dist", relative),
    path.join(appPath, "dist", relative),
  ].filter((candidate): candidate is string => Boolean(candidate));
}
