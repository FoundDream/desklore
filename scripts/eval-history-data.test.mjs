import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEvents, normalizedEvent, tolerantMatchCount } from "./eval-history-data.mjs";

function event(timestamp, kind = "mouse.click", bundleIdentifier = "com.example.app") {
  return { timestamp, kind, app: "Example", bundleIdentifier };
}

test("normalizes candidate and Codex application schemas", () => {
  const raw = {
    timestamp: "2026-08-20T12:00:00.000Z",
    kind: "window.changed",
    application: { bundle_identifier: "com.example.app", name: "Example" },
  };
  assert.deepEqual(normalizedEvent(raw, "candidate"), {
    timestamp: "2026-08-20T12:00:00.000Z",
    kind: "window.changed",
    app: "Example",
    bundleIdentifier: "com.example.app",
    url: undefined,
    axText: undefined,
    raw,
  });
  assert.equal(
    normalizedEvent(
      {
        timestamp: "2026-08-20T12:00:00Z",
        kind: "window.changed",
        app: { bundleIdentifier: "com.example.app", name: "Example" },
      },
      "reference",
    ).bundleIdentifier,
    "com.example.app",
  );
});

test("tolerant matching is one-to-one within each kind and app stream", () => {
  const candidate = [
    event("2026-08-20T12:00:00.100Z"),
    event("2026-08-20T12:00:01.100Z"),
    event("2026-08-20T12:00:02.100Z", "selection.changed"),
  ];
  const reference = [
    event("2026-08-20T12:00:00.900Z"),
    event("2026-08-20T12:00:03.500Z"),
    event("2026-08-20T12:00:02.900Z", "selection.changed"),
  ];
  assert.equal(tolerantMatchCount(candidate, reference, 1_000), 2);
  assert.equal(tolerantMatchCount(candidate, reference, 100), 0);
});

test("evaluation reports precision, recall, F1, and per-kind coverage", () => {
  const candidate = [
    event("2026-08-20T12:00:00.000Z"),
    event("2026-08-20T12:00:01.000Z", "selection.changed"),
  ];
  const reference = [
    event("2026-08-20T12:00:00.500Z"),
    event("2026-08-20T12:00:01.500Z", "selection.changed"),
    event("2026-08-20T12:00:03.000Z", "selection.changed"),
  ];
  const result = evaluateEvents(candidate, reference, 1_000);
  assert.equal(result.exact.matches, 0);
  assert.equal(result.tolerant.matches, 2);
  assert.equal(result.tolerant.precision, 1);
  assert.equal(result.tolerant.recall, 2 / 3);
  assert.equal(result.byKind["selection.changed"].recall, 1 / 2);
});
