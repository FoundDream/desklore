import {
  appendFile,
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
  metadataForDisk,
  normalizeHistoryEvent,
  normalizeMetadata,
  type ClosedSegment,
  type HistoryEvent,
  type SegmentMetadata,
} from "./types.js";

export const segmentDurationMilliseconds = 10 * 60 * 1_000;

export interface StorageLayout {
  root: string;
  segments: string;
  timeline: string;
  state: string;
}

export function makeStorageLayout(root: string): StorageLayout {
  return {
    root,
    segments: path.join(root, "segments"),
    timeline: path.join(root, "timeline"),
    state: path.join(root, "state"),
  };
}

export async function ensureStorage(layout: StorageLayout): Promise<void> {
  await Promise.all(
    [layout.root, layout.segments, layout.timeline, layout.state].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
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
  await writeFile(temporary, contents);
  await rename(temporary, filePath);
}

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
      "utf8",
    );
    metadata.eventCount += 1;
    await this.writeMetadata(metadata);
    this.current = metadata;
    return closed;
  }

  async recordSuppressed(timestamp: string): Promise<ClosedSegment | undefined> {
    await ensureStorage(this.layout);
    const id = segmentIdentifier(new Date(timestamp));
    let closed: ClosedSegment | undefined;
    if (this.current && this.current.id !== id) {
      closed = await this.finalize(this.current);
      this.current = undefined;
    }
    const metadata = await this.loadOrCreateMetadata(id, timestamp);
    metadata.suppressedEventCount += 1;
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
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => normalizeHistoryEvent(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
