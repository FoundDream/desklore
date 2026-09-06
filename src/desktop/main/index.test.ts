import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  let resolveConnection: (() => void) | undefined;
  const connection = new Promise<void>((resolve) => {
    resolveConnection = resolve;
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const snapshot = {
    locale: "en" as const,
    connectionState: "stopped" as const,
    recordingConsentGranted: true,
    observationPolicy: {
      defaultApplicationMode: "allow" as const,
      blockedBundleIdentifiers: [],
      blockedDomains: [],
    },
  };

  return {
    connection,
    resolveConnection: () => resolveConnection?.(),
    handlers,
    historyHandlers: new Map<string, (...args: unknown[]) => void>(),
    snapshot,
    windows: [] as Array<{
      webContents: {
        id: number;
        setWindowOpenHandler: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      };
      once: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      loadFile: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      hide: ReturnType<typeof vi.fn>;
    }>,
    registerHistoryIPC: vi.fn(),
    buildMenu: vi.fn(() => ({})),
  };
});

vi.mock("electron", () => {
  class BrowserWindow {
    webContents = {
      id: runtime.windows.length + 1,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    once = vi.fn();
    on = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    isDestroyed = vi.fn(() => false);
    show = vi.fn();
    focus = vi.fn();
    hide = vi.fn();

    constructor() {
      runtime.windows.push(this);
    }
  }

  class Tray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  }

  return {
    app: {
      isPackaged: false,
      dock: undefined,
      setName: vi.fn(),
      setPath: vi.fn(),
      getPath: vi.fn(() => "/tmp"),
      getAppPath: vi.fn(() => "/tmp/desklore"),
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn(async () => undefined),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        runtime.handlers.set(event, handler);
      }),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    BrowserWindow,
    Menu: { buildFromTemplate: runtime.buildMenu },
    nativeImage: {
      createFromBuffer: vi.fn(() => ({ setTemplateImage: vi.fn() })),
      createFromPath: vi.fn(() => ({ isEmpty: vi.fn(() => true) })),
    },
    Tray,
  };
});

vi.mock("./ipc/history-ipc.js", () => ({
  registerHistoryIPC: runtime.registerHistoryIPC,
}));

vi.mock("./platform/collector-paths.js", () => ({
  collectorExecutableCandidates: vi.fn(() => []),
}));

vi.mock("./platform/credential-store.js", () => ({
  ElectronCredentialStore: class {},
}));

vi.mock("./platform/desktop-shell.js", () => ({
  ElectronDesktopShell: class {},
}));

vi.mock("./server/server-core-client.js", () => ({
  ServerCoreProcessClient: class {
    connect = vi.fn(() => runtime.connection);
    current = vi.fn(() => runtime.snapshot);
    start = vi.fn(async () => runtime.snapshot);
    grantRecordingConsent = vi.fn(async () => runtime.snapshot);
    pause = vi.fn(async () => runtime.snapshot);
    resume = vi.fn(async () => runtime.snapshot);
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      runtime.historyHandlers.set(event, handler);
    });
    shutdown = vi.fn(async () => undefined);
    terminate = vi.fn();
  },
}));

describe("desktop startup", () => {
  beforeEach(() => {
    runtime.handlers.clear();
    runtime.windows.length = 0;
    runtime.registerHistoryIPC.mockClear();
  });

  it("ignores activation until history IPC is registered", async () => {
    await import("./index.js");
    await vi.waitFor(() => expect(runtime.handlers.has("activate")).toBe(true));

    runtime.handlers.get("activate")?.();
    expect(runtime.windows).toHaveLength(0);

    runtime.resolveConnection();
    await vi.waitFor(() => expect(runtime.windows).toHaveLength(1));
    expect(runtime.registerHistoryIPC).toHaveBeenCalledOnce();
    expect(runtime.registerHistoryIPC.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.windows[0]!.loadFile.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(() => expect(runtime.historyHandlers.has("snapshot")).toBe(true));
    const builds = runtime.buildMenu;
    const before = builds.mock.calls.length;
    const update = runtime.historyHandlers.get("snapshot")!;
    update({ ...runtime.snapshot, history: { recorderState: "paused", documents: [] } });
    expect(builds).toHaveBeenCalledTimes(before);
    update({
      ...runtime.snapshot,
      connectionState: "connected",
      history: { recorderState: "running" },
    });
    expect(builds).toHaveBeenCalledTimes(before + 1);
    update({
      ...runtime.snapshot,
      connectionState: "connected",
      history: { recorderState: "running", health: { capturedEventCount: 5 } },
    });
    expect(builds).toHaveBeenCalledTimes(before + 1);
    update({
      ...runtime.snapshot,
      locale: "zh-CN",
      connectionState: "connected",
      history: { recorderState: "running" },
    });
    expect(builds).toHaveBeenCalledTimes(before + 2);
  });
});
