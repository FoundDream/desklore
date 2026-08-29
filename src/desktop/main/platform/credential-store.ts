import { safeStorage } from "electron";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AppLocale } from "../../../shared/i18n/index.js";
import { translate } from "../../../shared/i18n/index.js";
import { atomicWriteOwnedFile } from "../../../platform/node/atomic-owned-file.js";
import type { ApiKeyStore } from "../contracts.js";

export class ElectronCredentialStore implements ApiKeyStore {
  private readonly apiKeyPath: string;

  constructor(historyRoot: string) {
    this.apiKeyPath = path.join(historyRoot, "state", "llm-api-key.bin");
  }

  async has(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  async load(): Promise<string | undefined> {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    try {
      const encrypted = await readFile(this.apiKeyPath);
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(apiKey: string, locale: AppLocale): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(translate(locale, "error.secureStorageUnavailable"));
    }
    await atomicWriteOwnedFile(this.apiKeyPath, safeStorage.encryptString(apiKey));
  }

  async remove(): Promise<void> {
    await rm(this.apiKeyPath, { force: true });
  }
}
