import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeStorageLayout } from "../storage/repository.js";
import { normalizeUsageStateEvent, type UsageStateEvent } from "../contracts.js";
import { localDateKey, UsageTracker } from "./tracker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function foreground(date: Date, bundleIdentifier: string, name: string): UsageStateEvent {
  return {
    timestamp: date.toISOString(),
    state: "foreground",
    reason: "application_activation",
    application: { bundleIdentifier, name },
  };
}

async function tracker(): Promise<{ root: string; value: UsageTracker }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-usage-"));
  temporaryDirectories.push(root);
  const value = new UsageTracker(makeStorageLayout(root));
  await value.initialize();
  return { root, value };
}

describe("foreground usage tracking", () => {
  it("attributes each non-overlapping foreground interval to the active application", async () => {
    const { root, value } = await tracker();
    const start = at(2026, 8, 29, 10);
    await value.transition(foreground(start, "com.example.editor", "Editor"));
    await value.transition(
      foreground(new Date(start.getTime() + 10 * 60_000), "com.example.browser", "Browser"),
    );
    await value.transition({
      timestamp: new Date(start.getTime() + 25 * 60_000).toISOString(),
      state: "unavailable",
      reason: "pause",
    });

    const summary = value.summary(new Date(start.getTime() + 30 * 60_000));
    expect(summary.today.totalDurationMilliseconds).toBe(25 * 60_000);
    expect(summary.today.applications).toEqual([
      {
        application: { bundleIdentifier: "com.example.browser", name: "Browser" },
        durationMilliseconds: 15 * 60_000,
      },
      {
        application: { bundleIdentifier: "com.example.editor", name: "Editor" },
        durationMilliseconds: 10 * 60_000,
      },
    ]);

    const restored = new UsageTracker(makeStorageLayout(root));
    await restored.initialize();
    expect(restored.summary(new Date(start.getTime() + 30 * 60_000)).today).toEqual(summary.today);
  });

  it("ends the previous interval for excluded applications without persisting their identity", async () => {
    const { root, value } = await tracker();
    const start = at(2026, 8, 29, 11);
    await value.transition(foreground(start, "com.example.allowed", "Allowed"));
    await value.transition({
      timestamp: new Date(start.getTime() + 10 * 60_000).toISOString(),
      state: "excluded",
      reason: "application_activation",
    });
    await value.transition(
      foreground(new Date(start.getTime() + 20 * 60_000), "com.example.next", "Next"),
    );
    await value.transition({
      timestamp: new Date(start.getTime() + 25 * 60_000).toISOString(),
      state: "unavailable",
      reason: "collector_disconnected",
    });

    expect(value.summary(new Date(start.getTime() + 30 * 60_000)).today.applications).toEqual([
      {
        application: { bundleIdentifier: "com.example.allowed", name: "Allowed" },
        durationMilliseconds: 10 * 60_000,
      },
      {
        application: { bundleIdentifier: "com.example.next", name: "Next" },
        durationMilliseconds: 5 * 60_000,
      },
    ]);
    const stored = await readFile(path.join(root, "usage", `${localDateKey(start)}.json`), "utf8");
    expect(stored).not.toContain("excluded");
    expect(stored).not.toContain("private");
  });

  it("checkpoints an open interval without double counting the live total", async () => {
    const { value } = await tracker();
    const start = at(2026, 8, 29, 12);
    await value.transition(foreground(start, "com.example.editor", "Editor"));
    await value.checkpoint(new Date(start.getTime() + 10 * 60_000));
    const summary = value.summary(new Date(start.getTime() + 15 * 60_000));
    expect(summary.today.totalDurationMilliseconds).toBe(15 * 60_000);
  });

  it("ignores an out-of-order state event instead of moving the active interval backward", async () => {
    const { value } = await tracker();
    const start = at(2026, 8, 29, 12);
    await value.transition(foreground(start, "com.example.editor", "Editor"));
    await value.transition(
      foreground(new Date(start.getTime() - 5 * 60_000), "com.example.browser", "Browser"),
    );
    await value.transition({
      timestamp: new Date(start.getTime() + 10 * 60_000).toISOString(),
      state: "unavailable",
      reason: "pause",
    });

    expect(value.summary(new Date(start.getTime() + 15 * 60_000)).today.applications).toEqual([
      {
        application: { bundleIdentifier: "com.example.editor", name: "Editor" },
        durationMilliseconds: 10 * 60_000,
      },
    ]);
  });

  it("splits a foreground interval at the local day boundary", async () => {
    const { value } = await tracker();
    const start = at(2026, 8, 28, 23, 55);
    const end = at(2026, 8, 29, 0, 10);
    await value.transition(foreground(start, "com.example.editor", "Editor"));
    await value.transition({
      timestamp: end.toISOString(),
      state: "unavailable",
      reason: "screen_sleep",
    });

    const summary = value.summary(end);
    expect(summary.last7Days.at(-2)?.date).toBe(localDateKey(start));
    expect(summary.last7Days.at(-2)?.totalDurationMilliseconds).toBe(5 * 60_000);
    expect(summary.today.date).toBe(localDateKey(end));
    expect(summary.today.totalDurationMilliseconds).toBe(10 * 60_000);
  });

  it("rejects an identity on excluded or unavailable protocol states", () => {
    expect(() =>
      normalizeUsageStateEvent({
        timestamp: new Date().toISOString(),
        state: "excluded",
        reason: "application_activation",
        application: { bundleIdentifier: "com.example.private", name: "Private" },
      }),
    ).toThrow("Invalid usage state event");
  });
});
