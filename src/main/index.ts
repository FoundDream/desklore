import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import type { DesktopSnapshot, LLMConfigurationInput } from "../shared/contracts.js";
import { AgentClient, agentExecutableCandidates } from "./agent-client.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

const projectRoot = process.cwd();
const agent = new AgentClient(
  agentExecutableCandidates(app.getAppPath(), process.resourcesPath, projectRoot),
);

function assertRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error("Rejected IPC call from an untrusted renderer");
  }
}

function documentID(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("Invalid timeline document ID");
  }
  return value;
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function trayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5" fill="none" stroke="black" stroke-width="1.5"/><path d="M9 5.2v4.1l2.8 1.7" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const image = nativeImage.createFromBuffer(Buffer.from(svg));
  image.setTemplateImage(true);
  return image;
}

function rebuildTray(snapshot: DesktopSnapshot): void {
  if (!tray) return;
  const running = snapshot.agent?.recorderState === "running";
  tray.setToolTip(running ? "Computer History · 正在记录" : "Computer History");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开时间线", click: showWindow },
      { type: "separator" },
      snapshot.connectionState !== "connected"
        ? { label: "启动采集器", click: () => void agent.start() }
        : running
          ? { label: "暂停记录", click: () => void agent.request("pause") }
          : { label: "继续记录", click: () => void agent.request("resume") },
      { type: "separator" },
      {
        label: "退出 Computer History",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#fafafa",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

function registerIPC(): void {
  ipcMain.handle("history:get-snapshot", (event) => {
    assertRenderer(event);
    return agent.current();
  });
  ipcMain.handle("history:start-agent", async (event) => {
    assertRenderer(event);
    return agent.start();
  });
  ipcMain.handle("history:stop-agent", async (event) => {
    assertRenderer(event);
    return agent.stop();
  });

  const command = (channel: string, name: string): void => {
    ipcMain.handle(channel, async (event) => {
      assertRenderer(event);
      return agent.request(name);
    });
  };
  command("history:pause", "pause");
  command("history:resume", "resume");
  command("history:refresh-permissions", "refreshPermissions");
  command("history:request-permissions", "requestPermissions");
  command("history:allow-active-application", "allowActiveApplication");
  command("history:block-active-application", "blockActiveApplication");
  command("history:allow-active-domain", "allowActiveDomain");
  command("history:block-active-domain", "blockActiveDomain");
  command("history:remove-llm-key", "removeLLMAPIKey");
  command("history:reveal-storage", "revealStorage");

  ipcMain.handle("history:configure-llm", async (event, input: LLMConfigurationInput) => {
    assertRenderer(event);
    if (
      !input ||
      typeof input.enabled !== "boolean" ||
      typeof input.model !== "string" ||
      input.model.length > 200 ||
      typeof input.endpoint !== "string" ||
      input.endpoint.length > 2_000 ||
      typeof input.apiKey !== "string" ||
      input.apiKey.length > 8_000
    ) {
      throw new Error("Invalid LLM configuration");
    }
    return agent.request("configureLLM", input as unknown as Record<string, unknown>);
  });
  ipcMain.handle("history:open-document", async (event, id: unknown) => {
    assertRenderer(event);
    return agent.request("openDocument", { documentID: documentID(id) });
  });
  ipcMain.handle("history:delete-document", async (event, id: unknown) => {
    assertRenderer(event);
    return agent.request("deleteDocument", { documentID: documentID(id) });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void app.whenReady().then(async () => {
    registerIPC();
    await createWindow();
    tray = new Tray(trayIcon());
    tray.on("click", showWindow);
    rebuildTray(agent.current());
    agent.on("snapshot", (snapshot: DesktopSnapshot) => {
      rebuildTray(snapshot);
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send("history:snapshot", snapshot);
      }
    });
    await agent.start();
  });
}

app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  agent.terminate();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
