import { chmod, rename, writeFile } from "node:fs/promises";

export async function atomicWriteOwnedFile(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}
