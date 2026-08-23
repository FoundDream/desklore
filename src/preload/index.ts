import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerHistoryAPI,
  DesktopSnapshot,
  LLMConfigurationInput,
  VisualConfigurationInput,
} from "../shared/contracts.js";
import type { AppLocale } from "../shared/i18n.js";

const invoke = (channel: string): Promise<DesktopSnapshot> => ipcRenderer.invoke(channel);

const api: ComputerHistoryAPI = {
  getSnapshot: () => invoke("history:get-snapshot"),
  listInstalledApplications: () => ipcRenderer.invoke("history:list-installed-applications"),
  setLocale: (locale: AppLocale) => ipcRenderer.invoke("history:set-locale", locale),
  grantRecordingConsent: () => invoke("history:grant-recording-consent"),
  startAgent: () => invoke("history:start-agent"),
  stopAgent: () => invoke("history:stop-agent"),
  pause: () => invoke("history:pause"),
  resume: () => invoke("history:resume"),
  refreshPermissions: () => invoke("history:refresh-permissions"),
  requestPermissions: () => invoke("history:request-permissions"),
  allowActiveApplication: () => invoke("history:allow-active-application"),
  blockActiveApplication: () => invoke("history:block-active-application"),
  allowActiveDomain: () => invoke("history:allow-active-domain"),
  blockActiveDomain: () => invoke("history:block-active-domain"),
  updateObservationPolicy: (input) =>
    ipcRenderer.invoke("history:update-observation-policy", input),
  configureLLM: (input: LLMConfigurationInput) =>
    ipcRenderer.invoke("history:configure-llm", input),
  setLLMEnabled: (enabled: boolean) => ipcRenderer.invoke("history:set-llm-enabled", enabled),
  setMemorySynthesisEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("history:set-memory-synthesis-enabled", enabled),
  configureVisual: (input: VisualConfigurationInput) =>
    ipcRenderer.invoke("history:configure-visual", input),
  requestScreenCapturePermission: () => invoke("history:request-screen-capture-permission"),
  removeLLMAPIKey: () => invoke("history:remove-llm-key"),
  openDocument: (id: string) => ipcRenderer.invoke("history:open-document", id),
  deleteDocument: (id: string) => ipcRenderer.invoke("history:delete-document", id),
  clearHistory: () => invoke("history:clear"),
  restoreHistory: (id: string) => ipcRenderer.invoke("history:restore", id),
  revealStorage: () => invoke("history:reveal-storage"),
  getApplicationIcon: (iconPath: string) =>
    ipcRenderer.invoke("history:get-application-icon", iconPath),
  searchMemory: (query: string) => ipcRenderer.invoke("history:search-memory", query),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on("history:snapshot", handler);
    return () => ipcRenderer.removeListener("history:snapshot", handler);
  },
};

contextBridge.exposeInMainWorld("computerHistory", api);
