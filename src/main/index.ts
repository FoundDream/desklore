import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopSnapshot, LLMConfigurationInput } from "../shared/contracts.js";
import { AgentClient, agentExecutableCandidates } from "./agent-client.js";
import { HistoryService } from "./history/service.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

const projectRoot = process.cwd();
const collector = new AgentClient(
  agentExecutableCandidates(app.getAppPath(), process.resourcesPath, projectRoot),
  app.isPackaged ? "com.ziwen.computer-history.desktop" : "com.github.Electron",
);
const history = new HistoryService(
  collector,
  path.join(app.getPath("appData"), "ComputerHistoryDesktop"),
);
const applicationIconCache = new Map<string, Promise<string | undefined>>();
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const preferredICNSImageTypes = [
  "icp6",
  "ic12",
  "ic07",
  "ic13",
  "ic08",
  "ic09",
  "ic10",
  "icp5",
  "ic11",
  "icp4",
];

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

async function readICNSIconDataURL(iconPath: string): Promise<string | undefined> {
  const data = await readFile(iconPath);
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "icns") return undefined;

  const images = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) break;
    const payload = data.subarray(offset + 8, offset + length);
    const signatureOffset = payload.indexOf(pngSignature);
    if (signatureOffset >= 0) images.set(type, payload.subarray(signatureOffset));
    offset += length;
  }

  const image = preferredICNSImageTypes
    .map((type) => images.get(type))
    .find((candidate) => candidate !== undefined);
  return image ? `data:image/png;base64,${image.toString("base64")}` : undefined;
}

function applicationIconDataURL(iconPath: string): Promise<string | undefined> {
  const cached = applicationIconCache.get(iconPath);
  if (cached) return cached;

  const request = readICNSIconDataURL(iconPath).catch(() => undefined);
  applicationIconCache.set(iconPath, request);
  return request;
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
        ? { label: "启动采集器", click: () => void history.start() }
        : running
          ? { label: "暂停记录", click: () => void history.pause() }
          : { label: "继续记录", click: () => void history.resume() },
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
    return history.current();
  });
  ipcMain.handle("history:get-application-icon", (event, value: unknown) => {
    assertRenderer(event);
    return applicationIconDataURL(validatedApplicationIconPath(value));
  });
  ipcMain.handle("history:search-memory", (event, value: unknown) => {
    assertRenderer(event);
    return history.searchMemory(historyQuery(value));
  });
  ipcMain.handle("history:start-agent", async (event) => {
    assertRenderer(event);
    return history.start();
  });
  ipcMain.handle("history:stop-agent", async (event) => {
    assertRenderer(event);
    return history.stop();
  });
  ipcMain.handle("history:pause", async (event) => {
    assertRenderer(event);
    return history.pause();
  });
  ipcMain.handle("history:resume", async (event) => {
    assertRenderer(event);
    return history.resume();
  });
  ipcMain.handle("history:refresh-permissions", async (event) => {
    assertRenderer(event);
    return history.requestNative("refreshPermissions");
  });
  ipcMain.handle("history:request-permissions", async (event) => {
    assertRenderer(event);
    return history.requestNative("requestPermissions");
  });
  ipcMain.handle("history:allow-active-application", async (event) => {
    assertRenderer(event);
    return history.setActiveApplicationAllowed(true);
  });
  ipcMain.handle("history:block-active-application", async (event) => {
    assertRenderer(event);
    return history.setActiveApplicationAllowed(false);
  });
  ipcMain.handle("history:allow-active-domain", async (event) => {
    assertRenderer(event);
    return history.setActiveDomainAllowed(true);
  });
  ipcMain.handle("history:block-active-domain", async (event) => {
    assertRenderer(event);
    return history.setActiveDomainAllowed(false);
  });
  ipcMain.handle("history:remove-llm-key", async (event) => {
    assertRenderer(event);
    return history.removeLLMAPIKey();
  });
  ipcMain.handle("history:set-memory-synthesis-enabled", async (event, enabled: unknown) => {
    assertRenderer(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid memory synthesis setting");
    return history.setMemorySynthesisEnabled(enabled);
  });
  ipcMain.handle("history:reveal-storage", async (event) => {
    assertRenderer(event);
    return history.revealStorage();
  });

  ipcMain.handle("history:configure-llm", async (event, input: LLMConfigurationInput) => {
    assertRenderer(event);
    if (
      !input ||
      typeof input.enabled !== "boolean" ||
      typeof input.memorySynthesisEnabled !== "boolean" ||
      typeof input.model !== "string" ||
      input.model.length > 200 ||
      typeof input.endpoint !== "string" ||
      input.endpoint.length > 2_000 ||
      typeof input.apiKey !== "string" ||
      input.apiKey.length > 8_000
    ) {
      throw new Error("Invalid LLM configuration");
    }
    return history.configureLLM(input);
  });
  ipcMain.handle("history:open-document", async (event, id: unknown) => {
    assertRenderer(event);
    return history.openDocument(documentID(id));
  });
  ipcMain.handle("history:delete-document", async (event, id: unknown) => {
    assertRenderer(event);
    return history.deleteDocument(documentID(id));
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  console.error(
    "[computer-history] Another desktop instance already owns the single-instance lock.",
  );
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void app
    .whenReady()
    .then(async () => {
      registerIPC();
      await createWindow();
      tray = new Tray(trayIcon());
      tray.on("click", showWindow);
      rebuildTray(history.current());
      history.on("snapshot", (snapshot: DesktopSnapshot) => {
        rebuildTray(snapshot);
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send("history:snapshot", snapshot);
        }
      });
      await history.start();
    })
    .catch((error: unknown) => {
      console.error("[computer-history] Failed to start the desktop app:", error);
      app.exit(1);
    });
}

app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  history.terminate();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
