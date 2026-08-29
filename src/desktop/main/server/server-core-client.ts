import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { utilityProcess, type UtilityProcess } from "electron";
import type {
  DesktopSnapshot,
  HistorySearchResponse,
  LLMConfigurationInput,
  ObservationPolicy,
  VisualConfigurationInput,
} from "../../../shared/contracts/index.js";
import type { AppLocale } from "../../../shared/i18n/index.js";
import { defaultObservationPolicy } from "../../../shared/defaults.js";
import { validateModelConfiguration } from "../../../shared/model.js";
import type {
  NativePermissionCommand,
  ServerCoreOutboundMessage,
  ServerCoreResponseMessage,
  ServerCoreMethod,
} from "../../../server/api/messages.js";
import type { ApiKeyStore, DesktopShell } from "../contracts.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ServerCoreProcessClientOptions {
  storageRoot: string;
  collectorExecutableCandidates: string[];
  hostBundleIdentifier?: string;
  credentials: ApiKeyStore;
  desktopShell: DesktopShell;
}

const requestTimeoutMilliseconds = 60_000;
const startupTimeoutMilliseconds = 10_000;

export class ServerCoreProcessClient extends EventEmitter {
  private child?: UtilityProcess;
  private connection?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private snapshot: DesktopSnapshot = {
    locale: "en",
    connectionState: "stopped",
    recordingConsentGranted: false,
    observationPolicy: structuredClone(defaultObservationPolicy),
  };

  constructor(private readonly options: ServerCoreProcessClientOptions) {
    super();
  }

  current(): DesktopSnapshot {
    return this.snapshot;
  }

  connect(): Promise<void> {
    if (!this.connection) this.connection = this.spawn();
    return this.connection;
  }

  start(): Promise<DesktopSnapshot> {
    return this.request("start");
  }

  grantRecordingConsent(): Promise<DesktopSnapshot> {
    return this.request("grantRecordingConsent");
  }

  stop(): Promise<DesktopSnapshot> {
    return this.request("stop");
  }

  pause(): Promise<DesktopSnapshot> {
    return this.request("pause");
  }

  resume(): Promise<DesktopSnapshot> {
    return this.request("resume");
  }

  requestNative(command: NativePermissionCommand): Promise<DesktopSnapshot> {
    return this.request("requestNative", command);
  }

  setActiveApplicationAllowed(allowed: boolean): Promise<DesktopSnapshot> {
    return this.request("setActiveApplicationAllowed", allowed);
  }

  setActiveDomainAllowed(allowed: boolean): Promise<DesktopSnapshot> {
    return this.request("setActiveDomainAllowed", allowed);
  }

  updateObservationPolicy(policy: ObservationPolicy): Promise<DesktopSnapshot> {
    return this.request("updateObservationPolicy", policy);
  }

  setLocale(locale: AppLocale): Promise<DesktopSnapshot> {
    return this.request("setLocale", locale);
  }

  async configureLLM(input: LLMConfigurationInput): Promise<DesktopSnapshot> {
    const apiKey = input.apiKey.trim();
    if (
      apiKey &&
      validateModelConfiguration({
        protocol: input.protocol,
        model: input.model.trim(),
        endpoint: input.endpoint.trim(),
      })
    ) {
      await this.options.credentials.save(apiKey, this.snapshot.locale);
    }
    return this.request("configureLLM", input);
  }

  setLLMEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    return this.request("setLLMEnabled", enabled);
  }

  setMemorySynthesisEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    return this.request("setMemorySynthesisEnabled", enabled);
  }

  configureVisual(input: VisualConfigurationInput): Promise<DesktopSnapshot> {
    return this.request("configureVisual", input);
  }

  requestScreenCapturePermission(): Promise<DesktopSnapshot> {
    return this.request("requestScreenCapturePermission");
  }

  async removeLLMAPIKey(): Promise<DesktopSnapshot> {
    await this.options.credentials.remove();
    return this.request("removeLLMAPIKey");
  }

  async openDocument(id: string): Promise<DesktopSnapshot> {
    const filePath = await this.request<string>("documentPath", id);
    await this.openPath(filePath);
    return this.current();
  }

  deleteDocument(id: string): Promise<DesktopSnapshot> {
    return this.request("deleteDocument", id);
  }

  clearHistory(): Promise<DesktopSnapshot> {
    return this.request("clearHistory");
  }

  restoreHistory(id: string): Promise<DesktopSnapshot> {
    return this.request("restoreHistory", id);
  }

  async revealStorage(): Promise<DesktopSnapshot> {
    const storagePath = await this.request<string>("storagePath");
    await this.openPath(storagePath);
    return this.current();
  }

  searchMemory(query: string): Promise<HistorySearchResponse> {
    return this.request("searchMemory", query);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    await this.request("shutdown");
    this.terminate();
  }

  terminate(): void {
    const child = this.child;
    this.child = undefined;
    this.connection = undefined;
    this.rejectPending(new Error("ServerCore process stopped"));
    child?.kill();
  }

  private async spawn(): Promise<void> {
    const apiKey = await this.options.credentials.load();
    const child = utilityProcess.fork(
      fileURLToPath(new URL("./server-core-process.js", import.meta.url)),
      [],
      { stdio: "pipe", serviceName: "DeskLore ServerCore" },
    );
    this.child = child;
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("ServerCore process did not become ready"));
        this.terminate();
      }, startupTimeoutMilliseconds);
      let ready = false;

      child.on("message", (message) => {
        const value = message as ServerCoreOutboundMessage;
        if (value.type === "ready") {
          ready = true;
          clearTimeout(timer);
          this.updateSnapshot(value.snapshot);
          resolve();
          return;
        }
        if (value.type === "startup-error") {
          clearTimeout(timer);
          reject(new Error(value.error));
          this.terminate();
          return;
        }
        if (value.type === "snapshot") {
          this.updateSnapshot(value.snapshot);
          return;
        }
        if (value.type === "response") this.handleResponse(value);
      });
      child.once("spawn", () => {
        child.postMessage({
          type: "initialize",
          storageRoot: this.options.storageRoot,
          collectorExecutableCandidates: this.options.collectorExecutableCandidates,
          hostBundleIdentifier: this.options.hostBundleIdentifier,
          apiKey,
        });
      });
      child.once("error", () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error("ServerCore process failed to start"));
        }
      });
      child.once("exit", (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.connection = undefined;
        const error = new Error(`ServerCore process exited with code ${code}`);
        this.rejectPending(error);
        if (!ready) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        this.updateSnapshot({
          ...this.snapshot,
          connectionState: "failed",
          connectionError: error.message,
        });
      });
    });
  }

  private request<T>(method: ServerCoreMethod, ...parameters: unknown[]): Promise<T> {
    return this.connect().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`ServerCore timed out while handling ${method}`));
          }, requestTimeoutMilliseconds);
          this.pending.set(id, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
          });
          this.child!.postMessage({ type: "request", id, method, parameters });
        }),
    );
  }

  private handleResponse(response: ServerCoreResponseMessage): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    if (!response.ok) {
      request.reject(new Error(response.error ?? "ServerCore request failed"));
      return;
    }
    if (this.isDesktopSnapshot(response.value)) this.updateSnapshot(response.value);
    request.resolve(response.value);
  }

  private updateSnapshot(snapshot: DesktopSnapshot): void {
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }

  private isDesktopSnapshot(value: unknown): value is DesktopSnapshot {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Partial<DesktopSnapshot>;
    return (
      typeof snapshot.locale === "string" &&
      typeof snapshot.connectionState === "string" &&
      typeof snapshot.recordingConsentGranted === "boolean"
    );
  }

  private async openPath(filePath: string): Promise<void> {
    const error = await this.options.desktopShell.openPath(filePath);
    if (error) throw new Error(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
