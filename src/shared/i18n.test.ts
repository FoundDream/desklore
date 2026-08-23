import { describe, expect, it } from "vitest";
import { isAppLocale, translate } from "./i18n.js";

describe("app internationalization", () => {
  it("uses English as the default-facing copy and supports Simplified Chinese", () => {
    expect(translate("en", "sidebar.timeline")).toBe("Timeline");
    expect(translate("zh-CN", "sidebar.timeline")).toBe("时间线");
    expect(translate("en", "memory.periodCount", { count: 3 })).toBe("3 periods");
    expect(translate("zh-CN", "memory.periodCount", { count: 3 })).toBe("3 段");
  });

  it("accepts only supported persisted locales", () => {
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("zh-CN")).toBe(true);
    expect(isAppLocale("zh-TW")).toBe(false);
  });
});
