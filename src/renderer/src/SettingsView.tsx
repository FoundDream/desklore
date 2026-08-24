import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  DesktopSnapshot,
  InstalledApplication,
  ObservationPolicy,
} from "../../shared/contracts.js";
import { defaultModelEndpoints, type ModelProtocol } from "../../shared/model.js";
import appIcon from "./assets/app-icon.png";
import { useI18n } from "./i18n.js";

type SettingsTab = "general" | "ai" | "visual" | "privacy" | "data";
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

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function SettingsSection({
  title,
  children,
  tone,
}: {
  title: string;
  children: ReactNode;
  tone?: "danger";
}) {
  return (
    <section className={`setting-group ${tone ? `setting-group-${tone}` : ""}`}>
      <h2>{title}</h2>
      <div className="setting-group-body">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return <span className={`setting-status setting-status-${tone}`}>{children}</span>;
}

function InstalledApplicationIcon({ application }: { application: InstalledApplication }) {
  const source = application.iconDataURL;
  return (
    <span className={`settings-application-icon${source ? "" : " fallback"}`} aria-hidden="true">
      {source ? <img src={source} alt="" /> : application.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function applicationIsExcluded(policy: ObservationPolicy, bundleIdentifier: string): boolean {
  if (policy.blockedBundleIdentifiers.includes(bundleIdentifier)) return true;
  return (
    policy.defaultApplicationBehavior === "do_not_observe" &&
    !policy.allowedBundleIdentifiers.includes(bundleIdentifier)
  );
}

function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="settings-disclosure">
      <summary>{title}</summary>
      <p>{children}</p>
    </details>
  );
}

function SettingsDialog({
  title,
  detail,
  secondaryDetail,
  confirmLabel,
  busy,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  secondaryDetail?: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => cancelButton.current?.focus(), []);

  return (
    <div
      className="settings-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <h2 id="settings-dialog-title">{title}</h2>
        <p>{detail}</p>
        {secondaryDetail && <p className="settings-dialog-secondary">{secondaryDetail}</p>}
        <footer>
          <button ref={cancelButton} disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
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
  const agent = desktop.agent;
  const [tab, setTab] = useState<SettingsTab>("general");
  const [dialog, setDialog] = useState<SettingsDialogName>();
  const [feedback, setFeedback] = useState<string>();
  const [protocol, setProtocol] = useState<ModelProtocol>(agent?.llm.protocol ?? "responses");
  const [model, setModel] = useState(agent?.llm.model ?? "gpt-5.6-luna");
  const [endpoint, setEndpoint] = useState(agent?.llm.endpoint ?? defaultModelEndpoints.responses);
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
      agent?.llm.endpoint && agent.llm.endpoint !== defaultModelEndpoints[agent.llm.protocol],
    ),
  );
  const pendingExit = useRef<() => void>(onBack);

  useEffect(() => {
    if (!agent) return;
    setProtocol(agent.llm.protocol);
    setModel(agent.llm.model);
    setEndpoint(agent.llm.endpoint);
  }, [agent?.llm.endpoint, agent?.llm.model, agent?.llm.protocol]);

  useEffect(() => {
    if (agent?.llm.endpoint && agent.llm.endpoint !== defaultModelEndpoints[agent.llm.protocol]) {
      setAdvancedOpen(true);
    }
  }, [agent?.llm.endpoint, agent?.llm.protocol]);

  const loadInstalledApplications = useCallback(async (): Promise<void> => {
    setInstalledApplicationsLoading(true);
    setInstalledApplicationsError(undefined);
    try {
      setInstalledApplications(await window.computerHistory.listInstalledApplications());
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

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: t("settings.tabGeneral") },
    { id: "ai", label: t("settings.tabAI") },
    { id: "visual", label: t("settings.tabVisual") },
    { id: "privacy", label: t("settings.tabPrivacy") },
    { id: "data", label: t("settings.tabData") },
  ];
  const pageCopy = {
    general: [t("settings.tabGeneral"), t("settings.generalDescription")],
    ai: [t("settings.tabAI"), t("settings.aiDescription")],
    visual: [t("settings.tabVisual"), t("settings.visualDescription")],
    privacy: [t("settings.tabPrivacy"), t("settings.privacyDescription")],
    data: [t("settings.tabData"), t("settings.dataDescription")],
  } satisfies Record<SettingsTab, [string, string]>;
  const modelDirty =
    Boolean(agent) &&
    (protocol !== agent?.llm.protocol ||
      model !== agent?.llm.model ||
      endpoint !== agent?.llm.endpoint ||
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

  const recording = agent?.recorderState === "running";
  const collectorReady = desktop.connectionState === "connected" && Boolean(agent);
  const captureStatus = !collectorReady
    ? "unavailable"
    : !agent?.health.accessibilityGranted
      ? "permission"
      : !agent.health.interactionMonitorActive
        ? "attention"
        : recording
          ? "ready"
          : "paused";
  const visualEnabled = agent?.visual.captureMode === "fallback";
  const providerStatus = agent?.visual.providerStatus;
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
    if (!agent) return;
    setFeedback(undefined);
    const saved = await run(() =>
      window.computerHistory.configureLLM({
        enabled: agent.llm.enabled,
        memorySynthesisEnabled: agent.llm.memorySynthesisEnabled,
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
    if (!agent) return;
    void run(() =>
      window.computerHistory.configureVisual({
        axJudge: next.axJudge ?? agent.visual.axJudge,
        captureMode: next.captureMode ?? agent.visual.captureMode,
        understandingMode: next.understandingMode ?? agent.visual.understandingMode,
      }),
    );
  };

  const updateObservationPolicy = async (
    update: (draft: ObservationPolicy) => void,
  ): Promise<boolean> => {
    const next = structuredClone(desktop.observationPolicy);
    update(next);
    return run(() => window.computerHistory.updateObservationPolicy(next));
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
          <BackIcon />
          <span>{t("settings.backToDeskLore")}</span>
        </button>
        <div className="settings-brand">
          <img src={appIcon} alt="" />
          <strong>{t("settings.title")}</strong>
        </div>
        <nav aria-label={t("settings.title")}>
          {tabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => changeTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <span className="settings-shortcut">⌘,</span>
      </aside>

      <main className="settings-content">
        <div className="settings-content-inner">
          <header className="settings-page-header">
            <h1>{pageCopy[tab][0]}</h1>
            <p>{pageCopy[tab][1]}</p>
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
                <SettingRow title={t("settings.language")} description={t("settings.languageHint")}>
                  <select
                    className="setting-select"
                    aria-label={t("settings.language")}
                    value={locale}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        window.computerHistory.setLocale(event.target.value as "en" | "zh-CN"),
                      )
                    }
                  >
                    <option value="en">{t("language.english")}</option>
                    <option value="zh-CN">{t("language.simplifiedChinese")}</option>
                  </select>
                </SettingRow>
              </SettingsSection>

              <SettingsSection title={t("settings.capture")}>
                <SettingRow
                  title={t("settings.recording")}
                  description={
                    recording ? t("settings.recordingRunning") : t("settings.recordingPaused")
                  }
                >
                  <StatusPill tone={recording ? "success" : "neutral"}>
                    {recording ? t("sidebar.recording") : t("sidebar.paused")}
                  </StatusPill>
                  <button
                    disabled={busy || !agent}
                    onClick={() =>
                      void run(() =>
                        recording
                          ? window.computerHistory.pause()
                          : window.computerHistory.resume(),
                      )
                    }
                  >
                    {recording ? t("settings.pauseRecording") : t("settings.resumeRecording")}
                  </button>
                </SettingRow>
                <SettingRow
                  title={t("settings.captureStatus")}
                  description={
                    captureStatus === "unavailable"
                      ? desktop.connectionState === "starting"
                        ? t("connection.starting")
                        : t("settings.collectorUnavailable")
                      : captureStatus === "permission"
                        ? t("settings.capturePermissionRequired")
                        : captureStatus === "attention"
                          ? t("settings.captureNeedsAttentionDetail")
                          : captureStatus === "ready"
                            ? t("settings.captureReadyDetail")
                            : t("settings.recordingPaused")
                  }
                >
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
                        onClick={() => void run(() => window.computerHistory.startAgent())}
                      >
                        {t("connection.restart")}
                      </button>
                    )
                  ) : captureStatus === "permission" ? (
                    <button
                      disabled={busy}
                      onClick={() => void run(() => window.computerHistory.requestPermissions())}
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
                  <header>
                    <p>{t("settings.modelConnectionDetail")}</p>
                    <StatusPill tone={agent?.llm.apiKeyConfigured ? "success" : "neutral"}>
                      {agent?.llm.apiKeyConfigured
                        ? t("settings.configured")
                        : t("settings.notConfigured")}
                    </StatusPill>
                  </header>
                  <div className="settings-form-grid">
                    <label className="wide">
                      <span>
                        {t("settings.apiKey")}
                        {agent?.llm.apiKeyConfigured && <b>{t("settings.keychainSaved")}</b>}
                      </span>
                      <input
                        type="password"
                        value={apiKey}
                        disabled={busy}
                        placeholder={
                          agent?.llm.apiKeyConfigured ? t("settings.keepExistingKey") : "sk-…"
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
                    <p>{t("settings.advancedDetail")}</p>
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
                    {agent?.llm.apiKeyConfigured && (
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
                {!agent?.llm.apiKeyConfigured && (
                  <div className="settings-inline-warning" role="status">
                    <strong>{t("settings.keyRequired")}</strong>
                    <span>{t("settings.keyRequiredDetail")}</span>
                  </div>
                )}
                <SettingRow
                  title={t("settings.semanticSummaries")}
                  description={t("settings.semanticSummariesDetail")}
                >
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.semanticSummaries")}
                      checked={agent?.llm.enabled ?? false}
                      disabled={
                        busy || !agent || (!agent.llm.apiKeyConfigured && !agent.llm.enabled)
                      }
                      onChange={(event) =>
                        void run(() => window.computerHistory.setLLMEnabled(event.target.checked))
                      }
                    />
                    <span />
                  </label>
                </SettingRow>
                <SettingRow
                  title={t("settings.memorySynthesis")}
                  description={t("settings.memorySynthesisDetail")}
                >
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.memorySynthesis")}
                      checked={agent?.llm.memorySynthesisEnabled ?? false}
                      disabled={
                        busy ||
                        !agent ||
                        (!agent.llm.apiKeyConfigured && !agent.llm.memorySynthesisEnabled)
                      }
                      onChange={(event) =>
                        void run(() =>
                          window.computerHistory.setMemorySynthesisEnabled(event.target.checked),
                        )
                      }
                    />
                    <span />
                  </label>
                </SettingRow>
              </SettingsSection>
              <SettingsDisclosure title={t("settings.dataBoundary")}>
                {t("settings.dataBoundaryDetail")}
              </SettingsDisclosure>
            </>
          )}

          {tab === "visual" && (
            <>
              <SettingsSection title={t("settings.visualFallback")}>
                <SettingRow
                  title={t("settings.visualFallback")}
                  description={t("settings.visualFallbackDetail")}
                >
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-label={t("settings.visualFallback")}
                      checked={visualEnabled}
                      disabled={busy || !agent}
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
                        value={agent?.visual.axJudge ?? "rules"}
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
                        value={agent?.visual.understandingMode ?? "off"}
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
                <SettingRow
                  title={t("settings.screenRecording")}
                  description={
                    providerStatus === "ready"
                      ? t("settings.screenRecordingReadyDetail")
                      : visualEnabled
                        ? t("settings.screenRecordingRequiredDetail")
                        : t("settings.screenRecordingInactiveDetail")
                  }
                >
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
                        void run(() => window.computerHistory.requestScreenCapturePermission())
                      }
                    >
                      {t("settings.grantScreenRecording")}
                    </button>
                  )}
                </SettingRow>
              </SettingsSection>
              <SettingsDisclosure title={t("settings.visualFlow")}>
                {t("settings.visualBoundaryDetail")}
              </SettingsDisclosure>
            </>
          )}

          {tab === "privacy" && (
            <>
              <SettingsSection title={t("settings.currentScope")}>
                <div className="setting-group-intro">{t("settings.currentScopeDetail")}</div>
                <SettingRow
                  title={t("settings.currentApplication")}
                  description={
                    agent?.activeApplication?.name ?? t("settings.noForegroundApplication")
                  }
                >
                  {agent?.activeApplication && (
                    <>
                      <StatusPill tone={agent.activeApplicationAllowed ? "success" : "neutral"}>
                        {agent.activeApplicationAllowed
                          ? t("settings.observed")
                          : t("settings.excluded")}
                      </StatusPill>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            agent.activeApplicationAllowed
                              ? window.computerHistory.blockActiveApplication()
                              : window.computerHistory.allowActiveApplication(),
                          )
                        }
                      >
                        {agent.activeApplicationAllowed
                          ? t("settings.excludeApplication")
                          : t("settings.includeApplication")}
                      </button>
                    </>
                  )}
                </SettingRow>
                <SettingRow
                  title={t("settings.currentDomain")}
                  description={agent?.activeDomain ?? t("settings.noBrowserDomain")}
                >
                  {agent?.activeDomain && (
                    <>
                      <StatusPill tone={agent.activeDomainAllowed ? "success" : "neutral"}>
                        {agent.activeDomainAllowed
                          ? t("settings.observed")
                          : t("settings.excluded")}
                      </StatusPill>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            agent.activeDomainAllowed
                              ? window.computerHistory.blockActiveDomain()
                              : window.computerHistory.allowActiveDomain(),
                          )
                        }
                      >
                        {agent.activeDomainAllowed
                          ? t("settings.excludeDomain")
                          : t("settings.includeDomain")}
                      </button>
                    </>
                  )}
                </SettingRow>
              </SettingsSection>
              <SettingsSection title={t("settings.excludedApplications")}>
                <div className="setting-group-intro">
                  {t("settings.excludedApplicationsDetail")}
                </div>
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
                  <p>{t("settings.manualApplicationRuleDetail")}</p>
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
                <div className="setting-group-intro">{t("settings.excludedDomainsDetail")}</div>
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
                <div className="setting-group-intro">
                  {t("settings.excludedWindowTitlesDetail")}
                </div>
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
              <SettingsDisclosure title={t("settings.exclusionPriority")}>
                {t("settings.exclusionPriorityDetail")}
              </SettingsDisclosure>
            </>
          )}

          {tab === "data" && (
            <>
              <SettingsSection title={t("settings.localArchive")}>
                <SettingRow
                  title={t("settings.storageLocation")}
                  description={agent?.storageRoot ?? "—"}
                >
                  <button
                    disabled={busy || !agent}
                    onClick={() => void run(() => window.computerHistory.revealStorage())}
                  >
                    {t("common.revealFiles")}
                  </button>
                </SettingRow>
                <SettingRow
                  title={t("settings.archiveContents")}
                  description={t("settings.historyCounts", {
                    documents: agent?.documents.length ?? 0,
                    memories: agent?.memories.length ?? 0,
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
                        memories: recovery.memoryCount,
                      })}
                    </span>
                    <small>{t("settings.recoveryRetention")}</small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        const restored = await run(() =>
                          window.computerHistory.restoreHistory(recovery.id),
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
                <SettingRow
                  title={t("settings.deleteHistory")}
                  description={t("settings.deleteHistoryDetail")}
                >
                  <button
                    className="text-danger"
                    disabled={busy || !agent}
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
              const removed = await run(() => window.computerHistory.removeLLMAPIKey());
              if (removed) setDialog(undefined);
            })()
          }
        />
      )}
      {dialog === "clear-history" && (
        <SettingsDialog
          title={t("settings.clearDialogTitle")}
          detail={`${t("settings.clearDialogDetail")} ${t("settings.clearDialogCounts", {
            documents: agent?.documents.length ?? 0,
            memories: agent?.memories.length ?? 0,
          })}`}
          secondaryDetail={t("settings.clearDialogPause")}
          confirmLabel={t("settings.clearDialogConfirm")}
          busy={busy}
          danger
          onCancel={() => setDialog(undefined)}
          onConfirm={() =>
            void (async () => {
              const cleared = await run(() => window.computerHistory.clearHistory());
              if (cleared) setDialog(undefined);
            })()
          }
        />
      )}
    </div>
  );
}
