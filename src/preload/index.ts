import { contextBridge, ipcRenderer } from "electron";
import type {
  ComputerHistoryAPI,
  DesktopSnapshot,
  LLMConfigurationInput,
} from "../shared/contracts.js";

const invoke = (channel: string): Promise<DesktopSnapshot> => ipcRenderer.invoke(channel);

const api: ComputerHistoryAPI = {
  getSnapshot: () => invoke("history:get-snapshot"),
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
  configureLLM: (input: LLMConfigurationInput) =>
    ipcRenderer.invoke("history:configure-llm", input),
  removeLLMAPIKey: () => invoke("history:remove-llm-key"),
  openDocument: (id: string) => ipcRenderer.invoke("history:open-document", id),
  deleteDocument: (id: string) => ipcRenderer.invoke("history:delete-document", id),
  revealStorage: () => invoke("history:reveal-storage"),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on("history:snapshot", handler);
    return () => ipcRenderer.removeListener("history:snapshot", handler);
  },
};

contextBridge.exposeInMainWorld("computerHistory", api);
