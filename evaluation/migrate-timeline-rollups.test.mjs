import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateTimelineRollups } from "../scripts/migrate-timeline-rollups.mjs";

void test("migrates legacy memory rollups and model settings with a recoverable backup", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "desklore-rollup-migration-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "history");
  const memory = path.join(root, "memory");
  const state = path.join(root, "state");
  await mkdir(path.join(memory, "6h"), { recursive: true });
  await mkdir(path.join(memory, "day"), { recursive: true });
  await mkdir(state, { recursive: true });
  const markdown = [
    "---",
    "schema_version: 2",
    'id: "6h-2026-08-20T00:00:00.000Z"',
    'kind: "6h"',
    'started_at: "2026-08-20T00:00:00.000Z"',
    'ended_at: "2026-08-20T06:00:00.000Z"',
    'title: "Focused work"',
    'description: "A source-backed summary."',
    "applications:",
    "  []",
    "source_document_ids:",
    '  - "document-1"',
    "source_segment_ids:",
    '  - "segment-1"',
    'source_digest: "digest"',
    'generator_type: "deterministic"',
    "generator_version: 2",
    'created_at: "2026-08-20T06:00:00.000Z"',
    "---",
    "",
    "## Memory summary",
    "",
    "A source-backed summary.",
    "",
  ].join("\n");
  await writeFile(path.join(memory, "6h", "source-6h-memory.md"), markdown);
  await writeFile(
    path.join(state, "llm-settings.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      memorySynthesisEnabled: true,
      protocol: "responses",
      model: "gpt-5.6-luna",
      endpoint: "https://api.openai.com/v1/responses",
    })}\n`,
  );
  const backupRoot = path.join(temporary, "backup");

  const result = await migrateTimelineRollups({
    root,
    backupRoot,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });

  assert.equal(result.sourceCount, 1);
  assert.deepEqual(await readdir(path.join(root, "rollups", "6h")), ["source-6h-rollup.md"]);
  const migrated = await readFile(path.join(root, "rollups", "6h", "source-6h-rollup.md"), "utf8");
  assert.match(migrated, /^schema_version: 1$/m);
  assert.match(migrated, /^status: "final"$/m);
  assert.match(migrated, /^## Timeline summary$/m);
  const settings = JSON.parse(await readFile(path.join(state, "llm-settings.json"), "utf8"));
  assert.equal(settings.schemaVersion, 3);
  assert.equal(settings.rollupSynthesisEnabled, true);
  assert.equal("memorySynthesisEnabled" in settings, false);
  await readFile(path.join(backupRoot, "memory", "6h", "source-6h-memory.md"), "utf8");
});
