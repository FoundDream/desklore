const translations = {
  en: {
    "meta.title": "DeskLore - Your computer's memory",
    "meta.description":
      "DeskLore is open-source personal context infrastructure for macOS: a memory of your work that stays local, cites its evidence, and can be used by the agents you trust.",
    "language.label": "Language",
    "nav.home": "Back to the DeskLore home page",
    "nav.primary": "Primary navigation",
    "nav.skip": "Skip to content",
    "nav.menu": "Menu",
    "nav.timeline": "Timeline",
    "nav.privacy": "Privacy",
    "nav.openSource": "Open source",
    "common.viewSource": "View source",
    "hero.title": "Your Mac, with a memory.",
    "hero.lead": "A clear timeline of your work. Kept on your Mac, with the evidence behind it.",
    "hero.howItWorks": "See how it works",
    "hero.privacy": "Privacy and local storage",
    "manifesto.iconAlt": "DeskLore app icon",
    "manifesto.title": "Your day moves between apps.",
    "manifesto.emphasis": "Keep the thread.",
    "manifesto.body":
      "DeskLore connects those moments into a readable history, so you can return to what mattered.",
    "scenes.label": "Moments in a workday",
    "scenes.researchAlt": "Research papers and a notebook on a sunlit desk",
    "scenes.researchTitle": "Find that reference again.",
    "scenes.researchBody": "Return to the pages and ideas you were exploring.",
    "scenes.createAlt": "A designer's sketchbook, paper swatches, and ceramic prototype",
    "scenes.createTitle": "Come back to an idea.",
    "scenes.createBody": "Revisit the work that led to your next decision.",
    "scenes.reflectAlt": "A notebook and closed laptop in soft afternoon light",
    "scenes.reflectTitle": "See where the day went.",
    "scenes.reflectBody": "Look back on a clear timeline of your work.",
    "history.title": "Pick up where you left off.",
    "history.body":
      "Revisit the pages you read and the work you were doing. Find your place and carry on.",
    "history.imageAlt": "DeskLore timeline showing the day's activity by time",
    "history.conceptAlt":
      "Concept illustration of paper and glass sheets connected into an ordered archive",
    "privacy.conceptAlt": "Concept illustration of paper folders kept in a frosted glass tray",
    "privacy.title": "At home on your Mac.",
    "privacy.body":
      "Your work history is stored locally by default. View it, revisit it, or delete it whenever you choose.",
    "privacy.readPolicy": "Read the full privacy policy",
    "openSource.label": "Open source",
    "openSource.title": "Your history should stay under your control.",
    "openSource.body":
      "DeskLore runs locally and is open source under Apache-2.0. You can inspect how it captures, filters, stores, and deletes data.",
    "footer.tagline": "Open-source personal context infrastructure for macOS.",
    "footer.guide": "Guide",
    "footer.guideHref": "https://github.com/FoundDream/desklore/blob/main/README.md",
    "footer.privacy": "Privacy",
  },
  "zh-CN": {
    "meta.title": "DeskLore - 你的电脑记忆",
    "meta.description":
      "DeskLore 是开源的个人上下文基础设施：你的电脑记忆，归你所有，每句话都有证据，供你信任的 agent 使用。",
    "language.label": "语言",
    "nav.home": "返回 DeskLore 首页",
    "nav.primary": "主要导航",
    "nav.skip": "跳转到正文",
    "nav.menu": "菜单",
    "nav.timeline": "时间线",
    "nav.privacy": "隐私设计",
    "nav.openSource": "开源",
    "common.viewSource": "查看源码",
    "hero.title": "你的 Mac，也有了记忆。",
    "hero.lead": "把每天的工作，串成清楚的时间线。存在本机，有据可查，归你所有。",
    "hero.howItWorks": "看看它如何工作",
    "hero.privacy": "隐私与本地保存",
    "manifesto.iconAlt": "DeskLore 应用图标",
    "manifesto.title": "一天切换了很多应用，",
    "manifesto.emphasis": "思路依然连在一起。",
    "manifesto.body": "DeskLore 把散落的工作片段整理成可回看的历史，让你重新找到当时的上下文。",
    "scenes.label": "工作中的日常片段",
    "scenes.researchAlt": "研究场景：阳光下的资料、笔记本和正在写字的手",
    "scenes.researchTitle": "找回那条研究线索。",
    "scenes.researchBody": "重新找到看过的页面，接着梳理当时的思路。",
    "scenes.createAlt": "创作场景：设计草图、纸张色样和陶瓷模型",
    "scenes.createTitle": "接着上次的灵感。",
    "scenes.createBody": "回看做过的工作，让下一次决定有迹可循。",
    "scenes.reflectAlt": "回顾场景：午后柔光中的笔记本与合上的电脑",
    "scenes.reflectTitle": "看看一天走到了哪里。",
    "scenes.reflectBody": "沿着清楚的时间线，回顾今天做过的事。",
    "history.title": "再回来时，接得上思路。",
    "history.body": "回看读过的页面、做过的工作，找到上次停下的地方，接着往前。",
    "history.imageAlt": "DeskLore 时间线界面，按时间展示当天完成的工作",
    "history.conceptAlt": "记忆概念图：纸张与玻璃片被细线串成有序的档案",
    "privacy.conceptAlt": "本地保存概念图：磨砂玻璃托盘中整齐存放的纸质文件夹",
    "privacy.title": "工作记忆，留在本机。",
    "privacy.body": "工作记录默认保存在本机。你可以随时回看，也可以删除自己的历史。",
    "privacy.readPolicy": "阅读完整隐私说明",
    "openSource.label": "开源",
    "openSource.title": "你的历史，应该由你掌握。",
    "openSource.body":
      "DeskLore 在本地运行，使用 Apache-2.0 许可证开源。你可以检查它如何采集、过滤、保存与删除。",
    "footer.tagline": "开源的 macOS 个人上下文基础设施。",
    "footer.guide": "使用说明",
    "footer.guideHref": "https://github.com/FoundDream/desklore/blob/main/README.zh-CN.md",
    "footer.privacy": "隐私",
  },
};

