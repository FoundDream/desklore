import type { AppLocale } from "../../../shared/i18n/index.js";
import type { CredentialStore } from "../../core/ports.js";

export class EphemeralCredentialStore implements CredentialStore {
  constructor(private apiKey?: string) {}

  async has(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async load(): Promise<string | undefined> {
    return this.apiKey;
  }

  async save(apiKey: string, _locale: AppLocale): Promise<void> {
    this.apiKey = apiKey;
  }

  async remove(): Promise<void> {
    this.apiKey = undefined;
  }
}
