import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineRollupRepository } from "./repository.js";
import {
  ensureStorage,
  hardenStoragePermissions,
  makeStorageLayout,
} from "../storage/repository.js";
import type { TimelineDocumentRecord } from "../contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function document(overrides: Partial<TimelineDocumentRecord> = {}): TimelineDocumentRecord {
  return {
    schemaVersion: 4,
    id: "document-1",
    sourceSegmentID: "2026-08-20T06-10-00Z",
    startedAt: "2026-08-20T06:10:00.000Z",
    endedAt: "2026-08-20T06:20:00.000Z",
    title: "实现 DeskLore 的分层时间线",
    description: "完成了六小时和每日聚合，并保留来源时间线引用。",
    continuationHint: "补充真实数据评测",
    claims: [{ text: "分层时间线已可检索。", evidenceEventIDs: ["event-1"] }],
    applications: [{ bundleIdentifier: "com.openai.codex", name: "Codex" }],
    evidenceEventIDs: ["event-1"],
    generator: { type: "llm", version: 2, model: "gpt-5.6-luna" },
    createdAt: "2026-08-20T06:20:01.000Z",
    body: "## Recording summary\n\n完成分层时间线。",
    ...overrides,
  };
}

describe("Timeline rollups", () => {
  it("materializes reloadable six-hour and daily rollups with source lineage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-rollup-"));
    temporaryDirectories.push(root);
    const repository = new TimelineRollupRepository(makeStorageLayout(root));

    const records = await repository.refresh([document()]);

    expect(records.map((record) => record.kind).sort()).toEqual(["6h", "day"]);
    expect(records.every((record) => record.status === "final")).toBe(true);
    expect(records.every((record) => record.sourceDocumentIDs.includes("document-1"))).toBe(true);
    await expect(repository.load()).resolves.toEqual(records);

    await expect(repository.refresh([])).resolves.toEqual([]);
    await expect(repository.load()).resolves.toEqual([]);
  });

  it("materializes provisional rollups before their time boundary and finalizes them at it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-rollup-"));
    temporaryDirectories.push(root);
    const repository = new TimelineRollupRepository(makeStorageLayout(root));
    const source = document({
      startedAt: new Date(2026, 7, 20, 6, 10).toISOString(),
      endedAt: new Date(2026, 7, 20, 6, 20).toISOString(),
    });

    const beforeBoundary = await repository.refresh(
      [source],
      new Date(2026, 7, 20, 11, 59, 59, 999),
    );

    expect(
      beforeBoundary
        .map((record) => [record.kind, record.status])
        .sort(([lhs], [rhs]) => lhs.localeCompare(rhs)),
    ).toEqual([
      ["6h", "provisional"],
      ["day", "provisional"],
    ]);

    const atBoundary = await repository.refresh([source], new Date(2026, 7, 20, 12));

    expect(atBoundary.map((record) => record.kind).sort()).toEqual(["6h", "day"]);
    expect(atBoundary.find((record) => record.kind === "6h")?.status).toBe("final");
    expect(atBoundary.find((record) => record.kind === "day")?.status).toBe("provisional");
  });

  it("retrieves across 10-minute and rollup layers with local evidence references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-rollup-"));
    temporaryDirectories.push(root);
    const repository = new TimelineRollupRepository(makeStorageLayout(root));
    const documents = [document()];
    const rollups = await repository.refresh(documents);

    const result = repository.search("分层时间线 可检索", documents, rollups);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("10min");
    expect(result.answer).toMatch(/\[(?:10min|6h|day):/);
  });

  it("searches retained body text and cited claims", () => {
    const repository = new TimelineRollupRepository(makeStorageLayout("/unused"));
    const source = document({
      body: "正文唯一关键词",
      claims: [{ text: "断言唯一关键词", evidenceEventIDs: ["event-1"] }],
    });
    expect(repository.search("正文唯一关键词", [source], []).matches).toHaveLength(1);
    expect(repository.search("断言唯一关键词", [source], []).matches).toHaveLength(1);
    expect(repository.search("completelyabsentneedle", [source], []).matches).toHaveLength(0);
  });

  it("filters today and yesterday independently of content relevance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 6, 12));
    const repository = new TimelineRollupRepository(makeStorageLayout("/unused"));
    const today = document({
      id: "today",
      startedAt: new Date(2026, 8, 6, 0, 1).toISOString(),
      body: "retrievalneedle",
    });
    const yesterday = document({
      id: "yesterday",
      startedAt: new Date(2026, 8, 5, 23, 59).toISOString(),
      body: "retrievalneedle",
    });
    expect(
      repository
        .search("今天 retrievalneedle", [today, yesterday], [])
        .matches.map((match) => match.id),
    ).toEqual(["today"]);
    expect(
      repository
        .search("yesterday retrievalneedle", [today, yesterday], [])
        .matches.map((match) => match.id),
    ).toEqual(["yesterday"]);
    expect(
      repository.search("今天 completelyabsentneedle", [today, yesterday], []).matches,
    ).toEqual([]);
    expect(
      repository.search("昨天", [today, yesterday], []).matches.map((match) => match.id),
    ).toEqual(["yesterday"]);
    expect(repository.search(" ", [today, yesterday], []).matches).toEqual([]);
  });

  it("keeps independent matches while removing overlapping rollup sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-search-dedupe-"));
    temporaryDirectories.push(root);
    const repository = new TimelineRollupRepository(makeStorageLayout(root));
    const sources = [
      document(),
      document({ id: "document-2", sourceSegmentID: "2026-08-20T06-20-00Z" }),
    ];
    const rollups = await repository.refresh(sources);
    const result = repository.search("分层时间线 可检索", sources, rollups);
    expect(result.matches.map((match) => match.id).sort()).toEqual(["document-1", "document-2"]);
    expect(repository.search("分层时间线", sources, [], 1).matches).toHaveLength(1);
  });

  it("uses model-backed synthesis once per source digest and keeps deterministic citations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-rollup-"));
    temporaryDirectories.push(root);
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      title: "DeskLore 分层时间线实现",
                      description: "实现并验证了本地分层时间线。",
                      narrative: "工作从十分钟摘要扩展到六小时和每日归纳，并保留确定性的来源引用。",
                      continuation_hint: "补充真实数据评测",
                      important_context: ["来源 ID 由本地代码生成"],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const repository = new TimelineRollupRepository(makeStorageLayout(root), async () => ({
      settings: {
        enabled: true,
        rollupSynthesisEnabled: true,
        protocol: "responses",
        model: "gpt-5.6-luna",
        endpoint: "https://api.openai.com/v1/responses",
      },
      apiKey: "test-key",
    }));

    const first = await repository.refresh([document()]);
    const second = await repository.refresh([document()]);

    expect(first.every((record) => record.generator.type === "llm")).toBe(true);
    expect(first.every((record) => record.continuationHint === "补充真实数据评测")).toBe(true);
    expect(first.every((record) => record.body.includes("timeline:document-1"))).toBe(true);
    expect(first.every((record) => !record.body.includes("## Tasks"))).toBe(true);
    expect(first.every((record) => !record.body.includes("## Outcomes"))).toBe(true);
    expect(first.every((record) => !record.body.includes("## Open loops"))).toBe(true);
    expect(second.map((record) => record.sourceDigest)).toEqual(
      first.map((record) => record.sourceDigest),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("hardens existing storage files and directories without following symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-permissions-"));
    temporaryDirectories.push(root);
    const layout = makeStorageLayout(root);
    await ensureStorage(layout);
    const filePath = path.join(layout.state, "settings.json");
    await writeFile(filePath, "{}", { mode: 0o666 });

    await hardenStoragePermissions(layout);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
