import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import type { DesktopSnapshot } from "../../shared/contracts/index.js";
import { translate } from "../../shared/i18n/index.js";
import { collectorExecutableCandidates } from "./platform/collector-paths.js";
import { ElectronCredentialStore } from "./platform/credential-store.js";
import { ElectronDesktopShell } from "./platform/desktop-shell.js";
import { registerHistoryIPC } from "./ipc/history-ipc.js";
import { ServerCoreProcessClient } from "./server/server-core-client.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let desktopReady = false;

app.setName("DeskLore");
app.setPath("userData", path.join(app.getPath("appData"), "DeskLore"));

const projectRoot = process.cwd();
const historyRoot = path.join(app.getPath("userData"), "history");
const history = new ServerCoreProcessClient({
  storageRoot: historyRoot,
  collectorExecutableCandidates: collectorExecutableCandidates(
    app.getAppPath(),
    process.resourcesPath,
    projectRoot,
  ),
  hostBundleIdentifier: app.isPackaged ? "com.desklore.desktop" : "com.github.Electron",
  credentials: new ElectronCredentialStore(historyRoot),
  desktopShell: new ElectronDesktopShell(),
});

function showWindow(): void {
  if (!desktopReady) return;
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

function setDevelopmentDockIcon(): void {
  const dock = app.dock;
  if (process.platform !== "darwin" || app.isPackaged || !dock) return;

  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), "resources/branding/icon.png"),
  );
  if (!icon.isEmpty()) dock.setIcon(icon);
}

function rebuildTray(snapshot: DesktopSnapshot): void {
  if (!tray) return;
  const running = snapshot.history?.recorderState === "running";
  const t = (key: Parameters<typeof translate>[1]): string => translate(snapshot.locale, key);
  tray.setToolTip(running ? t("tray.recording") : "DeskLore");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.openTimeline"), click: showWindow },
      { type: "separator" },
      !snapshot.recordingConsentGranted
        ? { label: t("tray.allowAndStart"), click: () => void history.grantRecordingConsent() }
        : snapshot.connectionState !== "connected"
          ? { label: t("tray.startCollector"), click: () => void history.start() }
          : running
            ? { label: t("tray.pause"), click: () => void history.pause() }
            : { label: t("tray.resume"), click: () => void history.resume() },
      { type: "separator" },
      {
        label: t("tray.quit"),
        click: () => app.quit(),
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

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  console.error("[desklore] Another desktop instance already owns the single-instance lock.");
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void app
    .whenReady()
    .then(async () => {
      setDevelopmentDockIcon();
      await history.connect();
      registerHistoryIPC({ core: history, getTrustedWindow: () => mainWindow });
      await createWindow();
      desktopReady = true;
      tray = new Tray(trayIcon());
      tray.on("click", showWindow);
      rebuildTray(history.current());
      history.on("snapshot", (snapshot: DesktopSnapshot) => {
        rebuildTray(snapshot);
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send("history:snapshot", snapshot);
        }
      });
      const initialSnapshot = await history.start();
      rebuildTray(initialSnapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("history:snapshot", initialSnapshot);
      }
    })
    .catch((error: unknown) => {
      console.error("[desklore] Failed to start the desktop app:", error);
      app.exit(1);
    });
}

app.on("activate", showWindow);
let shutdownStarted = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("History shutdown timed out")), 8_000);
  });
  void Promise.race([history.shutdown(), deadline])
    .catch((error: unknown) => console.error("[desklore] Graceful shutdown failed:", error))
    .finally(() => {
      if (timeout) clearTimeout(timeout);
      history.terminate();
      app.quit();
    });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
