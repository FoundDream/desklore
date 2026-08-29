import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  ApplicationUsageSummary,
  DailyApplicationUsage,
} from "../../../shared/contracts/index.js";
import { atomicWriteOwnedFile } from "../../../platform/node/atomic-owned-file.js";
import { ensureStorage, type StorageLayout } from "../storage/repository.js";
import type { HistoryApplication, UsageStateEvent, UsageStateReason } from "../contracts.js";

interface StoredApplicationUsage {
  bundleIdentifier: string;
  name: string;
  durationMilliseconds: number;
}

interface StoredUsageDay {
  schemaVersion: 1;
  date: string;
  applications: StoredApplicationUsage[];
}

interface OpenUsageInterval {
  application: HistoryApplication;
  startedAt: number;
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyWithOffset(date: Date, offset: number): string {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset));
}

function nextLocalMidnight(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function validStoredDay(value: unknown, expectedDate: string): StoredUsageDay | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<StoredUsageDay>;
  if (
    source.schemaVersion !== 1 ||
    source.date !== expectedDate ||
    !Array.isArray(source.applications)
  ) {
    return undefined;
  }
  const applications: StoredApplicationUsage[] = [];
  for (const item of source.applications) {
    if (
      !item ||
      typeof item.bundleIdentifier !== "string" ||
      !item.bundleIdentifier ||
      typeof item.name !== "string" ||
      !item.name ||
      !Number.isFinite(item.durationMilliseconds) ||
      item.durationMilliseconds < 0
    ) {
      return undefined;
    }
    applications.push({
      bundleIdentifier: item.bundleIdentifier,
      name: item.name,
      durationMilliseconds: Math.round(item.durationMilliseconds),
    });
  }
  return { schemaVersion: 1, date: expectedDate, applications };
}

function emptyDay(date: string): StoredUsageDay {
  return { schemaVersion: 1, date, applications: [] };
}

function cloneDay(day: StoredUsageDay): StoredUsageDay {
  return { ...day, applications: day.applications.map((item) => ({ ...item })) };
}

export class UsageTracker {
  private readonly days = new Map<string, StoredUsageDay>();
  private current?: OpenUsageInterval;
  private initialized = false;

  constructor(private readonly layout: StorageLayout) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureStorage(this.layout);
    await this.load();
    this.initialized = true;
  }

  async reload(): Promise<void> {
    this.current = undefined;
    this.days.clear();
    await ensureStorage(this.layout);
    await this.load();
    this.initialized = true;
  }

  async transition(event: UsageStateEvent): Promise<void> {
    await this.initialize();
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) return;
    if (this.current && timestamp < this.current.startedAt) return;
    if (
      event.state === "foreground" &&
      event.application &&
      this.current?.application.bundleIdentifier === event.application.bundleIdentifier
    ) {
      this.current.application = event.application;
      return;
    }
    await this.close(timestamp);
    if (event.state === "foreground" && event.application) {
      this.current = { application: event.application, startedAt: timestamp };
    }
  }

  async checkpoint(date = new Date()): Promise<void> {
    await this.initialize();
    const application = this.current?.application;
    if (!application) return;
    const timestamp = date.getTime();
    await this.close(timestamp);
    this.current = { application, startedAt: timestamp };
  }

  async end(
    date = new Date(),
    _reason: UsageStateReason = "collector_disconnected",
  ): Promise<void> {
    await this.initialize();
    await this.close(date.getTime());
  }

  summary(date = new Date()): ApplicationUsageSummary {
    const keys = Array.from({ length: 7 }, (_, index) => dateKeyWithOffset(date, -index)).reverse();
    const visible = new Map(
      keys.map((key) => [key, cloneDay(this.days.get(key) ?? emptyDay(key))]),
    );
    if (this.current && date.getTime() > this.current.startedAt) {
      this.addIntervalToDays(
        visible,
        this.current.application,
        this.current.startedAt,
        date.getTime(),
      );
    }
    const last7Days = keys.map((key) => this.publicDay(visible.get(key) ?? emptyDay(key)));
    return {
      today: last7Days.at(-1) ?? this.publicDay(emptyDay(localDateKey(date))),
      last7Days,
    };
  }

  private async load(): Promise<void> {
    for (const entry of await readdir(this.layout.usage, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
      const date = entry.name.slice(0, -5);
      try {
        const day = validStoredDay(
          JSON.parse(await readFile(path.join(this.layout.usage, entry.name), "utf8")),
          date,
        );
        if (day) this.days.set(date, day);
      } catch {
        // A damaged usage cache must not prevent the local history archive from opening.
      }
    }
  }

  private async close(endedAt: number): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current || endedAt <= current.startedAt) return;
    const touched = this.addIntervalToDays(
      this.days,
      current.application,
      current.startedAt,
      endedAt,
    );
    await Promise.all([...touched].map((key) => this.writeDay(this.days.get(key)!)));
  }

  private addIntervalToDays(
    target: Map<string, StoredUsageDay>,
    application: HistoryApplication,
    startedAt: number,
    endedAt: number,
  ): Set<string> {
    const touched = new Set<string>();
    let cursor = startedAt;
    while (cursor < endedAt) {
      const key = localDateKey(new Date(cursor));
      const chunkEnd = Math.min(endedAt, nextLocalMidnight(cursor));
      const day = target.get(key) ?? emptyDay(key);
      const existing = day.applications.find(
        (item) => item.bundleIdentifier === application.bundleIdentifier,
      );
      if (existing) {
        existing.name = application.name;
        existing.durationMilliseconds += chunkEnd - cursor;
      } else {
        day.applications.push({
          ...application,
          durationMilliseconds: chunkEnd - cursor,
        });
      }
      target.set(key, day);
      touched.add(key);
      cursor = chunkEnd;
    }
    return touched;
  }

  private async writeDay(day: StoredUsageDay): Promise<void> {
    const normalized: StoredUsageDay = {
      ...day,
      applications: [...day.applications].sort(
        (lhs, rhs) =>
          rhs.durationMilliseconds - lhs.durationMilliseconds || lhs.name.localeCompare(rhs.name),
      ),
    };
    await atomicWriteOwnedFile(
      path.join(this.layout.usage, `${day.date}.json`),
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
  }

  private publicDay(day: StoredUsageDay): DailyApplicationUsage {
    const applications = [...day.applications]
      .filter((item) => item.durationMilliseconds > 0)
      .sort(
        (lhs, rhs) =>
          rhs.durationMilliseconds - lhs.durationMilliseconds || lhs.name.localeCompare(rhs.name),
      )
      .map((item) => ({
        application: { bundleIdentifier: item.bundleIdentifier, name: item.name },
        durationMilliseconds: Math.round(item.durationMilliseconds),
      }));
    return {
      date: day.date,
      totalDurationMilliseconds: applications.reduce(
        (total, item) => total + item.durationMilliseconds,
        0,
      ),
      applications,
    };
  }
}
