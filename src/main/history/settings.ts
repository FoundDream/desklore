import { safeStorage } from "electron";
import { execFile } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defaultObservationPolicy } from "./policy.js";
import type { ObservationPolicy, TimelineLLMSettings, VisualSettings } from "./types.js";
import type { StorageLayout } from "./storage.js";

const defaultLLMSettings: TimelineLLMSettings = {
  enabled: false,
  memorySynthesisEnabled: false,
  model: "gpt-5.6-luna",
  endpoint: "https://api.openai.com/v1/responses",
};
export const defaultVisualSettings: VisualSettings = {
  axJudge: "rules",
  captureMode: "off",
  understandingMode: "off",
};
const execFileAsync = promisify(execFile);
const legacyDefaultsDomain = "com.ziwen.computer-history.desktop.agent";
const legacyKeychainService = "com.ziwen.computer-history.desktop.agent.llm";

async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

async function readJSON(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export class HistorySettingsStore {
  private readonly policyPath: string;
  private readonly llmPath: string;
  private readonly apiKeyPath: string;
  private readonly visualPath: string;

  constructor(layout: StorageLayout) {
    this.policyPath = path.join(layout.state, "observation-policy.json");
    this.llmPath = path.join(layout.state, "llm-settings.json");
    this.apiKeyPath = path.join(layout.state, "llm-api-key.bin");
    this.visualPath = path.join(layout.state, "visual-settings.json");
  }

  async loadPolicy(): Promise<ObservationPolicy> {
    const stored = (await readJSON(this.policyPath)) as Partial<ObservationPolicy> | undefined;
    const source = stored ?? (await this.loadLegacyPolicy());
    if (!source) return structuredClone(defaultObservationPolicy);
    const policy: ObservationPolicy = {
      defaultApplicationBehavior:
        source.defaultApplicationBehavior === "do_not_observe" ? "do_not_observe" : "observe",
      defaultURLBehavior:
        source.defaultURLBehavior === "do_not_observe" ? "do_not_observe" : "observe",
      allowedBundleIdentifiers: stringArray(source.allowedBundleIdentifiers),
      blockedBundleIdentifiers: stringArray(source.blockedBundleIdentifiers),
      allowedDomains: stringArray(source.allowedDomains).map((value) => value.toLowerCase()),
      blockedDomains: stringArray(source.blockedDomains).map((value) => value.toLowerCase()),
    };
    if (!stored) await this.savePolicy(policy);
    return policy;
  }

  async savePolicy(policy: ObservationPolicy): Promise<void> {
    await atomicWrite(this.policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }

  async loadLLMSettings(): Promise<TimelineLLMSettings> {
    const stored = (await readJSON(this.llmPath)) as Partial<TimelineLLMSettings> | undefined;
    const source = stored ?? (await this.loadLegacyLLMSettings());
    if (!source) return { ...defaultLLMSettings };
    const settings = {
      enabled: source.enabled === true,
      memorySynthesisEnabled: source.memorySynthesisEnabled === true,
      model: typeof source.model === "string" ? source.model : defaultLLMSettings.model,
      endpoint: typeof source.endpoint === "string" ? source.endpoint : defaultLLMSettings.endpoint,
    };
    if (!stored) await this.saveLLMSettings(settings);
    return settings;
  }

  async saveLLMSettings(settings: TimelineLLMSettings): Promise<void> {
    await atomicWrite(this.llmPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  async loadVisualSettings(): Promise<VisualSettings> {
    const stored = (await readJSON(this.visualPath)) as Partial<VisualSettings> | undefined;
    if (!stored) return { ...defaultVisualSettings };
    return {
      axJudge: stored.axJudge === "luna" ? "luna" : "rules",
      captureMode: stored.captureMode === "fallback" ? "fallback" : "off",
      understandingMode:
        stored.understandingMode === "ocr" || stored.understandingMode === "luna"
          ? stored.understandingMode
          : "off",
    };
  }

  async saveVisualSettings(settings: VisualSettings): Promise<void> {
    await atomicWrite(this.visualPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  async hasAPIKey(): Promise<boolean> {
    if (process.env.OPENAI_API_KEY) return true;
    return (await this.loadAPIKey()) !== undefined;
  }

  async loadAPIKey(): Promise<string | undefined> {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    try {
      const encrypted = await readFile(this.apiKeyPath);
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const legacy = await this.loadLegacyAPIKey();
        if (legacy && safeStorage.isEncryptionAvailable()) await this.saveAPIKey(legacy);
        return legacy;
      }
      throw error;
    }
  }

  async saveAPIKey(apiKey: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储当前不可用，API Key 未保存。");
    }
    await atomicWrite(this.apiKeyPath, safeStorage.encryptString(apiKey));
    await chmod(this.apiKeyPath, 0o600);
  }

  async removeAPIKey(): Promise<void> {
    await rm(this.apiKeyPath, { force: true });
    await execFileAsync("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      legacyKeychainService,
      "-a",
      "api-key",
    ]).catch(() => undefined);
  }

  private async legacyDefault(key: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/defaults", [
        "read",
        legacyDefaultsDomain,
        key,
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async loadLegacyPolicy(): Promise<Partial<ObservationPolicy> | undefined> {
    const raw = await this.legacyDefault("observation-policy");
    if (!raw) return undefined;
    const hex = raw.match(/0x([0-9a-f\s]+)/i)?.[1] ?? raw.match(/<([0-9a-f\s]+)>/i)?.[1];
    if (!hex) return undefined;
    try {
      return JSON.parse(
        Buffer.from(hex.replace(/\s/g, ""), "hex").toString("utf8"),
      ) as Partial<ObservationPolicy>;
    } catch {
      return undefined;
    }
  }

  private async loadLegacyLLMSettings(): Promise<Partial<TimelineLLMSettings> | undefined> {
    const [enabled, model, endpoint] = await Promise.all([
      this.legacyDefault("timeline-llm-enabled"),
      this.legacyDefault("timeline-llm-model"),
      this.legacyDefault("timeline-llm-endpoint"),
    ]);
    if (!enabled && !model && !endpoint) return undefined;
    return {
      enabled: enabled === "1" || enabled?.toLowerCase() === "true",
      memorySynthesisEnabled: false,
      model,
      endpoint,
    };
  }

  private async loadLegacyAPIKey(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-s",
        legacyKeychainService,
        "-a",
        "api-key",
        "-w",
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

export function validateLLMSettings(settings: TimelineLLMSettings): boolean {
  if (!settings.model.trim()) return false;
  try {
    const endpoint = new URL(settings.endpoint);
    if (endpoint.protocol === "https:") return true;
    return (
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}
