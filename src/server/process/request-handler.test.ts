import { describe, expect, it, vi } from "vitest";
import type { ServerCore } from "../server-core.js";
import { dispatchServerCoreRequest } from "./request-handler.js";

describe("ServerCore process request handler", () => {
  it("dispatches commands and arguments to the core", async () => {
    const setLocale = vi.fn(async () => ({ locale: "zh-CN" }));
    const core = {
      setLocale,
      storagePath: vi.fn(() => "/tmp/desklore/timeline"),
    } as unknown as ServerCore;

    await expect(
      dispatchServerCoreRequest(core, {
        type: "request",
        id: "locale",
        method: "setLocale",
        parameters: ["zh-CN"],
      }),
    ).resolves.toEqual({ locale: "zh-CN" });
    expect(setLocale).toHaveBeenCalledWith("zh-CN");

    await expect(
      dispatchServerCoreRequest(core, {
        type: "request",
        id: "storage",
        method: "storagePath",
        parameters: [],
      }),
    ).resolves.toBe("/tmp/desklore/timeline");
  });
});
