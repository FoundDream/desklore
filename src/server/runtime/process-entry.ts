import { CollectorClient } from "../adapters/collector/client.js";
import { InProcessTimelineAgentSessionFactory } from "../history/timeline/agent/runtime.js";
import { CollectorVisualCaptureProvider } from "../adapters/collector/visual-provider.js";
import { MemoryCredentialStore } from "../adapters/credentials/memory-store.js";
import type {
  ServerCoreInboundMessage,
  ServerCoreInitializeMessage,
  ServerCoreOutboundMessage,
  ServerCoreRequestMessage,
} from "../api/messages.js";
import { dispatchServerCoreRequest } from "./request-handler.js";
import { ServerCore } from "../core/server-core.js";

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("ServerCore must run in an Electron utility process");
}

let core: ServerCore | undefined;

function post(message: ServerCoreOutboundMessage): void {
  parentPort.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initialize(message: ServerCoreInitializeMessage): Promise<void> {
  if (core) return;
  const collector = new CollectorClient(
    message.collectorExecutableCandidates,
    message.hostBundleIdentifier,
  );
  const next = new ServerCore(
    { storageRoot: message.storageRoot },
    {
      collector,
      credentials: new MemoryCredentialStore(message.apiKey),
      timelineAgentSessions: new InProcessTimelineAgentSessionFactory(),
      visualCapture: new CollectorVisualCaptureProvider(collector),
    },
  );
  next.on("snapshot", (snapshot) => post({ type: "snapshot", snapshot }));
  core = next;
  const snapshot = await next.prepare();
  post({ type: "ready", snapshot });
}

async function handleRequest(request: ServerCoreRequestMessage): Promise<void> {
  if (!core) {
    post({ type: "response", id: request.id, ok: false, error: "ServerCore is not ready" });
    return;
  }
  try {
    const value = await dispatchServerCoreRequest(core, request);
    post({ type: "response", id: request.id, ok: true, value });
  } catch (error) {
    post({ type: "response", id: request.id, ok: false, error: errorMessage(error) });
  }
}

parentPort.on("message", (event) => {
  const message = event.data as ServerCoreInboundMessage;
  if (message.type === "initialize") {
    void initialize(message).catch((error: unknown) => {
      post({ type: "startup-error", error: errorMessage(error) });
    });
    return;
  }
  if (message.type === "request") void handleRequest(message);
});
