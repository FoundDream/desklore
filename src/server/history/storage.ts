import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteOwnedFile } from "./owned-file.js";
import {
  eventForDisk,
  evidenceEnrichmentForDisk,
  metadataForDisk,
  normalizeEventEvidenceEnrichment,
  normalizeHistoryEvent,
  normalizeMetadata,
  type ClosedSegment,
  type HistoryEvent,
  type EventEvidenceEnrichment,
  type SegmentMetadata,
} from "./types.js";

export const segmentDurationMilliseconds = 10 * 60 * 1_000;
const eventEvidenceFile = "evidence.jsonl";

export interface StorageLayout {
  root: string;
  segments: string;
  timeline: string;
  memory: string;
  memorySixHour: string;
  memoryDay: string;
  usage: string;
  state: string;
  trash: string;
}

export interface HistoryArchive {
  id: string;
  deletedAt: string;
  documentCount: number;
  memoryCount: number;
}

const historyArchiveSchemaVersion = 1;
const historyArchiveMetadataFile = "archive.json";

export function makeStorageLayout(root: string): StorageLayout {
  const memory = path.join(root, "memory");
  return {
    root,
    segments: path.join(root, "segments"),
    timeline: path.join(root, "timeline"),
    memory,
    memorySixHour: path.join(memory, "6h"),
    memoryDay: path.join(memory, "day"),
    usage: path.join(root, "usage"),
    state: path.join(root, "state"),
    trash: path.join(root, ".trash"),
  };
}

export async function ensureStorage(layout: StorageLayout): Promise<void> {
  await Promise.all(
    [
      layout.root,
      layout.segments,
      layout.timeline,
      layout.memory,
      layout.memorySixHour,
      layout.memoryDay,
      layout.usage,
      layout.state,
      layout.trash,
    ].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
}

/** Tightens permissions without following links outside the application-owned tree. */
export async function hardenStoragePermissions(layout: StorageLayout): Promise<void> {
  await ensureStorage(layout);
  const pending = [layout.root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) continue;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) pending.push(entryPath);
      else if (stats.isFile()) await chmod(entryPath, 0o600);
    }
  }
}

function assertApplicationOwnedHistoryDirectory(layout: StorageLayout, directory: string): string {
  const normalized = path.normalize(directory);
  if (path.dirname(normalized) !== path.normalize(layout.root)) {
    throw new Error("History directory is outside the storage root");
  }
  return normalized;
}

function archiveDirectory(layout: StorageLayout, id: string): string {
  if (!id || path.basename(id) !== id || !/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error("Invalid history archive identifier");
  }
  const directory = path.join(layout.trash, id);
  if (path.dirname(directory) !== path.normalize(layout.trash)) {
    throw new Error("History archive is outside the trash directory");
  }
  return directory;
}

function normalizeHistoryArchive(value: unknown): HistoryArchive | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Partial<HistoryArchive> & { schemaVersion?: unknown };
  if (
    stored.schemaVersion !== historyArchiveSchemaVersion ||
    typeof stored.id !== "string" ||
    path.basename(stored.id) !== stored.id ||
    !/^[a-zA-Z0-9-]+$/.test(stored.id) ||
    typeof stored.deletedAt !== "string" ||
    !Number.isFinite(Date.parse(stored.deletedAt)) ||
    !Number.isInteger(stored.documentCount) ||
    (stored.documentCount ?? -1) < 0 ||
    !Number.isInteger(stored.memoryCount) ||
    (stored.memoryCount ?? -1) < 0
  ) {
    return undefined;
  }
  return {
    id: stored.id,
    deletedAt: stored.deletedAt,
    documentCount: stored.documentCount,
    memoryCount: stored.memoryCount,
  } as HistoryArchive;
}

