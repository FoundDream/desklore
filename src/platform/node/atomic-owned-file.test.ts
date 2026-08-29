import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteOwnedFile } from "./atomic-owned-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("owner-only atomic files", () => {
  it("replaces the destination and restores owner-only permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desklore-owned-file-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "state.json");
    await writeFile(filePath, "old", { mode: 0o600 });
    await chmod(filePath, 0o644);

    await atomicWriteOwnedFile(filePath, "new");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
