import type { AppLocale } from "../../shared/i18n/index.js";

export interface ApiKeyStore {
  has(): Promise<boolean>;
  load(): Promise<string | undefined>;
  save(apiKey: string, locale: AppLocale): Promise<void>;
  remove(): Promise<void>;
}

export interface DesktopShell {
  openPath(filePath: string): Promise<string>;
}
