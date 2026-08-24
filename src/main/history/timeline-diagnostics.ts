import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProtocol } from "../../shared/model.js";
import type { StorageLayout } from "./storage.js";

const diagnosticsFile = "timeline-agent-runs.jsonl";
const retentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const maximumRetainedRuns = 2_000;

export interface TimelineAgentRunRecord {
  schemaVersion: 1;
  id: string;
  sourceSegmentID: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  provider: "openai" | "custom" | "unavailable";
  protocol: ModelProtocol;
  retry: boolean;
  turns: number;
  toolCalls: Record<string, number>;
  inspectedEventCount: number;
  evidenceBytes: number;
  inputTokens: number;
  outputTokens: number;
  latencyMilliseconds: number;
  terminalState: "succeeded" | "fallback";
  failureReason?: string;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRun(value: unknown): TimelineAgentRunRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<TimelineAgentRunRecord>;
  if (
    source.schemaVersion !== 1 ||
    typeof source.id !== "string" ||
    typeof source.sourceSegmentID !== "string" ||
    typeof source.startedAt !== "string" ||
    typeof source.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(source.startedAt)) ||
    !Number.isFinite(Date.parse(source.finishedAt)) ||
    typeof source.model !== "string" ||
    !["openai", "custom", "unavailable"].includes(source.provider ?? "") ||
    !["responses", "chat_completions"].includes(source.protocol ?? "") ||
    typeof source.retry !== "boolean" ||
    !["succeeded", "fallback"].includes(source.terminalState ?? "")
  ) {
    return undefined;
  }
  const toolCalls = Object.fromEntries(
    Object.entries(source.toolCalls ?? {})
      .filter(([name, value]) => /^[a-z][a-z0-9_]{0,63}$/.test(name) && typeof value === "number")
      .map(([name, value]) => [name, count(value)]),
  );
  return {
    schemaVersion: 1,
    id: bounded(source.id, 80),
    sourceSegmentID: bounded(source.sourceSegmentID, 80),
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    model: bounded(source.model, 160),
    provider: source.provider as TimelineAgentRunRecord["provider"],
    protocol: source.protocol as ModelProtocol,
    retry: source.retry,
    turns: count(source.turns ?? 0),
    toolCalls,
    inspectedEventCount: count(source.inspectedEventCount ?? 0),
    evidenceBytes: count(source.evidenceBytes ?? 0),
    inputTokens: count(source.inputTokens ?? 0),
    outputTokens: count(source.outputTokens ?? 0),
    latencyMilliseconds: count(source.latencyMilliseconds ?? 0),
    terminalState: source.terminalState as TimelineAgentRunRecord["terminalState"],
    failureReason:
      typeof source.failureReason === "string" ? bounded(source.failureReason, 160) : undefined,
  };
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export function timelineAgentProvider(endpoint: string): "openai" | "custom" {
  try {
    return new URL(endpoint).hostname === "api.openai.com" ? "openai" : "custom";
  } catch {
    return "custom";
  }
}

export class TimelineAgentDiagnosticsRepository {
  private writeWork: Promise<void> = Promise.resolve();

  constructor(private readonly layout: StorageLayout) {}

  filePath(): string {
    return path.join(this.layout.timeline, diagnosticsFile);
  }

  async load(): Promise<TimelineAgentRunRecord[]> {
    try {
      const contents = await readFile(this.filePath(), "utf8");
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeRun(JSON.parse(line));
          } catch {
            return undefined;
          }
        })
        .filter((record): record is TimelineAgentRunRecord => record !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  append(record: TimelineAgentRunRecord, now = new Date()): Promise<void> {
    const normalized = normalizeRun(record);
    if (!normalized) return Promise.reject(new Error("Invalid timeline agent diagnostic"));
    const operation = this.writeWork.then(async () => {
      await mkdir(this.layout.timeline, { recursive: true, mode: 0o700 });
      const cutoff = now.getTime() - retentionMilliseconds;
      const retained = (await this.load())
        .filter((item) => Date.parse(item.finishedAt) >= cutoff)
        .concat(normalized)
        .slice(-maximumRetainedRuns);
      await atomicWrite(
        this.filePath(),
        `${retained.map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
    });
    this.writeWork = operation.catch(() => undefined);
    return operation;
  }
}