const supportedLocales = new Set(Object.keys(translations));
const requestedLocale = new URLSearchParams(window.location.search).get("lang");
let storedLocale;
try {
  storedLocale = window.localStorage.getItem("desklore.locale");
} catch {
  storedLocale = null;
}
const initialLocale = supportedLocales.has(requestedLocale)
  ? requestedLocale
  : supportedLocales.has(storedLocale)
    ? storedLocale
    : "en";

function applyLocale(locale) {
  const messages = translations[locale] ?? translations.en;
  document.documentElement.lang = locale;
  document.title = messages["meta.title"];
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", messages["meta.description"]);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = messages[element.dataset.i18n];
    if (value) element.textContent = value;
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    const value = messages[element.dataset.i18nAlt];
    if (value) element.setAttribute("alt", value);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    const value = messages[element.dataset.i18nAriaLabel];
    if (value) element.setAttribute("aria-label", value);
  });
  document.querySelectorAll("[data-i18n-href]").forEach((element) => {
    const value = messages[element.dataset.i18nHref];
    if (value) element.setAttribute("href", value);
  });
  document.querySelector(".language-switcher").value = locale;
}

const languageSwitcher = document.querySelector(".language-switcher");
languageSwitcher?.addEventListener("change", (event) => {
  const locale = event.target.value;
  if (!supportedLocales.has(locale)) return;
  try {
    window.localStorage.setItem("desklore.locale", locale);
  } catch {
    // Language switching still works when storage is unavailable.
  }
  applyLocale(locale);
});
applyLocale(initialLocale);

const siteHeader = document.querySelector(".site-header");
const headerSentinel = document.querySelector(".header-sentinel");

if (siteHeader && headerSentinel && "IntersectionObserver" in window) {
  siteHeader.dataset.headerState =
    headerSentinel.getBoundingClientRect().bottom > 0 ? "expanded" : "compact";
  const headerObserver = new IntersectionObserver(([entry]) => {
    siteHeader.dataset.headerState = entry.isIntersecting ? "expanded" : "compact";
  });
  headerObserver.observe(headerSentinel);
}

const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");

function closeNavigation() {
  navToggle?.setAttribute("aria-expanded", "false");
  siteNav?.classList.remove("is-open");
  siteHeader?.classList.remove("is-menu-open");
}

navToggle?.addEventListener("click", () => {
  const open = navToggle.getAttribute("aria-expanded") !== "true";
  navToggle.setAttribute("aria-expanded", String(open));
  siteNav?.classList.toggle("is-open", open);
  siteHeader?.classList.toggle("is-menu-open", open);
});
siteHeader?.addEventListener("click", (event) => {
  if (event.target.closest("a")) closeNavigation();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navToggle?.getAttribute("aria-expanded") === "true") {
    closeNavigation();
    navToggle.focus();
  }
});

const requestedTheme = new URLSearchParams(window.location.search).get("theme");

if (requestedTheme === "dark" || requestedTheme === "light") {
  document.documentElement.dataset.theme = requestedTheme;
}

document.documentElement.classList.add("js");

const reveals = document.querySelectorAll(".reveal");

if (!("IntersectionObserver" in window)) {
  reveals.forEach((element) => element.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      rootMargin: "0px 0px -10%",
      threshold: 0.14,
    },
  );

  reveals.forEach((element) => observer.observe(element));
}
