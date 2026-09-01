import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function timestamp(value) {
  return value.toISOString().replace(/[:.]/g, "-");
}

async function ownedDirectory(directory) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Expected an application-owned directory: ${directory}`);
  }
}

async function rollupFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith("-memory.md")) {
      throw new Error(`Unexpected legacy rollup entry: ${path.join(directory, entry.name)}`);
    }
    files.push(path.join(directory, entry.name));
  }
  return files.sort();
}

function migratedMarkdown(contents, now) {
  const endedAt = contents.match(/^ended_at:\s*(.+)$/m)?.[1];
  if (!endedAt) throw new Error("Legacy rollup is missing ended_at");
  let parsedEnd;
  try {
    parsedEnd = JSON.parse(endedAt);
  } catch {
    parsedEnd = endedAt.trim();
  }
  if (typeof parsedEnd !== "string" || !Number.isFinite(Date.parse(parsedEnd))) {
    throw new Error("Legacy rollup has an invalid ended_at");
  }
  const status = Date.parse(parsedEnd) <= now.getTime() ? "final" : "provisional";
  const schemaUpdated = contents.replace(/^schema_version:\s*2$/m, "schema_version: 1");
  if (schemaUpdated === contents) throw new Error("Legacy rollup does not use schema version 2");
  const withStatus = schemaUpdated.replace(
    /^(kind:\s*.+)$/m,
    `$1\nstatus: ${JSON.stringify(status)}`,
  );
  if (withStatus === schemaUpdated) throw new Error("Legacy rollup is missing kind");
  return withStatus
    .replace(/^## Memory summary$/gm, "## Timeline summary")
    .replace(/^## 记忆摘要$/gm, "## 时间线总结");
}

function migratedLLMSettings(contents) {
  const stored = JSON.parse(contents);
  if (
    stored?.schemaVersion !== 2 ||
    typeof stored.memorySynthesisEnabled !== "boolean" ||
    typeof stored.enabled !== "boolean"
  ) {
    throw new Error("Legacy model settings do not use the expected schema");
  }
  const { memorySynthesisEnabled, ...rest } = stored;
  return `${JSON.stringify(
    { ...rest, schemaVersion: 3, rollupSynthesisEnabled: memorySynthesisEnabled },
    null,
    2,
  )}\n`;
}

export async function migrateTimelineRollups({ root, now = new Date(), backupRoot } = {}) {
  if (!root || !path.isAbsolute(root) || path.basename(path.normalize(root)) !== "history") {
    throw new Error("Migration root must be an absolute DeskLore history directory");
  }
  const legacyRoot = path.join(root, "memory");
  const rollupsRoot = path.join(root, "rollups");
  const llmSettingsPath = path.join(root, "state", "llm-settings.json");
  await ownedDirectory(root);
  await ownedDirectory(legacyRoot);
  for (const kind of ["6h", "day"]) await ownedDirectory(path.join(legacyRoot, kind));

  const rollupsStats = await lstat(rollupsRoot).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rollupsStats) {
    if (!rollupsStats.isDirectory() || rollupsStats.isSymbolicLink()) {
      throw new Error("Timeline rollup target is not an application-owned directory");
    }
    const entries = await readdir(rollupsRoot, { withFileTypes: true });
    for (const entry of entries) {
      const expectedEmptyDirectory =
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        ["6h", "day"].includes(entry.name) &&
        (await readdir(path.join(rollupsRoot, entry.name))).length === 0;
      if (!expectedEmptyDirectory) {
        throw new Error("Timeline rollup target already contains data");
      }
    }
    await rm(rollupsRoot, { recursive: true });
  }

  const legacyFiles = [
    ...(await rollupFiles(path.join(legacyRoot, "6h"))),
    ...(await rollupFiles(path.join(legacyRoot, "day"))),
  ];
  const llmSettings = await readFile(llmSettingsPath, "utf8");
  const nextLLMSettings = migratedLLMSettings(llmSettings);
  const resolvedBackupRoot =
    backupRoot ?? path.join(path.dirname(root), "migration-backups", timestamp(now));
  if (!path.isAbsolute(resolvedBackupRoot)) throw new Error("Backup root must be absolute");
  if (path.normalize(resolvedBackupRoot).startsWith(`${path.normalize(root)}${path.sep}`)) {
    throw new Error("Backup root must be outside the history directory");
  }
  await mkdir(path.dirname(resolvedBackupRoot), { recursive: true, mode: 0o700 });
  await mkdir(resolvedBackupRoot, { recursive: false, mode: 0o700 });
  await cp(legacyRoot, path.join(resolvedBackupRoot, "memory"), {
    recursive: true,
    preserveTimestamps: true,
  });
  await mkdir(path.join(resolvedBackupRoot, "state"), { mode: 0o700 });
  await cp(llmSettingsPath, path.join(resolvedBackupRoot, "state", "llm-settings.json"), {
    preserveTimestamps: true,
  });

  let moved = false;
  try {
    await rename(legacyRoot, rollupsRoot);
    moved = true;
    for (const legacyFile of legacyFiles) {
      const relative = path.relative(legacyRoot, legacyFile);
      const currentPath = path.join(rollupsRoot, relative);
      const nextPath = currentPath.replace(/-memory\.md$/, "-rollup.md");
      const nextContents = migratedMarkdown(await readFile(currentPath, "utf8"), now);
      await writeFile(nextPath, nextContents, { mode: 0o600 });
      await chmod(nextPath, 0o600);
      await rm(currentPath);
    }
    await writeFile(llmSettingsPath, nextLLMSettings, { mode: 0o600 });
    await chmod(llmSettingsPath, 0o600);
    for (const directory of [
      rollupsRoot,
      path.join(rollupsRoot, "6h"),
      path.join(rollupsRoot, "day"),
    ]) {
      await chmod(directory, 0o700);
    }
    const migratedFiles = [
      ...(await readdir(path.join(rollupsRoot, "6h"))),
      ...(await readdir(path.join(rollupsRoot, "day"))),
    ].filter((name) => name.endsWith("-rollup.md"));
    if (migratedFiles.length !== legacyFiles.length) {
      throw new Error("Migrated rollup count does not match the legacy source count");
    }
    const summary = {
      schemaVersion: 1,
      migratedAt: now.toISOString(),
      sourceCount: legacyFiles.length,
      targetCount: migratedFiles.length,
      sourceDirectory: "memory",
      targetDirectory: "rollups",
    };
    await writeFile(
      path.join(resolvedBackupRoot, "migration.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { ...summary, backupRoot: resolvedBackupRoot };
  } catch (error) {
    if (moved) {
      await rm(rollupsRoot, { recursive: true, force: true });
      await cp(path.join(resolvedBackupRoot, "memory"), legacyRoot, { recursive: true });
      await cp(path.join(resolvedBackupRoot, "state", "llm-settings.json"), llmSettingsPath);
    }
    throw error;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await migrateTimelineRollups({
    root: argument("--root"),
    backupRoot: argument("--backup-root"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
