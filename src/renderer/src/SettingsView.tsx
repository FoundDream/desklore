import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopSnapshot } from "../../shared/contracts.js";
import appIcon from "./assets/app-icon.png";
import { useI18n } from "./i18n.js";

type SettingsTab = "general" | "ai" | "visual" | "privacy" | "data";
type SettingsDialogName = "clear-history" | "discard-changes" | "remove-key";
type RunAction = (action: () => Promise<DesktopSnapshot>) => Promise<boolean>;

const defaultResponsesEndpoint = "https://api.openai.com/v1/responses";

interface SettingsViewProps {
  desktop: DesktopSnapshot;
  run: RunAction;
  busy: boolean;
  error?: string;
  onDismissError: () => void;
  onBack: () => void;
  onOpenHealth: () => void;
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
  onOpenHealth,
}: SettingsViewProps) {
  const { locale, t } = useI18n();
  const agent = desktop.agent;
  const [tab, setTab] = useState<SettingsTab>("general");
  const [dialog, setDialog] = useState<SettingsDialogName>();
  const [feedback, setFeedback] = useState<string>();
  const [model, setModel] = useState(agent?.llm.model ?? "gpt-5.6-luna");
  const [endpoint, setEndpoint] = useState(agent?.llm.endpoint ?? defaultResponsesEndpoint);
  const [apiKey, setAPIKey] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(agent?.llm.endpoint && agent.llm.endpoint !== defaultResponsesEndpoint),
  );
  const pendingExit = useRef<() => void>(onBack);

  useEffect(() => {
    if (!agent) return;
    setModel(agent.llm.model);
    setEndpoint(agent.llm.endpoint);
  }, [agent?.llm.endpoint, agent?.llm.model]);

  useEffect(() => {
    if (agent?.llm.endpoint && agent.llm.endpoint !== defaultResponsesEndpoint) {
      setAdvancedOpen(true);
    }
  }, [agent?.llm.endpoint]);

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
    (model !== agent?.llm.model || endpoint !== agent?.llm.endpoint || Boolean(apiKey.trim()));
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
                  title={t("settings.collector")}
                  description={
                    desktop.connectionState === "connected"
                      ? t("settings.collectorConnected")
                      : t("settings.collectorUnavailable")
                  }
                >
                  <StatusPill
                    tone={desktop.connectionState === "connected" ? "success" : "warning"}
                  >
                    {desktop.connectionState === "connected"
                      ? t("common.ready")
                      : t("common.notReady")}
                  </StatusPill>
                </SettingRow>
                <SettingRow
                  title={t("settings.accessibilityAccess")}
                  description={t("settings.accessibilityDetail")}
                >
                  <StatusPill tone={agent?.health.accessibilityGranted ? "success" : "warning"}>
                    {agent?.health.accessibilityGranted ? t("common.ready") : t("common.notReady")}
                  </StatusPill>
                  <button
                    disabled={busy}
                    onClick={() =>
                      agent?.health.accessibilityGranted
                        ? requestExit(onOpenHealth)
                        : void run(() => window.computerHistory.requestPermissions())
                    }
                  >
                    {agent?.health.accessibilityGranted
                      ? t("settings.openCaptureHealth")
                      : t("settings.grantAccessibility")}
                  </button>
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
                    <label className="wide">
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
