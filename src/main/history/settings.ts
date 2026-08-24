import { safeStorage } from "electron";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppLocale } from "../../shared/i18n.js";
import { isAppLocale, translate } from "../../shared/i18n.js";
import { isModelProtocol } from "../../shared/model.js";
import { defaultObservationPolicy, normalizeObservationPolicy } from "./policy.js";
import type { ObservationPolicy, TimelineLLMSettings, VisualSettings } from "./types.js";
import type { StorageLayout } from "./storage.js";

const defaultLLMSettings: TimelineLLMSettings = {
  enabled: false,
  memorySynthesisEnabled: false,
  protocol: "responses",
  model: "gpt-5.6-luna",
  endpoint: "https://api.openai.com/v1/responses",
};
export const defaultVisualSettings: VisualSettings = {
  axJudge: "rules",
  captureMode: "off",
  understandingMode: "off",
};
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

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export class HistorySettingsStore {
  private readonly policyPath: string;
  private readonly llmPath: string;
  private readonly apiKeyPath: string;
  private readonly visualPath: string;
  private readonly recordingConsentPath: string;
  private readonly interfacePath: string;

  constructor(layout: StorageLayout) {
    this.policyPath = path.join(layout.state, "observation-policy.json");
    this.llmPath = path.join(layout.state, "llm-settings.json");
    this.apiKeyPath = path.join(layout.state, "llm-api-key.bin");
    this.visualPath = path.join(layout.state, "visual-settings.json");
    this.recordingConsentPath = path.join(layout.state, "recording-consent.json");
    this.interfacePath = path.join(layout.state, "interface-settings.json");
  }

  async loadLocale(): Promise<AppLocale> {
    const stored = (await readJSON(this.interfacePath)) as
      | { schemaVersion?: unknown; locale?: unknown }
      | undefined;
    if (!stored) return "en";
    if (stored.schemaVersion !== 1 || !isAppLocale(stored.locale)) {
      throw new Error("Unsupported interface settings schema");
    }
    return stored.locale;
  }

  async saveLocale(locale: AppLocale): Promise<void> {
    await atomicWrite(
      this.interfacePath,
      `${JSON.stringify({ schemaVersion: 1, locale }, null, 2)}\n`,
    );
  }

  async loadPolicy(): Promise<ObservationPolicy> {
    const stored = (await readJSON(this.policyPath)) as
      | (Partial<ObservationPolicy> & { schemaVersion?: unknown })
      | undefined;
    if (!stored) return structuredClone(defaultObservationPolicy);
    const allowedBundleIdentifiers = stringArray(stored.allowedBundleIdentifiers);
    const blockedBundleIdentifiers = stringArray(stored.blockedBundleIdentifiers);
    const allowedDomains = stringArray(stored.allowedDomains);
    const blockedDomains = stringArray(stored.blockedDomains);
    const blockedWindowTitles = Array.isArray(stored.blockedWindowTitles)
      ? stored.blockedWindowTitles
      : stored.schemaVersion === 1
        ? []
        : undefined;
    if (
      ![1, 2].includes(stored.schemaVersion as number) ||
      !["observe", "do_not_observe"].includes(stored.defaultApplicationBehavior ?? "") ||
      !["observe", "do_not_observe"].includes(stored.defaultURLBehavior ?? "") ||
      !allowedBundleIdentifiers ||
      !blockedBundleIdentifiers ||
      !allowedDomains ||
      !blockedDomains ||
      !blockedWindowTitles
    ) {
      throw new Error("Unsupported observation policy schema");
    }
    const policy = normalizeObservationPolicy({
      defaultApplicationBehavior: stored.defaultApplicationBehavior!,
      defaultURLBehavior: stored.defaultURLBehavior!,
      allowedBundleIdentifiers,
      blockedBundleIdentifiers,
      allowedDomains,
      blockedDomains,
      blockedWindowTitles: blockedWindowTitles as ObservationPolicy["blockedWindowTitles"],
    });
    if (stored.schemaVersion === 1) await this.savePolicy(policy);
    return policy;
  }

  async savePolicy(policy: ObservationPolicy): Promise<void> {
    const normalized = normalizeObservationPolicy(policy);
    await atomicWrite(
      this.policyPath,
      `${JSON.stringify({ schemaVersion: 2, ...normalized }, null, 2)}\n`,
    );
  }

  async loadLLMSettings(): Promise<TimelineLLMSettings> {
    const stored = (await readJSON(this.llmPath)) as
      | (Partial<TimelineLLMSettings> & { schemaVersion?: unknown })
      | undefined;
    if (!stored) return { ...defaultLLMSettings };
    const protocol =
      stored.schemaVersion === undefined || stored.schemaVersion === 1
        ? "responses"
        : stored.protocol;
    if (
      typeof stored.enabled !== "boolean" ||
      typeof stored.memorySynthesisEnabled !== "boolean" ||
      !isModelProtocol(protocol) ||
      typeof stored.model !== "string" ||
      typeof stored.endpoint !== "string"
    ) {
      throw new Error("Unsupported model settings schema");
    }
    const settings: TimelineLLMSettings = {
      enabled: stored.enabled,
      memorySynthesisEnabled: stored.memorySynthesisEnabled,
      protocol,
      model: stored.model,
      endpoint: stored.endpoint,
    };
    if (!validateLLMSettings(settings)) throw new Error("Invalid model settings");
    if (stored.schemaVersion === undefined || stored.schemaVersion === 1) {
      await this.saveLLMSettings(settings);
    } else if (stored.schemaVersion !== 2) {
      throw new Error("Unsupported model settings schema");
    }
    return settings;
  }

  async saveLLMSettings(settings: TimelineLLMSettings): Promise<void> {
    await atomicWrite(
      this.llmPath,
      `${JSON.stringify({ schemaVersion: 2, ...settings }, null, 2)}\n`,
    );
  }

  async loadVisualSettings(): Promise<VisualSettings> {
    const stored = (await readJSON(this.visualPath)) as
      | (Partial<VisualSettings> & { schemaVersion?: unknown })
      | undefined;
    if (!stored) return { ...defaultVisualSettings };
    if (
      stored.schemaVersion !== 1 ||
      !["rules", "luna"].includes(stored.axJudge ?? "") ||
      !["off", "fallback"].includes(stored.captureMode ?? "") ||
      !["off", "ocr", "luna"].includes(stored.understandingMode ?? "")
    ) {
      throw new Error("Unsupported visual settings schema");
    }
    return {
      axJudge: stored.axJudge!,
      captureMode: stored.captureMode!,
      understandingMode: stored.understandingMode!,
    };
  }

  async saveVisualSettings(settings: VisualSettings): Promise<void> {
    await atomicWrite(
      this.visualPath,
      `${JSON.stringify({ schemaVersion: 1, ...settings }, null, 2)}\n`,
    );
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveAPIKey(apiKey: string, locale: AppLocale = "en"): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(translate(locale, "error.secureStorageUnavailable"));
    }
    await atomicWrite(this.apiKeyPath, safeStorage.encryptString(apiKey));
    await chmod(this.apiKeyPath, 0o600);
  }

  async removeAPIKey(): Promise<void> {
    await rm(this.apiKeyPath, { force: true });
  }

  async hasRecordingConsent(): Promise<boolean> {
    const stored = (await readJSON(this.recordingConsentPath)) as
      | { schemaVersion?: unknown; granted?: unknown }
      | undefined;
    return stored?.schemaVersion === 1 && stored.granted === true;
  }

  async grantRecordingConsent(date = new Date()): Promise<void> {
    await atomicWrite(
      this.recordingConsentPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          granted: true,
          grantedAt: date.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
}

export function validateLLMSettings(settings: TimelineLLMSettings): boolean {
  if (!isModelProtocol(settings.protocol)) return false;
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
