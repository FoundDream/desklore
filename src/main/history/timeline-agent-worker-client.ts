import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { TimelineAgentError } from "./timeline-agent.js";
import type {
  TimelineAgentRuntimeSession,
  TimelineAgentRuntimeStep,
  TimelineAgentSessionFactory,
  TimelineAgentSessionInput,
} from "./timeline-agent-runtime.js";

interface WorkerReply {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { reason?: string; retryable?: boolean; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const workerRequestTimeoutMilliseconds = 60_000;

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ];
  return Object.fromEntries(
    allowed
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

class UtilityTimelineAgentSession implements TimelineAgentRuntimeSession {
  constructor(
    private readonly client: TimelineAgentUtilityProcessClient,
    private readonly sessionID: string,
  ) {}

  step(): Promise<TimelineAgentRuntimeStep> {
    return this.client.request("step", this.sessionID) as Promise<TimelineAgentRuntimeStep>;
  }

  abort(): void {
    void this.client.request("abort", this.sessionID).catch(() => undefined);
  }

  dispose(): void {
    void this.client.request("dispose", this.sessionID).catch(() => undefined);
  }
}

export class TimelineAgentUtilityProcessClient implements TimelineAgentSessionFactory {
  private child?: UtilityProcess;
  private spawnPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  async create(input: TimelineAgentSessionInput): Promise<TimelineAgentRuntimeSession> {
    const sessionID = randomUUID().toLowerCase();
    await this.request("create", sessionID, input);
    return new UtilityTimelineAgentSession(this, sessionID);
  }

  request(
    command: "create" | "step" | "abort" | "dispose",
    sessionID: string,
    input?: TimelineAgentSessionInput,
  ): Promise<unknown> {
    return this.ensureChild().then(
      () =>
        new Promise((resolve, reject) => {
          const id = randomUUID().toLowerCase();
          const timer = setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.stopChild(new TimelineAgentError("agent_worker_timeout", true));
          }, workerRequestTimeoutMilliseconds);
          this.pending.set(id, { resolve, reject, timer });
          try {
            this.child!.postMessage({ id, command, sessionID, input });
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
  }

  dispose(): void {
    this.stopChild(new TimelineAgentError("agent_worker_stopped", true));
  }

  private ensureChild(): Promise<void> {
    if (this.child?.pid) return Promise.resolve();
    if (this.spawnPromise) return this.spawnPromise;
    const child = utilityProcess.fork(
      fileURLToPath(new URL("./timeline-agent-worker.js", import.meta.url)),
      [],
      {
        env: workerEnvironment(),
        stdio: "ignore",
        serviceName: "DeskLore Timeline Agent",
      },
    );
    this.child = child;
    child.on("message", (message) => this.handleReply(message));
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.spawnPromise = undefined;
      this.rejectPending(new TimelineAgentError("agent_worker_crashed", true));
    });
    child.on("error", () => {
      if (this.child === child) {
        this.child = undefined;
        this.spawnPromise = undefined;
      }
      this.rejectPending(new TimelineAgentError("agent_worker_crashed", true));
    });
    this.spawnPromise = new Promise((resolve, reject) => {
      let settled = false;
      const spawned = (): void => {
        settled = true;
        resolve();
      };
      const failed = (): void => {
        if (settled) return;
        settled = true;
        reject(new TimelineAgentError("agent_worker_crashed", true));
      };
      child.once("spawn", spawned);
      child.once("error", failed);
      child.once("exit", failed);
    });
    return this.spawnPromise;
  }

  private handleReply(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const reply = message as Partial<WorkerReply>;
    if (typeof reply.id !== "string" || typeof reply.ok !== "boolean") return;
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.ok) {
      request.resolve(reply.value);
      return;
    }
    request.reject(
      new TimelineAgentError(
        reply.error?.reason ?? "agent_worker_failed",
        reply.error?.retryable ?? true,
        { worker_message: reply.error?.message ?? "Timeline worker request failed" },
      ),
    );
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private stopChild(error: Error): void {
    const child = this.child;
    this.child = undefined;
    this.spawnPromise = undefined;
    this.rejectPending(error);
    child?.kill();
  }
}
