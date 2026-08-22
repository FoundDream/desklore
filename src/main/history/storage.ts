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
  state: string;
}

export function makeStorageLayout(root: string): StorageLayout {
  const memory = path.join(root, "memory");
  return {
    root,
    segments: path.join(root, "segments"),
    timeline: path.join(root, "timeline"),
    memory,
    memorySixHour: path.join(memory, "6h"),
    memoryDay: path.join(memory, "day"),
    state: path.join(root, "state"),
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
      layout.state,
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

async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export type SegmentMetric = "captured" | "policyBlocked" | "deduplicated" | "burstCoalesced";

export class SegmentStore {
  private current?: SegmentMetadata;

  constructor(readonly layout: StorageLayout) {}

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
    await atomicWrite(
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