async function readHistoryArchive(
  layout: StorageLayout,
  id: string,
): Promise<HistoryArchive | undefined> {
  const directory = archiveDirectory(layout, id);
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
    const stored = normalizeHistoryArchive(
      JSON.parse(await readFile(path.join(directory, historyArchiveMetadataFile), "utf8")),
    );
    return stored?.id === id ? stored : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function latestHistoryArchive(
  layout: StorageLayout,
): Promise<HistoryArchive | undefined> {
  await ensureStorage(layout);
  const entries = await readdir(layout.trash, { withFileTypes: true });
  const archives = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => readHistoryArchive(layout, entry.name)),
  );
  return archives
    .filter((archive): archive is HistoryArchive => archive !== undefined)
    .sort((lhs, rhs) => Date.parse(rhs.deletedAt) - Date.parse(lhs.deletedAt))[0];
}

export async function clearHistoryData(
  layout: StorageLayout,
  counts: { documentCount?: number; memoryCount?: number } = {},
  date = new Date(),
): Promise<HistoryArchive> {
  await ensureStorage(layout);
  const deletedAt = date.toISOString();
  const baseID = deletedAt.replace(/[:.]/g, "-");
  let id = baseID;
  let directory = archiveDirectory(layout, id);
  for (let suffix = 1; ; suffix += 1) {
    try {
      await mkdir(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      id = `${baseID}-${suffix}`;
      directory = archiveDirectory(layout, id);
    }
  }

  const archive: HistoryArchive = {
    id,
    deletedAt,
    documentCount: Math.max(0, counts.documentCount ?? 0),
    memoryCount: Math.max(0, counts.memoryCount ?? 0),
  };
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    for (const source of [layout.segments, layout.timeline, layout.memory, layout.usage]) {
      const normalized = assertApplicationOwnedHistoryDirectory(layout, source);
      const stats = await lstat(normalized);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("History path is not an application-owned directory");
      }
      const destination = path.join(directory, path.basename(normalized));
      await rename(normalized, destination);
      moved.push({ source: normalized, destination });
    }
    await writeFile(
      path.join(directory, historyArchiveMetadataFile),
      `${JSON.stringify({ schemaVersion: historyArchiveSchemaVersion, ...archive }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await ensureStorage(layout);
    return archive;
  } catch (error) {
    for (const item of moved.reverse()) {
      await rm(item.source, { recursive: true, force: true }).catch(() => undefined);
      await rename(item.destination, item.source).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await ensureStorage(layout).catch(() => undefined);
    throw error;
  }
}

async function historyDirectoriesAreEmpty(layout: StorageLayout): Promise<boolean> {
  if ((await readdir(layout.segments)).length || (await readdir(layout.timeline)).length) {
    return false;
  }
  const memoryEntries = await readdir(layout.memory, { withFileTypes: true });
  for (const entry of memoryEntries) {
    if (!entry.isDirectory() || !["6h", "day"].includes(entry.name)) return false;
    if ((await readdir(path.join(layout.memory, entry.name))).length) return false;
  }
  if ((await readdir(layout.usage)).length) return false;
  return true;
}

export async function restoreHistoryData(
  layout: StorageLayout,
  id: string,
): Promise<HistoryArchive> {
  await ensureStorage(layout);
  const archive = await readHistoryArchive(layout, id);
  if (!archive) throw new Error("History recovery archive was not found");
  if (!(await historyDirectoriesAreEmpty(layout))) {
    throw new Error("New history exists. Clear it before restoring the previous archive.");
  }

  const directory = archiveDirectory(layout, id);
  const restored: Array<{ source: string; destination: string }> = [];
  try {
    for (const destination of [layout.segments, layout.timeline, layout.memory, layout.usage]) {
      const normalized = assertApplicationOwnedHistoryDirectory(layout, destination);
      const source = path.join(directory, path.basename(normalized));
      const stats = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && normalized === path.normalize(layout.usage))
          return undefined;
        throw error;
      });
      if (!stats) continue;
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("History recovery archive is incomplete");
      }
      await rm(normalized, { recursive: true, force: true });
      await rename(source, normalized);
      restored.push({ source, destination: normalized });
    }
    await rm(path.join(directory, historyArchiveMetadataFile), { force: true });
    await rm(directory, { recursive: true });
    await ensureStorage(layout);
    return archive;
  } catch (error) {
    for (const item of restored.reverse()) {
      await rename(item.destination, item.source).catch(() => undefined);
    }
    await ensureStorage(layout).catch(() => undefined);
    throw error;
  }
}

export async function pruneHistoryArchives(layout: StorageLayout, cutoff: Date): Promise<number> {
  await ensureStorage(layout);
  const entries = await readdir(layout.trash, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const archive = await readHistoryArchive(layout, entry.name);
    if (!archive || Date.parse(archive.deletedAt) >= cutoff.getTime()) continue;
    await rm(archiveDirectory(layout, archive.id), { recursive: true });
    removed += 1;
  }
  return removed;
}

export function segmentStart(date: Date): Date {
  return new Date(
    Math.floor(date.getTime() / segmentDurationMilliseconds) * segmentDurationMilliseconds,
  );
}

export function segmentIdentifier(date: Date): string {
  return segmentStart(date)
    .toISOString()
    .replace(/:\d{2}\.000Z$/, "-00Z")
    .replace(/:/g, "-");
}

export type SegmentMetric = "captured" | "policyBlocked" | "deduplicated" | "burstCoalesced";

export class SegmentStore {
  private current?: SegmentMetadata;

  constructor(readonly layout: StorageLayout) {}

  reset(): void {
    this.current = undefined;
  }

  async append(event: HistoryEvent): Promise<ClosedSegment | undefined> {
    await ensureStorage(this.layout);
    const id = segmentIdentifier(new Date(event.timestamp));
    let closed: ClosedSegment | undefined;
    if (this.current && this.current.id !== id) {
      closed = await this.finalize(this.current);
      this.current = undefined;
    }

    const metadata = await this.loadOrCreateMetadata(id, event.timestamp);
    const directoryPath = path.join(this.layout.segments, id);
    await appendFile(
      path.join(directoryPath, metadata.eventsFile),
      `${JSON.stringify(eventForDisk(event))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(path.join(directoryPath, metadata.eventsFile), 0o600);
    metadata.eventCount += 1;
    await this.writeMetadata(metadata);
    this.current = metadata;
    return closed;
  }

  async appendEvidence(enrichment: EventEvidenceEnrichment): Promise<void> {
    await ensureStorage(this.layout);
    const id = segmentIdentifier(new Date(enrichment.eventTimestamp));
    const directoryPath = path.join(this.layout.segments, id);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const filePath = path.join(directoryPath, eventEvidenceFile);
    await appendFile(filePath, `${JSON.stringify(evidenceEnrichmentForDisk(enrichment))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(filePath, 0o600);
  }

  async recordSuppressed(timestamp: string): Promise<ClosedSegment | undefined> {
    return this.recordMetric(timestamp, "policyBlocked");
  }

  async recordMetric(
    timestamp: string,
    metric: SegmentMetric,
    count = 1,
  ): Promise<ClosedSegment | undefined> {
    await ensureStorage(this.layout);
    const id = segmentIdentifier(new Date(timestamp));
    let closed: ClosedSegment | undefined;
    if (this.current && this.current.id !== id) {
      closed = await this.finalize(this.current);
      this.current = undefined;
    }
    const metadata = await this.loadOrCreateMetadata(id, timestamp);
    if (metric === "captured") metadata.capturedEventCount += count;
    if (metric === "policyBlocked") metadata.policyBlockedEventCount += count;
    if (metric === "deduplicated") metadata.deduplicatedEventCount += count;
    if (metric === "burstCoalesced") metadata.burstCoalescedEventCount += count;
    metadata.suppressedEventCount =
      metadata.policyBlockedEventCount +
      metadata.deduplicatedEventCount +
      metadata.burstCoalescedEventCount;
    await this.writeMetadata(metadata);
    this.current = metadata;
    return closed;
  }

  async closeExpired(date = new Date()): Promise<ClosedSegment | undefined> {
    if (!this.current) return undefined;
    if (date.getTime() < Date.parse(this.current.startedAt) + segmentDurationMilliseconds) {
      return undefined;
    }
    const closed = await this.finalize(this.current);
    this.current = undefined;
    return closed;
  }

  async pendingClosedSegments(): Promise<ClosedSegment[]> {
    await ensureStorage(this.layout);
    const entries = await readdir(this.layout.segments, { withFileTypes: true });
    const segments: ClosedSegment[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryPath = path.join(this.layout.segments, entry.name);
      const metadata = await this.readMetadata(directoryPath).catch(() => undefined);
      if (metadata?.endedAt) segments.push(this.closed(metadata));
    }
    return segments.sort(
      (lhs, rhs) => Date.parse(lhs.metadata.startedAt) - Date.parse(rhs.metadata.startedAt),
    );
  }

  async recoverExpiredSegments(date = new Date()): Promise<ClosedSegment[]> {
    await ensureStorage(this.layout);
    const entries = await readdir(this.layout.segments, { withFileTypes: true });
    const recovered: ClosedSegment[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryPath = path.join(this.layout.segments, entry.name);
      const stats = await lstat(directoryPath);
      if (stats.isSymbolicLink()) continue;
      const metadata = await this.readMetadata(directoryPath).catch(() => undefined);
      if (
        metadata &&
        !metadata.endedAt &&
        Date.parse(metadata.startedAt) + segmentDurationMilliseconds <= date.getTime()
      ) {
        recovered.push(await this.finalize(metadata));
        if (this.current?.id === metadata.id) this.current = undefined;
      }
    }
    return recovered.sort(
      (lhs, rhs) => Date.parse(lhs.metadata.startedAt) - Date.parse(rhs.metadata.startedAt),
    );
  }

  async pruneSegments(cutoff: Date): Promise<number> {
    await ensureStorage(this.layout);
    const entries = await readdir(this.layout.segments, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryPath = path.join(this.layout.segments, entry.name);
      if (path.dirname(directoryPath) !== path.normalize(this.layout.segments)) continue;
      const stats = await lstat(directoryPath);
      if (stats.isSymbolicLink()) continue;
      const metadata = await this.readMetadata(directoryPath).catch(() => undefined);
      if (!metadata) continue;
      const effectiveEnd = metadata.endedAt
        ? Date.parse(metadata.endedAt)
        : Date.parse(metadata.startedAt) + segmentDurationMilliseconds;
      if (effectiveEnd >= cutoff.getTime()) continue;
      await rm(directoryPath, { recursive: true });
      removed += 1;
      if (this.current?.id === metadata.id) this.current = undefined;
    }
    return removed;
  }

  async deleteSegment(id: string): Promise<boolean> {
    if (!id || path.basename(id) !== id) throw new Error("Invalid segment identifier");
    const directoryPath = path.join(this.layout.segments, id);
    if (path.dirname(directoryPath) !== path.normalize(this.layout.segments)) {
      throw new Error("Segment is outside the storage directory");
    }
    try {
      const stats = await lstat(directoryPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Segment path is not an application-owned directory");
      }
      await rm(directoryPath, { recursive: true });
      if (this.current?.id === id) this.current = undefined;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async pruneVisualEvidence(cutoff: Date): Promise<number> {
    await ensureStorage(this.layout);
    const entries = await readdir(this.layout.segments, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryPath = path.join(this.layout.segments, entry.name);
      const filePath = path.join(directoryPath, eventEvidenceFile);
      let lines: string[];
      try {
        lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let changed = false;
      const retained: string[] = [];
      for (const line of lines) {
        const enrichment = normalizeEventEvidenceEnrichment(JSON.parse(line));
        const visualDate = Date.parse(
          enrichment.visual?.capturedAt ?? enrichment.createdAt ?? enrichment.eventTimestamp,
        );
        if (enrichment.visual && Number.isFinite(visualDate) && visualDate < cutoff.getTime()) {
          changed = true;
          removed += 1;
          if (enrichment.axSufficiency) {
            retained.push(
              JSON.stringify(evidenceEnrichmentForDisk({ ...enrichment, visual: undefined })),
            );
          }
          continue;
        }
        retained.push(JSON.stringify(evidenceEnrichmentForDisk(enrichment)));
      }
      if (!changed) continue;
      if (retained.length) await atomicWriteOwnedFile(filePath, `${retained.join("\n")}\n`);
      else await rm(filePath, { force: true });
    }
    return removed;
  }

  async readEvents(segment: ClosedSegment): Promise<HistoryEvent[]> {
    try {
      const contents = await readFile(segment.eventsPath, "utf8");
      const events = contents
        .split("\n")
        .filter(Boolean)
        .map((line) => normalizeHistoryEvent(JSON.parse(line)));
      const evidenceByEventID = await this.readEvidence(segment.directoryPath);
      return events.map((event) => {
        const evidence = evidenceByEventID.get(event.id.toLowerCase());
        return evidence
          ? {
              ...event,
              evidence: {
                axSufficiency: evidence.axSufficiency ?? event.evidence?.axSufficiency,
                visual: evidence.visual ?? event.evidence?.visual,
              },
            }
          : event;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readEvidence(
    directoryPath: string,
  ): Promise<Map<string, HistoryEvent["evidence"]>> {
    try {
      const contents = await readFile(path.join(directoryPath, eventEvidenceFile), "utf8");
      const result = new Map<string, HistoryEvent["evidence"]>();
      for (const line of contents.split("\n").filter(Boolean)) {
        const enrichment = normalizeEventEvidenceEnrichment(JSON.parse(line));
        const previous = result.get(enrichment.eventID) ?? {};
        result.set(enrichment.eventID, {
          axSufficiency: enrichment.axSufficiency ?? previous.axSufficiency,
          visual: enrichment.visual ?? previous.visual,
        });
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
  }

  private async loadOrCreateMetadata(id: string, timestamp: string): Promise<SegmentMetadata> {
    if (this.current?.id === id) return this.current;
    const directoryPath = path.join(this.layout.segments, id);
    await mkdir(directoryPath, { recursive: true });
    const existing = await this.readMetadata(directoryPath).catch(() => undefined);
    return (
      existing ?? {
        schemaVersion: 1,
        id,
        startedAt: segmentStart(new Date(timestamp)).toISOString(),
        eventCount: 0,
        suppressedEventCount: 0,
        capturedEventCount: 0,
        policyBlockedEventCount: 0,
        deduplicatedEventCount: 0,
        burstCoalescedEventCount: 0,
        eventsFile: "events.jsonl",
      }
    );
  }

  private async readMetadata(directoryPath: string): Promise<SegmentMetadata> {
    return normalizeMetadata(
      JSON.parse(await readFile(path.join(directoryPath, "metadata.json"), "utf8")),
    );
  }

  private async writeMetadata(metadata: SegmentMetadata): Promise<void> {
    const directoryPath = path.join(this.layout.segments, metadata.id);
    await mkdir(directoryPath, { recursive: true });
    await atomicWriteOwnedFile(
      path.join(directoryPath, "metadata.json"),
      `${JSON.stringify(metadataForDisk(metadata), null, 2)}\n`,
    );
  }

  private async finalize(metadata: SegmentMetadata): Promise<ClosedSegment> {
    const finalized = {
      ...metadata,
      endedAt: new Date(Date.parse(metadata.startedAt) + segmentDurationMilliseconds).toISOString(),
    };
    await this.writeMetadata(finalized);
    return this.closed(finalized);
  }

  private closed(metadata: SegmentMetadata): ClosedSegment {
    const directoryPath = path.join(this.layout.segments, metadata.id);
    return {
      metadata,
      directoryPath,
      eventsPath: path.join(directoryPath, metadata.eventsFile),
    };
  }
}
