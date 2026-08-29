import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import { TimelineAgentError } from "../../server/history/timeline-agent.js";
import type {
  TimelineAgentRuntimeSession,
  TimelineAgentRuntimeStep,
  TimelineAgentSessionFactory,
  TimelineAgentSessionInput,
} from "../../server/history/timeline-agent-runtime.js";

interface WorkerReply {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { reason?: string; retryable?: boolean; message?: string };
}

interface WorkerReady {
  type: "ready";
  protocolVersion: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const workerRequestTimeoutMilliseconds = 60_000;
const workerStartupTimeoutMilliseconds = 10_000;
const workerStartupErrorLimit = 4_096;

function isWorkerReady(message: unknown): message is WorkerReady {
  if (!message || typeof message !== "object") return false;
  const ready = message as Partial<WorkerReady>;
  return ready.type === "ready" && ready.protocolVersion === 1;
}

function clippedStartupError(value: string): string | undefined {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.replaceAll(process.cwd(), "<app>").slice(0, 240);
}

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
    if (this.spawnPromise) return this.spawnPromise;
    if (this.child?.pid) return Promise.resolve();
    const child = utilityProcess.fork(
      fileURLToPath(new URL("./timeline-agent-worker.js", import.meta.url)),
      [],
      {
        env: workerEnvironment(),
        stdio: "pipe",
        serviceName: "DeskLore Timeline Agent",
      },
    );
    this.child = child;
    child.stdout?.resume();
    let startupError = "";
    let ready = false;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (ready || startupError.length >= workerStartupErrorLimit) return;
      startupError += String(chunk).slice(0, workerStartupErrorLimit - startupError.length);
    });
    let resolveStartup!: () => void;
    let rejectStartup!: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const startupTimer = setTimeout(() => {
      if (ready || this.child !== child) return;
      const error = new TimelineAgentError("agent_worker_startup_timeout", true);
      rejectStartup(error);
      this.stopChild(error);
    }, workerStartupTimeoutMilliseconds);
    child.on("message", (message) => {
      if (isWorkerReady(message)) {
        ready = true;
        clearTimeout(startupTimer);
        resolveStartup();
        return;
      }
      this.handleReply(message);
    });
    child.on("exit", (code) => {
      clearTimeout(startupTimer);
      if (this.child !== child) return;
      this.child = undefined;
      this.spawnPromise = undefined;
      const error = new TimelineAgentError("agent_worker_crashed", true, {
        exit_code: code,
        startup_error: ready ? undefined : clippedStartupError(startupError),
      });
      if (!ready) rejectStartup(error);
      this.rejectPending(error);
    });
    child.on("error", () => {
      clearTimeout(startupTimer);
      const error = new TimelineAgentError("agent_worker_crashed", true, {
        startup_error: ready ? undefined : clippedStartupError(startupError),
      });
      if (this.child === child) {
        this.child = undefined;
        this.spawnPromise = undefined;
      }
      if (!ready) rejectStartup(error);
      this.rejectPending(error);
    });
    this.spawnPromise = startup;
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
