import { readFile } from "node:fs/promises";

export function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      values.set(key.slice(2), value);
      index += 1;
    } else {
      values.set(key.slice(2), "true");
    }
  }
  return values;
}

export function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

export function dateArgument(value, name) {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

export function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((lhs, rhs) => rhs[1] - lhs[1]));
}

export async function readJSONLines(filePath, allowMissing = false) {
  try {
    const contents = await readFile(filePath, "utf8");
    const values = [];
    let malformedLines = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        malformedLines += 1;
      }
    }
    return { values, malformedLines };
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return { values: [], malformedLines: 0 };
    throw error;
  }
}

export function readOptionalJSONLines(filePath) {
  return readJSONLines(filePath, true);
}
