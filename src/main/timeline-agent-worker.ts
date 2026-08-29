import { InProcessTimelineAgentSessionFactory } from "../server/history/timeline-agent-runtime.js";
import type { TimelineAgentRuntimeSession } from "../server/history/timeline-agent-runtime.js";
import { TimelineAgentError } from "../server/history/timeline-agent.js";

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("Timeline Agent worker must run in an Electron utility process");
}

interface WorkerRequest {
  id: string;
  command: "create" | "step" | "abort" | "dispose";
  sessionID: string;
  input?: Parameters<InProcessTimelineAgentSessionFactory["create"]>[0];
}

const factory = new InProcessTimelineAgentSessionFactory();
const sessions = new Map<string, TimelineAgentRuntimeSession>();

function response(id: string, value: unknown): void {
  parentPort.postMessage({ id, ok: true, value });
}

function failure(id: string, error: unknown): void {
  parentPort.postMessage({
    id,
    ok: false,
    error: {
      reason: error instanceof TimelineAgentError ? error.reason : "agent_worker_failed",
      retryable: error instanceof TimelineAgentError ? error.retryable : true,
      message:
        error instanceof TimelineAgentError ? error.reason : "Timeline worker request failed",
    },
  });
}

parentPort.on("message", (event) => {
  const request = event.data as Partial<WorkerRequest>;
  if (
    typeof request.id !== "string" ||
    typeof request.sessionID !== "string" ||
    !["create", "step", "abort", "dispose"].includes(request.command ?? "")
  ) {
    return;
  }
  void (async () => {
    try {
      if (request.command === "create") {
        if (!request.input) throw new Error("Missing timeline worker session input");
        sessions.get(request.sessionID!)?.dispose();
        sessions.set(request.sessionID!, await factory.create(request.input));
        response(request.id!, { created: true });
        return;
      }
      const session = sessions.get(request.sessionID!);
      if (!session) throw new TimelineAgentError("agent_worker_session_missing", true);
      if (request.command === "step") {
        response(request.id!, await session.step());
        return;
      }
      session.abort();
      sessions.delete(request.sessionID!);
      response(request.id!, { disposed: true });
    } catch (error) {
      failure(request.id!, error);
    }
  })();
});

parentPort.postMessage({ type: "ready", protocolVersion: 1 });
