import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  DesktopSnapshot,
  InstalledApplication,
  ObservationPolicy,
} from "../../../../../shared/contracts/index.js";
import { defaultModelEndpoints, type ModelProtocol } from "../../../../../shared/model.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { useI18n } from "../../app/i18n.js";
import {
  applicationIsExcluded,
  InstalledApplicationIcon,
  SettingRow,
  SettingsDialog,
  SettingsSection,
  StatusPill,
} from "./components.js";

type SettingsTab = "general" | "ai" | "visual" | "privacy" | "data";
type SettingsNavigationGroup = "features" | "local";
type SettingsDialogName = "clear-history" | "discard-changes" | "remove-key";
type RunAction = (action: () => Promise<DesktopSnapshot>) => Promise<boolean>;

interface SettingsViewProps {
  desktop: DesktopSnapshot;
  run: RunAction;
  busy: boolean;
  error?: string;
  onDismissError: () => void;
  onBack: () => void;
  onOpenDiagnostics: () => void;
}

export function SettingsView({
  desktop,
  run,
  busy,
  error,
  onDismissError,
  onBack,
  onOpenDiagnostics,
}: SettingsViewProps) {
  const { locale, t } = useI18n();
  const history = desktop.history;
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [dialog, setDialog] = useState<SettingsDialogName>();
  const [feedback, setFeedback] = useState<string>();
  const [protocol, setProtocol] = useState<ModelProtocol>(history?.llm.protocol ?? "responses");
  const [model, setModel] = useState(history?.llm.model ?? "gpt-5.6-luna");
  const [endpoint, setEndpoint] = useState(
    history?.llm.endpoint ?? defaultModelEndpoints.responses,
  );
  const [apiKey, setAPIKey] = useState("");
  const [applicationExclusion, setApplicationExclusion] = useState("");
  const [installedApplications, setInstalledApplications] = useState<InstalledApplication[]>();
  const [installedApplicationsLoading, setInstalledApplicationsLoading] = useState(false);
  const [installedApplicationsError, setInstalledApplicationsError] = useState<string>();
  const [applicationSearch, setApplicationSearch] = useState("");
  const [domainExclusion, setDomainExclusion] = useState("");
  const [windowTitlePattern, setWindowTitlePattern] = useState("");
  const [windowTitleMatch, setWindowTitleMatch] = useState<"contains" | "exact">("contains");
  const [windowTitleApplication, setWindowTitleApplication] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      history?.llm.endpoint && history.llm.endpoint !== defaultModelEndpoints[history.llm.protocol],
    ),
  );
  const pendingExit = useRef<() => void>(onBack);

  useEffect(() => {
    if (!history) return;
    setProtocol(history.llm.protocol);
    setModel(history.llm.model);
    setEndpoint(history.llm.endpoint);
  }, [history?.llm.endpoint, history?.llm.model, history?.llm.protocol]);

  useEffect(() => {
    if (
      history?.llm.endpoint &&
      history.llm.endpoint !== defaultModelEndpoints[history.llm.protocol]
    ) {
      setAdvancedOpen(true);
    }
  }, [history?.llm.endpoint, history?.llm.protocol]);

  const loadInstalledApplications = useCallback(async (): Promise<void> => {
    setInstalledApplicationsLoading(true);
    setInstalledApplicationsError(undefined);
    try {
      setInstalledApplications(await window.desklore.listInstalledApplications());
    } catch (loadError) {
      setInstalledApplications([]);
      setInstalledApplicationsError(
        loadError instanceof Error ? loadError.message : "Unable to read installed applications",
      );
    } finally {
      setInstalledApplicationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "privacy" && installedApplications === undefined && !installedApplicationsLoading) {
      void loadInstalledApplications();
    }
  }, [installedApplications, installedApplicationsLoading, loadInstalledApplications, tab]);

  const pageTitles = {
    general: t("settings.tabGeneral"),
    ai: t("settings.tabAI"),
    visual: t("settings.tabVisual"),
    privacy: t("settings.tabPrivacy"),
    data: t("settings.tabData"),
  } satisfies Record<SettingsTab, string>;
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: IconName;
    group: SettingsNavigationGroup;
  }> = [
    { id: "general", label: t("settings.tabGeneral"), icon: "settings", group: "features" },
    { id: "ai", label: t("settings.tabAI"), icon: "sparkles", group: "features" },
    { id: "visual", label: t("settings.tabVisual"), icon: "eye", group: "features" },
    { id: "privacy", label: t("settings.tabPrivacy"), icon: "shield", group: "local" },
    { id: "data", label: t("settings.tabData"), icon: "database", group: "local" },
  ];
  const normalizedSettingsSearch = settingsSearch
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase(locale);
  const filteredTabs = tabs.filter((item) => {
    if (!normalizedSettingsSearch) return true;
    return item.label
      .normalize("NFKC")
      .toLocaleLowerCase(locale)
      .includes(normalizedSettingsSearch);
  });
  const navigationGroups: Array<{
    id: SettingsNavigationGroup;
    label: string;
  }> = [
    { id: "features", label: t("settings.navigationFeatures") },
    { id: "local", label: t("settings.navigationLocal") },
  ];
  const modelDirty =
    Boolean(history) &&
    (protocol !== history?.llm.protocol ||
      model !== history?.llm.model ||
      endpoint !== history?.llm.endpoint ||
      Boolean(apiKey.trim()));
  const requestExit = useCallback(
    (action: () => void = onBack): void => {
      if (!modelDirty) {
        action();
        return;
      }
      pendingExit.current = action;
      setDialog("discard-changes");
    },
    [modelDirty, onBack],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (dialog) setDialog(undefined);
      else requestExit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialog, requestExit]);

  const recording = history?.recorderState === "running";
  const collectorReady = desktop.connectionState === "connected" && Boolean(history);
  const captureStatus = !collectorReady
    ? "unavailable"
    : !history?.health.accessibilityGranted
      ? "permission"
      : !history.health.interactionMonitorActive
        ? "attention"
        : recording
          ? "ready"
          : "paused";
  const visualEnabled = history?.visual.captureMode === "fallback";
  const providerStatus = history?.visual.providerStatus;
  const providerLabel =
    providerStatus === "ready"
      ? t("common.ready")
      : providerStatus === "permission_required"
        ? t("settings.awaitingScreenRecording")
        : providerStatus === "unavailable"
          ? t("common.notInstalled")
          : providerStatus === "unhealthy"
            ? t("common.notReady")
            : t("common.disabled");
  const recovery = desktop.historyRecovery;
  const recoveryDate = recovery
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(recovery.deletedAt),
      )
    : "";

  const changeTab = (next: SettingsTab): void => {
    setTab(next);
    setFeedback(undefined);
  };

  const saveModel = async (): Promise<void> => {
    if (!history) return;
    setFeedback(undefined);
    const saved = await run(() =>
      window.desklore.configureLLM({
        protocol,
        model,
        endpoint,
        apiKey,
      }),
    );
    if (saved) {
      setAPIKey("");
      setFeedback(t("settings.saved"));
    }
  };

  const configureVisual = (next: {
    axJudge?: "rules" | "luna";
    captureMode?: "off" | "fallback";
    understandingMode?: "off" | "ocr" | "luna";
  }): void => {
    if (!history) return;
    void run(() =>
      window.desklore.configureVisual({
        axJudge: next.axJudge ?? history.visual.axJudge,
        captureMode: next.captureMode ?? history.visual.captureMode,
        understandingMode: next.understandingMode ?? history.visual.understandingMode,
      }),
    );
  };

  const updateObservationPolicy = async (
    update: (draft: ObservationPolicy) => void,
  ): Promise<boolean> => {
    const next = structuredClone(desktop.observationPolicy);
    update(next);
    return run(() => window.desklore.updateObservationPolicy(next));
  };

  const addApplicationExclusion = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const bundleIdentifier = applicationExclusion.trim();
    if (!bundleIdentifier) return;
    const saved = await updateObservationPolicy((draft) => {
      draft.allowedBundleIdentifiers = draft.allowedBundleIdentifiers.filter(
        (value) => value !== bundleIdentifier,
      );
      if (!draft.blockedBundleIdentifiers.includes(bundleIdentifier)) {
        draft.blockedBundleIdentifiers.push(bundleIdentifier);
      }
    });
    if (saved) setApplicationExclusion("");
  };

  const addDomainExclusion = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const domain = domainExclusion.trim();
    if (!domain) return;
    const saved = await updateObservationPolicy((draft) => {
      draft.allowedDomains = draft.allowedDomains.filter((value) => value !== domain);
      if (!draft.blockedDomains.includes(domain)) draft.blockedDomains.push(domain);
    });
    if (saved) setDomainExclusion("");
  };

  const addWindowTitleExclusion = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const pattern = windowTitlePattern.trim();
    const bundleIdentifier = windowTitleApplication.trim();
    if (pattern.length < 3) return;
    const saved = await updateObservationPolicy((draft) => {
      draft.blockedWindowTitles.push({
        id: crypto.randomUUID(),
        pattern,
        match: windowTitleMatch,
        bundleIdentifier: bundleIdentifier || undefined,
      });
    });
    if (saved) {
      setWindowTitlePattern("");
      setWindowTitleApplication("");
    }
  };

  const applicationPickerItems = useMemo(() => {
    const byBundleIdentifier = new Map(
      (installedApplications ?? []).map((application) => [
        application.bundleIdentifier,
        { ...application, installed: true },
      ]),
    );
    for (const bundleIdentifier of desktop.observationPolicy.blockedBundleIdentifiers) {
      if (!byBundleIdentifier.has(bundleIdentifier)) {
        byBundleIdentifier.set(bundleIdentifier, {
          bundleIdentifier,
          name: bundleIdentifier,
          installed: false,
        });
      }
    }
    const query = applicationSearch.normalize("NFKC").trim().toLowerCase();
    return [...byBundleIdentifier.values()]
      .filter(
        (application) =>
          !query ||
          application.name.normalize("NFKC").toLowerCase().includes(query) ||
          application.bundleIdentifier.toLowerCase().includes(query),
      )
      .sort(
        (lhs, rhs) =>
          lhs.name.localeCompare(rhs.name, locale, { sensitivity: "base" }) ||
          lhs.bundleIdentifier.localeCompare(rhs.bundleIdentifier),
      );
  }, [applicationSearch, desktop.observationPolicy, installedApplications, locale]);

  const excludedApplicationCount = useMemo(() => {
    const excluded = new Set(desktop.observationPolicy.blockedBundleIdentifiers);
    if (desktop.observationPolicy.defaultApplicationBehavior === "do_not_observe") {
      for (const application of installedApplications ?? []) {
        if (
          !desktop.observationPolicy.allowedBundleIdentifiers.includes(application.bundleIdentifier)
        ) {
          excluded.add(application.bundleIdentifier);
        }
      }
    }
    return excluded.size;
  }, [desktop.observationPolicy, installedApplications]);

  const setApplicationExcluded = (bundleIdentifier: string, excluded: boolean): Promise<boolean> =>
    updateObservationPolicy((draft) => {
      draft.allowedBundleIdentifiers = draft.allowedBundleIdentifiers.filter(
        (value) => value !== bundleIdentifier,
      );
      draft.blockedBundleIdentifiers = draft.blockedBundleIdentifiers.filter(
        (value) => value !== bundleIdentifier,
      );
      if (excluded) {
        draft.blockedBundleIdentifiers.push(bundleIdentifier);
      } else if (draft.defaultApplicationBehavior === "do_not_observe") {
        draft.allowedBundleIdentifiers.push(bundleIdentifier);
      }
    });

  return (
    <div className={`settings-shell ${busy ? "busy" : ""}`}>
      <aside className="settings-navigation">
        <div className="settings-window-drag" />
        <button className="settings-back" onClick={() => requestExit()}>
          <Icon name="arrow-left" />
          <span>{t("settings.backToDeskLore")}</span>
        </button>
        <label className="settings-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label={t("settings.searchPlaceholder")}
            placeholder={t("settings.searchPlaceholder")}
            value={settingsSearch}
            onChange={(event) => setSettingsSearch(event.target.value)}
          />
        </label>
        <nav aria-label={t("settings.title")}>
          {navigationGroups.map((group) => {
            const items = filteredTabs.filter((item) => item.group === group.id);
            if (items.length === 0) return null;
            return (
              <section className="settings-nav-group" key={group.id}>
                <span className="settings-nav-label">{group.label}</span>
                <div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      className={tab === item.id ? "active" : ""}
                      aria-current={tab === item.id ? "page" : undefined}
                      onClick={() => changeTab(item.id)}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {filteredTabs.length === 0 && (
            <span className="settings-nav-empty">{t("settings.noSearchResults")}</span>
          )}
        </nav>
        <span className="settings-shortcut">⌘,</span>
      </aside>

      <main className="settings-content">
        <div className="settings-content-inner">
          <header className="settings-page-header">
            <h1>{pageTitles[tab]}</h1>
          </header>

          {error && (
            <div className="settings-error" role="alert">
              <div>
                <strong>{t("common.actionFailed")}</strong>
                <span>{error}</span>
              </div>
              <button onClick={onDismissError}>{t("common.close")}</button>
            </div>
          )}

          {tab === "general" && (
            <>
              <SettingsSection title={t("settings.interface")}>
                <SettingRow title={t("settings.language")}>
                  <select
                    className="setting-select"
                    aria-label={t("settings.language")}
                    value={locale}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        window.desklore.setLocale(event.target.value as "en" | "zh-CN"),
                      )
                    }
                  >
                    <option value="en">{t("language.english")}</option>
                    <option value="zh-CN">{t("language.simplifiedChinese")}</option>
                  </select>
                </SettingRow>
              </SettingsSection>

              <SettingsSection title={t("settings.capture")}>
                <SettingRow title={t("settings.recording")}>
                  <StatusPill tone={recording ? "success" : "neutral"}>
                    {recording ? t("sidebar.recording") : t("sidebar.paused")}
                  </StatusPill>
                  <button
                    disabled={busy || !history}
                    onClick={() =>
                      void run(() =>
                        recording ? window.desklore.pause() : window.desklore.resume(),
                      )
                    }
                  >
                    {recording ? t("settings.pauseRecording") : t("settings.resumeRecording")}
                  </button>
                </SettingRow>
                <SettingRow title={t("settings.captureStatus")}>
                  <StatusPill
                    tone={
                      captureStatus === "ready"
                        ? "success"
                        : captureStatus === "paused"
                          ? "neutral"
                          : "warning"
                    }
                  >
                    {captureStatus === "ready"
                      ? t("common.ready")
                      : captureStatus === "paused"
                        ? t("sidebar.paused")
                        : t("common.notReady")}
                  </StatusPill>
                  {captureStatus === "unavailable" ? (
                    desktop.connectionState !== "starting" && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => window.desklore.startCollector())}
                      >
                        {t("connection.restart")}
                      </button>
                    )
                  ) : captureStatus === "permission" ? (
                    <button
                      disabled={busy}
                      onClick={() => void run(() => window.desklore.requestPermissions())}
                    >
                      {t("settings.grantAccessibility")}
                    </button>
                  ) : (
                    <button disabled={busy} onClick={() => requestExit(onOpenDiagnostics)}>
                      {t("settings.openDiagnostics")}
                    </button>
                  )}
                </SettingRow>
              </SettingsSection>
            </>
          )}

          {tab === "ai" && (
            <>
              <SettingsSection title={t("settings.modelConnection")}>
                <div className="settings-form-block">
                  <div className="settings-form-status">
                    <StatusPill tone={history?.llm.apiKeyConfigured ? "success" : "neutral"}>
                      {history?.llm.apiKeyConfigured
                        ? t("settings.configured")
                        : t("settings.notConfigured")}
                    </StatusPill>
                  </div>
                  <div className="settings-form-grid">
                    <label className="wide">
                      <span>
                        {t("settings.apiKey")}
                        {history?.llm.apiKeyConfigured && <b>{t("settings.keychainSaved")}</b>}
                      </span>
                      <input
                        type="password"
                        value={apiKey}
                        disabled={busy}
                        placeholder={
                          history?.llm.apiKeyConfigured ? t("settings.keepExistingKey") : "sk-…"
                        }
                        onChange={(event) => setAPIKey(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>{t("settings.protocol")}</span>
                      <select
                        value={protocol}
                        disabled={busy}
                        onChange={(event) => {
                          const next = event.target.value as ModelProtocol;
                          setEndpoint((current) =>
                            current === defaultModelEndpoints[protocol]
                              ? defaultModelEndpoints[next]
                              : current,
                          );
                          setProtocol(next);
                        }}
                      >
                        <option value="responses">{t("settings.protocolResponses")}</option>
                        <option value="chat_completions">
                          {t("settings.protocolChatCompletions")}
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>{t("settings.model")}</span>
                      <input
                        value={model}
                        disabled={busy}
                        onChange={(event) => setModel(event.target.value)}
                      />
                    </label>
                  </div>
                  <details
                    className="settings-advanced"
                    open={advancedOpen}
                    onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
                  >
                    <summary>{t("settings.advanced")}</summary>
                    <label>
                      <span>{t("settings.endpoint")}</span>
                      <input
                        value={endpoint}
                        disabled={busy}
                        onChange={(event) => setEndpoint(event.target.value)}
                      />
                    </label>
                  </details>
                  <footer className="settings-form-actions">
                    <div className="settings-save-state" role="status">
                      {feedback ?? (modelDirty ? t("settings.unsavedChanges") : "")}
                    </div>
                    {history?.llm.apiKeyConfigured && (
                      <button
                        className="text-danger"
                        disabled={busy}
                        onClick={() => setDialog("remove-key")}
                      >
                        {t("settings.removeKey")}
                      </button>
                    )}
                    <button
                      className="primary"
                      disabled={busy || !modelDirty}
                      onClick={() => void saveModel()}
                    >
                      {t("settings.saveModel")}
                    </button>
                  </footer>
                </div>
              </SettingsSection>

              <SettingsSection title={t("settings.featureControls")}>
                {!history?.llm.apiKeyConfigured && (
                  <div className="settings-inline-warning" role="status">
                    <strong>{t("settings.keyRequired")}</strong>
                  </div>
                )}
                <SettingRow title={t("settings.semanticSummaries")}>
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.semanticSummaries")}
                      checked={history?.llm.enabled ?? false}
                      disabled={
                        busy || !history || (!history.llm.apiKeyConfigured && !history.llm.enabled)
                      }
                      onChange={(event) =>
                        void run(() => window.desklore.setLLMEnabled(event.target.checked))
                      }
                    />
                    <span />
                  </label>
                </SettingRow>
                <SettingRow title={t("settings.rollupSynthesis")}>
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.rollupSynthesis")}
                      checked={history?.llm.rollupSynthesisEnabled ?? false}
                      disabled={
                        busy ||
                        !history ||
                        (!history.llm.apiKeyConfigured && !history.llm.rollupSynthesisEnabled)
                      }
                      onChange={(event) =>
                        void run(() =>
                          window.desklore.setRollupSynthesisEnabled(event.target.checked),
                        )
                      }
                    />
                    <span />
                  </label>
                </SettingRow>
              </SettingsSection>
            </>
          )}

          {tab === "visual" && (
            <>
              <SettingsSection title={t("settings.visualFallback")}>
                <SettingRow title={t("settings.visualFallback")}>
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.visualFallback")}
                      checked={visualEnabled}
                      disabled={busy || !history}
                      onChange={(event) =>
                        configureVisual({
                          captureMode: event.target.checked ? "fallback" : "off",
                        })
                      }
                    />
                    <span />
                  </label>
                </SettingRow>
                <div className="settings-form-block visual-settings-form">
                  <div className="settings-form-grid">
                    <label>
                      <span>{t("settings.axJudge")}</span>
                      <select
                        value={history?.visual.axJudge ?? "rules"}
                        disabled={busy || !visualEnabled}
                        onChange={(event) =>
                          configureVisual({ axJudge: event.target.value as "rules" | "luna" })
                        }
                      >
                        <option value="rules">{t("settings.localRules")}</option>
                        <option value="luna">{t("settings.lunaGrayAreas")}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t("settings.visualUnderstanding")}</span>
                      <select
                        value={history?.visual.understandingMode ?? "off"}
                        disabled={busy || !visualEnabled}
                        onChange={(event) =>
                          configureVisual({
                            understandingMode: event.target.value as "off" | "ocr" | "luna",
                          })
                        }
                      >
                        <option value="off">{t("settings.verifyCaptureOnly")}</option>
                        <option value="ocr">{t("settings.localOCR")}</option>
                        <option value="luna">{t("settings.redactedLuna")}</option>
                      </select>
                    </label>
                  </div>
                </div>
              </SettingsSection>

              <SettingsSection title={t("settings.screenRecording")}>
                <SettingRow title={t("settings.screenRecording")}>
                  <StatusPill
                    tone={
                      providerStatus === "ready" ? "success" : visualEnabled ? "warning" : "neutral"
                    }
                  >
                    {providerLabel}
                  </StatusPill>
                  {visualEnabled && providerStatus !== "ready" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => window.desklore.requestScreenCapturePermission())
                      }
                    >
                      {t("settings.grantScreenRecording")}
                    </button>
                  )}
                </SettingRow>
              </SettingsSection>
            </>
          )}

          {tab === "privacy" && (
            <>
              <SettingsSection title={t("settings.currentScope")}>
                <SettingRow
                  title={t("settings.currentApplication")}
                  description={
                    history?.activeApplication?.name ?? t("settings.noForegroundApplication")
                  }
                >
                  {history?.activeApplication && (
                    <>
                      <StatusPill tone={history.activeApplicationAllowed ? "success" : "neutral"}>
                        {history.activeApplicationAllowed
                          ? t("settings.observed")
                          : t("settings.excluded")}
                      </StatusPill>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            history.activeApplicationAllowed
                              ? window.desklore.blockActiveApplication()
                              : window.desklore.allowActiveApplication(),
                          )
                        }
                      >
                        {history.activeApplicationAllowed
                          ? t("settings.excludeApplication")
                          : t("settings.includeApplication")}
                      </button>
                    </>
                  )}
                </SettingRow>
                <SettingRow
                  title={t("settings.currentDomain")}
                  description={history?.activeDomain ?? t("settings.noBrowserDomain")}
                >
                  {history?.activeDomain && (
                    <>
                      <StatusPill tone={history.activeDomainAllowed ? "success" : "neutral"}>
                        {history.activeDomainAllowed
                          ? t("settings.observed")
                          : t("settings.excluded")}
                      </StatusPill>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            history.activeDomainAllowed
                              ? window.desklore.blockActiveDomain()
                              : window.desklore.allowActiveDomain(),
                          )
                        }
                      >
                        {history.activeDomainAllowed
                          ? t("settings.excludeDomain")
                          : t("settings.includeDomain")}
                      </button>
                    </>
                  )}
                </SettingRow>
              </SettingsSection>
              <SettingsSection title={t("settings.excludedApplications")}>
                <div className="settings-application-picker">
                  <div className="settings-application-toolbar">
                    <span>
                      {t("settings.applicationExclusionCount", {
                        count: excludedApplicationCount,
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={installedApplicationsLoading}
                      onClick={() => void loadInstalledApplications()}
                    >
                      {t("settings.reloadApplications")}
                    </button>
                  </div>
                  <label className="settings-application-search">
                    <span>{t("settings.searchApplications")}</span>
                    <input
                      type="search"
                      value={applicationSearch}
                      placeholder={t("settings.searchApplicationsPlaceholder")}
                      spellCheck={false}
                      onChange={(event) => setApplicationSearch(event.target.value)}
                    />
                  </label>
                  <div
                    className="settings-application-list"
                    aria-busy={installedApplicationsLoading}
                  >
                    {installedApplicationsLoading && installedApplications === undefined ? (
                      <div className="settings-application-empty">
                        {t("settings.readingApplications")}
                      </div>
                    ) : applicationPickerItems.length === 0 ? (
                      <div className="settings-application-empty">
                        {t("settings.noMatchingApplications")}
                      </div>
                    ) : (
                      applicationPickerItems.map((application) => {
                        const excluded = applicationIsExcluded(
                          desktop.observationPolicy,
                          application.bundleIdentifier,
                        );
                        return (
                          <label
                            key={application.bundleIdentifier}
                            className={
                              excluded
                                ? "settings-application-row selected"
                                : "settings-application-row"
                            }
                          >
                            <InstalledApplicationIcon application={application} />
                            <span className="settings-application-copy">
                              <strong>{application.name}</strong>
                              <small>
                                {application.bundleIdentifier}
                                {!application.installed && (
                                  <>
                                    {" · "}
                                    {t("settings.applicationNotFound")}
                                  </>
                                )}
                              </small>
                            </span>
                            <input
                              type="checkbox"
                              checked={excluded}
                              disabled={busy}
                              aria-label={t("settings.excludeNamedApplication", {
                                name: application.name,
                              })}
                              onChange={(event) =>
                                void setApplicationExcluded(
                                  application.bundleIdentifier,
                                  event.target.checked,
                                )
                              }
                            />
                          </label>
                        );
                      })
                    )}
                  </div>
                  {installedApplicationsError && (
                    <div className="settings-application-error" role="status">
                      {t("settings.applicationListUnavailable")}
                    </div>
                  )}
                </div>
                <details className="settings-advanced settings-manual-application">
                  <summary>{t("settings.manualApplicationRule")}</summary>
                  <form className="settings-rule-form" onSubmit={addApplicationExclusion}>
                    <label>
                      <span>{t("settings.bundleIdentifier")}</span>
                      <input
                        value={applicationExclusion}
                        disabled={busy}
                        placeholder={t("settings.bundleIdentifierPlaceholder")}
                        autoCapitalize="none"
                        spellCheck={false}
                        onChange={(event) => setApplicationExclusion(event.target.value)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={busy || !applicationExclusion.trim()}
                      type="submit"
                    >
                      {t("settings.addApplicationExclusion")}
                    </button>
                  </form>
                </details>
              </SettingsSection>
              <SettingsSection title={t("settings.excludedDomains")}>
                {desktop.observationPolicy.blockedDomains.length === 0 ? (
                  <div className="settings-empty-state">{t("settings.noDomainExclusions")}</div>
                ) : (
                  desktop.observationPolicy.blockedDomains.map((domain) => (
                    <SettingRow key={domain} title={domain}>
                      <button
                        disabled={busy}
                        aria-label={`${t("settings.removeDomainExclusion")}: ${domain}`}
                        onClick={() =>
                          void updateObservationPolicy((draft) => {
                            draft.blockedDomains = draft.blockedDomains.filter(
                              (value) => value !== domain,
                            );
                          })
                        }
                      >
                        {t("common.delete")}
                      </button>
                    </SettingRow>
                  ))
                )}
                <form className="settings-rule-form" onSubmit={addDomainExclusion}>
                  <label>
                    <span>{t("settings.domain")}</span>
                    <input
                      value={domainExclusion}
                      disabled={busy}
                      placeholder={t("settings.domainPlaceholder")}
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => setDomainExclusion(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !domainExclusion.trim()}
                    type="submit"
                  >
                    {t("settings.addDomainExclusion")}
                  </button>
                </form>
              </SettingsSection>
              <SettingsSection title={t("settings.excludedWindowTitles")}>
                {desktop.observationPolicy.blockedWindowTitles.length === 0 ? (
                  <div className="settings-empty-state">
                    {t("settings.noWindowTitleExclusions")}
                  </div>
                ) : (
                  desktop.observationPolicy.blockedWindowTitles.map((rule) => (
                    <SettingRow
                      key={rule.id}
                      title={`${rule.match === "exact" ? t("settings.matchExact") : t("settings.matchContains")}: “${rule.pattern}”`}
                      description={
                        rule.bundleIdentifier
                          ? t("settings.windowTitleOneApplication", {
                              bundle: rule.bundleIdentifier,
                            })
                          : t("settings.windowTitleEveryApplication")
                      }
                    >
                      <button
                        disabled={busy}
                        aria-label={`${t("settings.removeWindowTitleExclusion")}: ${rule.pattern}`}
                        onClick={() =>
                          void updateObservationPolicy((draft) => {
                            draft.blockedWindowTitles = draft.blockedWindowTitles.filter(
                              (value) => value.id !== rule.id,
                            );
                          })
                        }
                      >
                        {t("common.delete")}
                      </button>
                    </SettingRow>
                  ))
                )}
                <form
                  className="settings-form-block settings-window-rule-form"
                  onSubmit={addWindowTitleExclusion}
                >
                  <div className="settings-form-grid">
                    <label className="wide">
                      <span>{t("settings.windowTitlePattern")}</span>
                      <input
                        value={windowTitlePattern}
                        disabled={busy}
                        minLength={3}
                        maxLength={128}
                        placeholder={t("settings.windowTitlePlaceholder")}
                        onChange={(event) => setWindowTitlePattern(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>{t("settings.matchMode")}</span>
                      <select
                        value={windowTitleMatch}
                        disabled={busy}
                        onChange={(event) =>
                          setWindowTitleMatch(event.target.value as "contains" | "exact")
                        }
                      >
                        <option value="contains">{t("settings.matchContains")}</option>
                        <option value="exact">{t("settings.matchExact")}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t("settings.applicationScope")}</span>
                      <input
                        value={windowTitleApplication}
                        disabled={busy}
                        placeholder={t("settings.applicationScopePlaceholder")}
                        autoCapitalize="none"
                        spellCheck={false}
                        onChange={(event) => setWindowTitleApplication(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="settings-form-actions">
                    <span className="settings-save-state" />
                    <button
                      className="primary"
                      disabled={busy || windowTitlePattern.trim().length < 3}
                      type="submit"
                    >
                      {t("settings.addWindowTitleExclusion")}
                    </button>
                  </div>
                </form>
              </SettingsSection>
            </>
          )}

          {tab === "data" && (
            <>
              <SettingsSection title={t("settings.localArchive")}>
                <SettingRow
                  title={t("settings.storageLocation")}
                  description={history?.storageRoot ?? "—"}
                >
                  <button
                    disabled={busy || !history}
                    onClick={() => void run(() => window.desklore.revealStorage())}
                  >
                    {t("common.revealFiles")}
                  </button>
                </SettingRow>
                <SettingRow
                  title={t("settings.archiveContents")}
                  description={t("settings.historyCounts", {
                    documents: history?.documents.length ?? 0,
                    rollups: history?.rollups.length ?? 0,
                  })}
                >
                  <StatusPill tone="success">{t("settings.localOnly")}</StatusPill>
                </SettingRow>
              </SettingsSection>

              {recovery && (
                <section className="settings-recovery" role="status">
                  <div>
                    <strong>{t("settings.recoveryTitle")}</strong>
                    <span>
                      {t("settings.recoveryDetail", {
                        date: recoveryDate,
                        documents: recovery.documentCount,
                        rollups: recovery.rollupCount,
                      })}
                    </span>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        const restored = await run(() =>
                          window.desklore.restoreHistory(recovery.id),
                        );
                        if (restored) setFeedback(t("settings.restoreSuccess"));
                      })()
                    }
                  >
                    {t("settings.restoreHistory")}
                  </button>
                </section>
              )}

              {feedback && <div className="settings-inline-feedback">{feedback}</div>}

              <SettingsSection title={t("settings.dangerZone")} tone="danger">
                <SettingRow title={t("settings.deleteHistory")}>
                  <button
                    className="text-danger"
                    disabled={busy || !history}
                    onClick={() => setDialog("clear-history")}
                  >
                    {t("settings.clearHistory")}
                  </button>
                </SettingRow>
              </SettingsSection>
            </>
          )}
        </div>
      </main>

      {dialog === "discard-changes" && (
        <SettingsDialog
          title={t("settings.discardChangesTitle")}
          detail={t("settings.discardChangesDetail")}
          confirmLabel={t("settings.discardChanges")}
          busy={busy}
          onCancel={() => setDialog(undefined)}
          onConfirm={() => {
            const action = pendingExit.current;
            setDialog(undefined);
            action();
          }}
        />
      )}
      {dialog === "remove-key" && (
        <SettingsDialog
          title={t("settings.removeKeyTitle")}
          detail={t("settings.removeKeyDetail")}
          confirmLabel={t("settings.removeKeyConfirm")}
          busy={busy}
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={() =>
            void (async () => {
              const removed = await run(() => window.desklore.removeLLMAPIKey());
              if (removed) setDialog(undefined);
            })()
          }
        />
      )}
      {dialog === "clear-history" && (
        <SettingsDialog
          title={t("settings.clearDialogTitle")}
          detail={`${t("settings.clearDialogDetail")} ${t("settings.clearDialogCounts", {
            documents: history?.documents.length ?? 0,
            rollups: history?.rollups.length ?? 0,
          })}`}
          secondaryDetail={t("settings.clearDialogPause")}
          confirmLabel={t("settings.clearDialogConfirm")}
          busy={busy}
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={() =>
            void (async () => {
              const cleared = await run(() => window.desklore.clearHistory());
              if (cleared) setDialog(undefined);
            })()
          }
        />
      )}
    </div>
  );
}
