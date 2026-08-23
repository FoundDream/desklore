import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDemoHistory } from "./create-demo-history.mjs";

const roots = [];

test.afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("creates a deterministic synthetic timeline in an isolated root", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".demo-history-test-"));
  roots.push(root);
  const result = await createDemoHistory({ root });
  assert.equal(result.mode, "timeline");
  assert.equal(
    await readFile(path.join(root, ".desklore-demo.json"), "utf8"),
    '{\n  "schemaVersion": 1,\n  "synthetic": true,\n  "purpose": "capture-safe DeskLore demo data"\n}\n',
  );
  const first = await readFile(
    path.join(root, "history", "timeline", "2026-08-22T08-00-00Z-demo-timeline-001.md"),
    "utf8",
  );
  assert.match(first, /schema_version: 4/);
  assert.match(first, /demo-event-001/);
  assert.match(first, /Example Writer/);
  assert.match(
    await readFile(
      path.join(root, "history", "segments", "2026-08-22T08-00-00Z", "events.jsonl"),
      "utf8",
    ),
    /Draft a reproducible release note/,
  );
});

test("creates onboarding data without granting recording consent", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".demo-onboarding-test-"));
  roots.push(root);
  await createDemoHistory({ root, mode: "onboarding" });
  await assert.rejects(
    readFile(path.join(root, "history", "state", "recording-consent.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("rejects a demo root outside the current repository", async () => {
  await assert.rejects(
    createDemoHistory({ root: path.join(path.parse(process.cwd()).root, "tmp-desklore-demo") }),
    /child directory of the current repository/,
  );
});
