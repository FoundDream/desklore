import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteOwnedFile } from "../../../../platform/node/atomic-owned-file.js";
import type { StorageLayout } from "../../storage/repository.js";

const jobsFile = "timeline-agent-jobs.json";

export type TimelineAgentJobStatus =
  | "baseline_ready"
  | "queued"
  | "running"
  | "waiting_runtime"
  | "waiting_provider"
  | "waiting_configuration"
  | "stalled"
  | "paused"
  | "succeeded"
  | "cancelled"
  | "source_unavailable";

export interface TimelineAgentJob {
  schemaVersion: 1;
  id: string;
  sourceSegmentID: string;
  documentID: string;
  fingerprint: string;
  status: TimelineAgentJobStatus;
  wakeReason?: string;
  failureClass?: string;
  failureSignature?: string;
  totalTurns: number;
  totalToolCalls: number;
  totalSubmissions: number;
  totalProviderRequests: number;
  totalRuntimeFailures: number;
  consecutiveFailures: number;
  noProgressStreak: number;
  nextEligibleAt?: string;
  createdAt: string;
  updatedAt: string;
}

const statuses = new Set<TimelineAgentJobStatus>([
  "baseline_ready",
  "queued",
  "running",
  "waiting_runtime",
  "waiting_provider",
  "waiting_configuration",
  "stalled",
  "paused",
  "succeeded",
  "cancelled",
  "source_unavailable",
]);

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeJob(value: unknown): TimelineAgentJob | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<TimelineAgentJob>;
  if (
    source.schemaVersion !== 1 ||
    typeof source.id !== "string" ||
    typeof source.sourceSegmentID !== "string" ||
    typeof source.documentID !== "string" ||
    typeof source.fingerprint !== "string" ||
    !statuses.has(source.status as TimelineAgentJobStatus) ||
    typeof source.totalTurns !== "number" ||
    typeof source.totalToolCalls !== "number" ||
    typeof source.totalSubmissions !== "number" ||
    typeof source.totalProviderRequests !== "number" ||
    typeof source.totalRuntimeFailures !== "number" ||
    typeof source.consecutiveFailures !== "number" ||
    typeof source.noProgressStreak !== "number" ||
    typeof source.createdAt !== "string" ||
    typeof source.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(source.createdAt)) ||
    !Number.isFinite(Date.parse(source.updatedAt))
  ) {
    return undefined;
  }
  const parsedNextEligibleAt =
    typeof source.nextEligibleAt === "string" && Number.isFinite(Date.parse(source.nextEligibleAt))
      ? source.nextEligibleAt
      : undefined;
  return {
    schemaVersion: 1,
    id: source.id.slice(0, 80),
    sourceSegmentID: source.sourceSegmentID.slice(0, 80),
    documentID: source.documentID.slice(0, 80),
    fingerprint: source.fingerprint.slice(0, 128),
    status: source.status as TimelineAgentJobStatus,
    wakeReason: typeof source.wakeReason === "string" ? source.wakeReason.slice(0, 80) : undefined,
    failureClass:
      typeof source.failureClass === "string" ? source.failureClass.slice(0, 160) : undefined,
    failureSignature:
      typeof source.failureSignature === "string"
        ? source.failureSignature.slice(0, 160)
        : undefined,
    totalTurns: count(source.totalTurns),
    totalToolCalls: count(source.totalToolCalls),
    totalSubmissions: count(source.totalSubmissions),
    totalProviderRequests: count(source.totalProviderRequests),
    totalRuntimeFailures: count(source.totalRuntimeFailures),
    consecutiveFailures: count(source.consecutiveFailures),
    noProgressStreak: count(source.noProgressStreak),
    nextEligibleAt: parsedNextEligibleAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export class TimelineAgentJobRepository {
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly layout: StorageLayout) {}

  filePath(): string {
    return path.join(this.layout.timeline, jobsFile);
  }

  async load(): Promise<TimelineAgentJob[]> {
    await this.work;
    try {
      const parsed = JSON.parse(await readFile(this.filePath(), "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(normalizeJob)
        .filter((job): job is TimelineAgentJob => job !== undefined)
        .sort((lhs, rhs) => Date.parse(lhs.createdAt) - Date.parse(rhs.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  create(
    sourceSegmentID: string,
    documentID: string,
    fingerprint: string,
    date = new Date(),
  ): Promise<TimelineAgentJob> {
    const createdAt = date.toISOString();
    const job: TimelineAgentJob = {
      schemaVersion: 1,
      id: randomUUID().toLowerCase(),
      sourceSegmentID,
      documentID,
      fingerprint,
      status: "baseline_ready",
      wakeReason: "segment_closed",
      totalTurns: 0,
      totalToolCalls: 0,
      totalSubmissions: 0,
      totalProviderRequests: 0,
      totalRuntimeFailures: 0,
      consecutiveFailures: 0,
      noProgressStreak: 0,
      createdAt,
      updatedAt: createdAt,
    };
    return this.mutate((jobs) => {
      const existing = jobs.find((item) => item.sourceSegmentID === sourceSegmentID);
      if (existing) return existing;
      jobs.push(job);
      return job;
    });
  }

  update(
    id: string,
    patch: Partial<Omit<TimelineAgentJob, "schemaVersion" | "id" | "createdAt">>,
    date = new Date(),
  ): Promise<TimelineAgentJob | undefined> {
    return this.mutate((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) return undefined;
      const next = normalizeJob({ ...jobs[index], ...patch, updatedAt: date.toISOString() });
      if (!next) throw new Error("Invalid timeline agent job update");
      jobs[index] = next;
      return next;
    });
  }

  deleteBySegment(sourceSegmentID: string): Promise<void> {
    return this.mutate((jobs) => {
      const retained = jobs.filter((job) => job.sourceSegmentID !== sourceSegmentID);
      jobs.splice(0, jobs.length, ...retained);
    });
  }

  async clear(): Promise<void> {
    this.work = this.work.then(() => rm(this.filePath(), { force: true }));
    await this.work;
  }

  private mutate<T>(operation: (jobs: TimelineAgentJob[]) => T): Promise<T> {
    const next = this.work.then(async () => {
      let jobs: TimelineAgentJob[] = [];
      try {
        const parsed = JSON.parse(await readFile(this.filePath(), "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          jobs = parsed
            .map(normalizeJob)
            .filter((job): job is TimelineAgentJob => job !== undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") jobs = [];
      }
      const result = operation(jobs);
      await mkdir(path.dirname(this.filePath()), { recursive: true, mode: 0o700 });
      await atomicWriteOwnedFile(this.filePath(), `${JSON.stringify(jobs, null, 2)}\n`);
      return result;
    });
    this.work = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
