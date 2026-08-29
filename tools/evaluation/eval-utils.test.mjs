import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  argumentsFrom,
  countBy,
  dateArgument,
  positiveInteger,
  readJSONLines,
  readOptionalJSONLines,
} from "./eval-utils.mjs";

void test("parses evaluator values and boolean flags", () => {
  assert.deepEqual(
    [...argumentsFrom(["--max-cases", "12", "--run-models"]).entries()],
    [
      ["max-cases", "12"],
      ["run-models", "true"],
    ],
  );
});

void test("validates shared numeric and date arguments", () => {
  assert.equal(positiveInteger(undefined, 12, "max-cases"), 12);
  assert.equal(positiveInteger("4", 12, "max-cases"), 4);
  assert.throws(() => positiveInteger("0", 12, "max-cases"), /Invalid --max-cases/);
  assert.equal(dateArgument("2026-08-24", "since"), Date.parse("2026-08-24"));
  assert.throws(() => dateArgument("not-a-date", "since"), /Invalid --since/);
});

void test("counts values by descending frequency", () => {
  assert.deepEqual(
    countBy(["b", "a", "b"], (value) => value),
    { b: 2, a: 1 },
  );
});

void test("preserves strict and optional JSONL missing-file behavior", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desklore-eval-utils-"));
  try {
    const filePath = path.join(root, "records.jsonl");
    await writeFile(filePath, '{"ok":true}\nnot-json\n');
    assert.deepEqual(await readJSONLines(filePath), {
      values: [{ ok: true }],
      malformedLines: 1,
    });
    await assert.rejects(readJSONLines(path.join(root, "missing.jsonl")), { code: "ENOENT" });
    assert.deepEqual(await readOptionalJSONLines(path.join(root, "missing.jsonl")), {
      values: [],
      malformedLines: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
