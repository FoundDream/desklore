import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppLocale } from "../../../shared/i18n/index.js";
import { isAppLocale } from "../../../shared/i18n/index.js";
import { defaultObservationPolicy } from "../../../shared/defaults.js";
import { isModelProtocol, validateModelConfiguration } from "../../../shared/model.js";
import { normalizeObservationPolicy } from "../policy/policy.js";
import { atomicWriteOwnedFile } from "../../../platform/node/atomic-owned-file.js";
import type { ObservationPolicy, TimelineLLMSettings, VisualSettings } from "../contracts.js";
import type { StorageLayout } from "../storage/repository.js";

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
  private readonly visualPath: string;
  private readonly recordingConsentPath: string;
  private readonly interfacePath: string;

  constructor(layout: StorageLayout) {
    this.policyPath = path.join(layout.state, "observation-policy.json");
    this.llmPath = path.join(layout.state, "llm-settings.json");
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
    await atomicWriteOwnedFile(
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
    await atomicWriteOwnedFile(
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
    if (!validateModelConfiguration(settings)) throw new Error("Invalid model settings");
    if (stored.schemaVersion === undefined || stored.schemaVersion === 1) {
      await this.saveLLMSettings(settings);
    } else if (stored.schemaVersion !== 2) {
      throw new Error("Unsupported model settings schema");
    }
    return settings;
  }

  async saveLLMSettings(settings: TimelineLLMSettings): Promise<void> {
    await atomicWriteOwnedFile(
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
    await atomicWriteOwnedFile(
      this.visualPath,
      `${JSON.stringify({ schemaVersion: 1, ...settings }, null, 2)}\n`,
    );
  }

  async hasRecordingConsent(): Promise<boolean> {
    const stored = (await readJSON(this.recordingConsentPath)) as
      | { schemaVersion?: unknown; granted?: unknown }
      | undefined;
    return stored?.schemaVersion === 1 && stored.granted === true;
  }

  async grantRecordingConsent(date = new Date()): Promise<void> {
    await atomicWriteOwnedFile(
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
