import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type {
  InstalledApplication,
  LLMConfigurationInput,
  ObservationPolicy,
  VisualConfigurationInput,
} from "../shared/contracts.js";
import type { AppLocale } from "../shared/i18n.js";
import { isAppLocale } from "../shared/i18n.js";
import { discoverInstalledApplications, readICNSIconDataURL } from "./applications.js";
import type { ServerCoreProcessClient } from "./server-core-process-client.js";

export interface HistoryIPCServerOptions {
  core: ServerCoreProcessClient;
  getTrustedWindow: () => BrowserWindow | undefined;
}

function documentID(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("Invalid timeline document ID");
  }
  return value;
}

function historyArchiveID(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    path.basename(value) !== value ||
    !/^[a-zA-Z0-9-]+$/.test(value)
  ) {
    throw new Error("Invalid history archive ID");
  }
  return value;
}

function historyQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new Error("Invalid history query");
  }
  return value.trim();
}

function validatedApplicationIconPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error("Invalid application icon path");
  }
  const normalized = path.normalize(value);
  const resourcesSegment = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  if (
    !path.isAbsolute(normalized) ||
    path.extname(normalized).toLowerCase() !== ".icns" ||
    !normalized.includes(resourcesSegment)
  ) {
    throw new Error("Invalid application icon path");
  }
  return normalized;
}

export function registerHistoryIPC({ core, getTrustedWindow }: HistoryIPCServerOptions): void {
  const applicationIconCache = new Map<string, Promise<string | undefined>>();

  const assertRenderer = (event: IpcMainInvokeEvent): void => {
    const trustedWindow = getTrustedWindow();
    if (!trustedWindow || event.sender.id !== trustedWindow.webContents.id) {
      throw new Error("Rejected IPC call from an untrusted renderer");
    }
  };

  const applicationIconDataURL = (iconPath: string): Promise<string | undefined> => {
    const cached = applicationIconCache.get(iconPath);
    if (cached) return cached;
    const request = readICNSIconDataURL(iconPath).catch(() => undefined);
    applicationIconCache.set(iconPath, request);
    return request;
  };

  const installedApplications = async (): Promise<InstalledApplication[]> => {
    const applications = await discoverInstalledApplications();
    return Promise.all(
      applications.map(async (application) => ({
        bundleIdentifier: application.bundleIdentifier,
        name: application.name,
        iconDataURL: application.iconPath
          ? await applicationIconDataURL(application.iconPath)
          : undefined,
      })),
    );
  };

  ipcMain.handle("history:get-snapshot", (event) => {
    assertRenderer(event);
    return core.current();
  });
  ipcMain.handle("history:list-installed-applications", async (event) => {
    assertRenderer(event);
    return installedApplications();
  });
  ipcMain.handle("history:set-locale", async (event, locale: AppLocale) => {
    assertRenderer(event);
    if (!isAppLocale(locale)) throw new Error("Invalid interface language");
    return core.setLocale(locale);
  });
  ipcMain.handle("history:grant-recording-consent", async (event) => {
    assertRenderer(event);
    return core.grantRecordingConsent();
  });
  ipcMain.handle("history:get-application-icon", (event, value: unknown) => {
    assertRenderer(event);
    return applicationIconDataURL(validatedApplicationIconPath(value));
  });
  ipcMain.handle("history:search-memory", (event, value: unknown) => {
    assertRenderer(event);
    return core.searchMemory(historyQuery(value));
  });
  ipcMain.handle("history:start-collector", async (event) => {
    assertRenderer(event);
    return core.start();
  });
  ipcMain.handle("history:stop-collector", async (event) => {
    assertRenderer(event);
    return core.stop();
  });
  ipcMain.handle("history:pause", async (event) => {
    assertRenderer(event);
    return core.pause();
  });
  ipcMain.handle("history:resume", async (event) => {
    assertRenderer(event);
    return core.resume();
  });
  ipcMain.handle("history:refresh-permissions", async (event) => {
    assertRenderer(event);
    return core.requestNative("refreshPermissions");
  });
  ipcMain.handle("history:request-permissions", async (event) => {
    assertRenderer(event);
    return core.requestNative("requestPermissions");
  });
  ipcMain.handle("history:allow-active-application", async (event) => {
    assertRenderer(event);
    return core.setActiveApplicationAllowed(true);
  });
  ipcMain.handle("history:block-active-application", async (event) => {
    assertRenderer(event);
    return core.setActiveApplicationAllowed(false);
  });
  ipcMain.handle("history:allow-active-domain", async (event) => {
    assertRenderer(event);
    return core.setActiveDomainAllowed(true);
  });
  ipcMain.handle("history:block-active-domain", async (event) => {
    assertRenderer(event);
    return core.setActiveDomainAllowed(false);
  });
  ipcMain.handle("history:update-observation-policy", async (event, input: ObservationPolicy) => {
    assertRenderer(event);
    return core.updateObservationPolicy(input);
  });
  ipcMain.handle("history:remove-llm-key", async (event) => {
    assertRenderer(event);
    return core.removeLLMAPIKey();
  });
  ipcMain.handle("history:set-llm-enabled", async (event, enabled: unknown) => {
    assertRenderer(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid model summary setting");
    return core.setLLMEnabled(enabled);
  });
  ipcMain.handle("history:set-memory-synthesis-enabled", async (event, enabled: unknown) => {
    assertRenderer(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid memory synthesis setting");
    return core.setMemorySynthesisEnabled(enabled);
  });
  ipcMain.handle("history:configure-visual", async (event, input: VisualConfigurationInput) => {
    assertRenderer(event);
    if (
      !input ||
      !["rules", "luna"].includes(input.axJudge) ||
      !["off", "fallback"].includes(input.captureMode) ||
      !["off", "ocr", "luna"].includes(input.understandingMode)
    ) {
      throw new Error("Invalid visual configuration");
    }
    return core.configureVisual(input);
  });
  ipcMain.handle("history:request-screen-capture-permission", async (event) => {
    assertRenderer(event);
    return core.requestScreenCapturePermission();
  });
  ipcMain.handle("history:reveal-storage", async (event) => {
    assertRenderer(event);
    return core.revealStorage();
  });
  ipcMain.handle("history:configure-llm", async (event, input: LLMConfigurationInput) => {
    assertRenderer(event);
    if (
      !input ||
      !["responses", "chat_completions"].includes(input.protocol) ||
      typeof input.model !== "string" ||
      input.model.length > 200 ||
      typeof input.endpoint !== "string" ||
      input.endpoint.length > 2_000 ||
      typeof input.apiKey !== "string" ||
      input.apiKey.length > 8_000
    ) {
      throw new Error("Invalid LLM configuration");
    }
    return core.configureLLM(input);
  });
  ipcMain.handle("history:open-document", async (event, id: unknown) => {
    assertRenderer(event);
    return core.openDocument(documentID(id));
  });
  ipcMain.handle("history:delete-document", async (event, id: unknown) => {
    assertRenderer(event);
    return core.deleteDocument(documentID(id));
  });
  ipcMain.handle("history:clear", async (event) => {
    assertRenderer(event);
    return core.clearHistory();
  });
  ipcMain.handle("history:restore", async (event, id: unknown) => {
    assertRenderer(event);
    return core.restoreHistory(historyArchiveID(id));
  });
}
