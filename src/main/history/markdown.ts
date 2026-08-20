import type { HistoryApplication, TimelineActivityState, TimelineDocumentRecord } from "./types.js";

function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function unquoted(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  let result = "";
  let escaping = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaping) {
      result += character === "n" ? "\n" : character;
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else {
      result += character;
    }
  }
  return escaping ? `${result}\\` : result;
}

export function encodeTimelineMarkdown(document: TimelineDocumentRecord): string {
  const lines = [
    "---",
    `schema_version: ${document.schemaVersion}`,
    `id: ${quoted(document.id)}`,
    `source_segment_id: ${quoted(document.sourceSegmentID)}`,
    `started_at: ${quoted(document.startedAt)}`,
    `ended_at: ${quoted(document.endedAt)}`,
    `title: ${quoted(document.title)}`,
    `description: ${quoted(document.description)}`,
  ];
  if (document.activityState) lines.push(`activity_state: ${quoted(document.activityState)}`);
  lines.push("applications:");
  if (!document.applications.length) {
    lines.push("  []");
  } else {
    for (const application of document.applications) {
      lines.push(`  - bundle_id: ${quoted(application.bundleIdentifier)}`);
      lines.push(`    name: ${quoted(application.name)}`);
    }
  }
  lines.push("evidence_event_ids:");
  if (!document.evidenceEventIDs.length) lines.push("  []");
  else lines.push(...document.evidenceEventIDs.map((id) => `  - ${quoted(id)}`));
  lines.push("generator:");
  lines.push(`  type: ${quoted(document.generator.type)}`);
  lines.push(`  version: ${document.generator.version}`);
  if (document.generator.model) lines.push(`  model: ${quoted(document.generator.model)}`);
  if (document.generator.failureReason) {
    lines.push(`  failure_reason: ${quoted(document.generator.failureReason)}`);
  }
  lines.push(`created_at: ${quoted(document.createdAt)}`);
  lines.push("---", "", document.body.trim(), "");
  return lines.join("\n");
}

function valueAfterColon(line: string): string {
  const index = line.indexOf(":");
  return unquoted(index < 0 ? "" : line.slice(index + 1));
}

export function decodeTimelineMarkdown(
  markdown: string,
  filePath?: string,
): TimelineDocumentRecord {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("Missing timeline frontmatter");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new Error("Missing timeline frontmatter");
  const frontmatter = lines.slice(1, closing);
  const scalars = new Map<string, string>();
  for (const line of frontmatter) {
    if (line.startsWith(" ")) continue;
    const index = line.indexOf(":");
    if (index >= 0 && line.slice(index + 1).trim()) {
      scalars.set(line.slice(0, index), unquoted(line.slice(index + 1)));
    }
  }
  const required = (key: string): string => {
    const value = scalars.get(key);
    if (!value) throw new Error(`Missing timeline field: ${key}`);
    return value;
  };
  if (Number(required("schema_version")) !== 2) throw new Error("Unsupported timeline schema");

  const parseIndented = (section: string): string[] => {
    const start = frontmatter.indexOf(`${section}:`);
    if (start < 0) return [];
    const result: string[] = [];
    for (let index = start + 1; index < frontmatter.length; index += 1) {
      const line = frontmatter[index];
      if (!line?.startsWith(" ")) break;
      result.push(line);
    }
    return result;
  };

  const applications: HistoryApplication[] = [];
  let pending: Partial<HistoryApplication> = {};
  for (const line of parseIndented("applications")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- bundle_id:")) {
      if (pending.bundleIdentifier && pending.name)
        applications.push(pending as HistoryApplication);
      pending = { bundleIdentifier: valueAfterColon(trimmed) };
    } else if (trimmed.startsWith("name:")) {
      pending.name = valueAfterColon(trimmed);
    }
  }
  if (pending.bundleIdentifier && pending.name) applications.push(pending as HistoryApplication);

  const evidenceEventIDs = parseIndented("evidence_event_ids")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => unquoted(line.slice(1)));
  const generatorLines = parseIndented("generator").map((line) => line.trim());
  const generatorValue = (key: string): string | undefined => {
    const line = generatorLines.find((candidate) => candidate.startsWith(`${key}:`));
    return line ? valueAfterColon(line) : undefined;
  };
  const generatorType = generatorValue("type");
  const generatorVersion = Number(generatorValue("version"));
  if (!generatorType || !Number.isInteger(generatorVersion)) throw new Error("Invalid generator");

  const activityState = scalars.get("activity_state") as TimelineActivityState | undefined;
  return {
    schemaVersion: 2,
    id: required("id"),
    sourceSegmentID: required("source_segment_id"),
    startedAt: required("started_at"),
    endedAt: required("ended_at"),
    title: required("title"),
    description: required("description"),
    activityState,
    applications,
    evidenceEventIDs,
    generator: {
      type: generatorType,
      version: generatorVersion,
      model: generatorValue("model"),
      failureReason: generatorValue("failure_reason"),
    },
    createdAt: required("created_at"),
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
    filePath,
  };
}
