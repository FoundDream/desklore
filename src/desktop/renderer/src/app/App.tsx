import { useCallback, useEffect, useState } from "react";
import appIcon from "../assets/app-icon.png";
import { Icon } from "../components/Icon.js";
import { I18nProvider, useI18n } from "./i18n.js";
import { SettingsView as SettingsPage } from "../features/settings/SettingsView.js";
import type { DesktopSnapshot, HistorySnapshot } from "../../../../shared/contracts/index.js";
import type { MessageKey } from "../../../../shared/i18n/index.js";
import { translate } from "../../../../shared/i18n/index.js";
import { DiagnosticsView } from "../features/diagnostics/DiagnosticsView.js";
import { TimelineView } from "../features/timeline/TimelineView.js";
import { UsageView } from "../features/usage/UsageView.js";
import type { RunAction } from "./types.js";

type View = "timeline" | "usage" | "diagnostics" | "settings";
type PrimaryView = "timeline" | "usage";

function ConnectionNotice({
  desktop,
  run,
  onOpenDiagnostics,
}: {
  desktop?: DesktopSnapshot;
  run: RunAction;
  onOpenDiagnostics: () => void;
}) {
  const { t } = useI18n();
  if (!desktop || !desktop.recordingConsentGranted) return null;

  if (desktop.connectionState === "connected") {
    const history = desktop.history;
    if (!history || history.recorderState !== "running") return null;
    const permissionMissing = !history.health.accessibilityGranted;
    const monitorUnavailable =
      history.health.accessibilityGranted && !history.health.interactionMonitorActive;
    if (!permissionMissing && !monitorUnavailable) return null;
    return (
      <div className="connection-notice">
        <span className="signal failed" />
        <div>
          <strong>
            {permissionMissing
              ? t("health.permissionRequired")
              : t("settings.captureNeedsAttention")}
          </strong>
        </div>
        <button
          onClick={() =>
            permissionMissing
              ? void run(() => window.desklore.requestPermissions())
              : onOpenDiagnostics()
          }
        >
          {permissionMissing ? t("settings.grantAccessibility") : t("settings.openDiagnostics")}
        </button>
      </div>
    );
  }

  const labels = {
    starting: t("connection.starting"),
    stopped: t("connection.stopped"),
    missing: t("connection.missing"),
    failed: t("connection.failed"),
  } as const;
  return (
    <div className="connection-notice">
      <span className={`signal ${desktop.connectionState}`} />
      <div>
        <strong>{labels[desktop.connectionState]}</strong>
        {desktop.connectionError && <small>{desktop.connectionError}</small>}
      </div>
      {desktop.connectionState !== "starting" && (
        <button onClick={() => void run(() => window.desklore.startCollector())}>
          {t("connection.restart")}
        </button>
      )}
    </div>
  );
}

function RecordingConsentView({
  run,
  busy,
  error,
  onDismissError,
}: {
  run: RunAction;
  busy: boolean;
  error?: string;
  onDismissError: () => void;
}) {
  const { locale, t } = useI18n();
  const [step, setStep] = useState<"boundary" | "permission">("boundary");
  const isBoundaryStep = step === "boundary";
  const details = isBoundaryStep
    ? [
        [t("onboarding.offByDefault"), t("onboarding.offByDefaultDetail")],
        [t("onboarding.autoFiltered"), t("onboarding.autoFilteredDetail")],
      ]
    : [
        [t("onboarding.separatePermission"), t("onboarding.separatePermissionDetail")],
        [t("onboarding.noScreenRecording"), t("onboarding.noScreenRecordingDetail")],
      ];

  return (
    <section className="onboarding-screen">
      <header className="onboarding-header">
        <div className="onboarding-brand">
          <img src={appIcon} alt="" />
          <strong>DeskLore</strong>
        </div>
        <div className="onboarding-header-actions">
          <select
            className="onboarding-language"
            aria-label={t("settings.language")}
            value={locale}
            disabled={busy}
            onChange={(event) =>
              void run(() => window.desklore.setLocale(event.target.value as "en" | "zh-CN"))
            }
          >
            <option value="en">{t("language.english")}</option>
            <option value="zh-CN">{t("language.simplifiedChinese")}</option>
          </select>
          <div
            className="onboarding-progress"
            role="progressbar"
            aria-label={t("onboarding.progress", { step: isBoundaryStep ? 1 : 2 })}
            aria-valuemin={1}
            aria-valuemax={2}
            aria-valuenow={isBoundaryStep ? 1 : 2}
          >
            <i className="active" />
            <i className={isBoundaryStep ? "" : "active"} />
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner onboarding-error">
          <strong>{t("common.actionFailed")}</strong>
          <span>{error}</span>
          <button onClick={onDismissError}>{t("common.close")}</button>
        </div>
      )}

      <div className="onboarding-stage">
        <div className="onboarding-panel">
          <img className="onboarding-app-icon" src={appIcon} alt="" />
          <span className="onboarding-kicker">
            {t("onboarding.step", { step: isBoundaryStep ? 1 : 2 })}
          </span>
          <h1>
            {isBoundaryStep ? t("onboarding.reviewBoundary") : t("onboarding.allowAccessibility")}
          </h1>
          <p className="onboarding-lead">
            {isBoundaryStep ? t("onboarding.boundaryLead") : t("onboarding.permissionLead")}
          </p>

          <div className="onboarding-details">
            {details.map(([label, value]) => (
              <div key={label}>
                <strong>{label}</strong>
                <span>{value}</span>
              </div>
            ))}
          </div>

          <div className="onboarding-actions">
            {!isBoundaryStep && (
              <button className="secondary" disabled={busy} onClick={() => setStep("boundary")}>
                {t("common.back")}
              </button>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (isBoundaryStep) {
                  setStep("permission");
                } else {
                  void run(() => window.desklore.grantRecordingConsent());
                }
              }}
            >
              {busy
                ? t("common.starting")
                : isBoundaryStep
                  ? t("common.continue")
                  : t("onboarding.agreeAndStart")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Sidebar({
  view,
  history,
  onView,
  onToggleRecording,
}: {
  view: View;
  history?: HistorySnapshot;
  onView: (view: View) => void;
  onToggleRecording: () => void;
}) {
  const { t } = useI18n();
  const running = history?.recorderState === "running";
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <i />
        </span>
        <div>
          <strong>DeskLore</strong>
        </div>
      </div>
      <nav>
        <button className={view === "timeline" ? "active" : ""} onClick={() => onView("timeline")}>
          <Icon name="timeline" />
          <span>{t("sidebar.timeline")}</span>
          <b>{history?.documents.length ?? "—"}</b>
        </button>
        <button className={view === "usage" ? "active" : ""} onClick={() => onView("usage")}>
          <Icon name="usage" />
          <span>{t("sidebar.usage")}</span>
        </button>
        <button
          className={view === "settings" || view === "diagnostics" ? "active" : ""}
          onClick={() => onView("settings")}
        >
          <Icon name="settings" />
          <span>{t("sidebar.settings")}</span>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <button
          className={`record-control ${running ? "running" : ""}`}
          onClick={onToggleRecording}
        >
          <span className="record-orbit">
            <i />
          </span>
          <div>
            <strong>{running ? t("sidebar.recording") : t("sidebar.paused")}</strong>
          </div>
        </button>
      </div>
    </aside>
  );
}

export function App() {
  const [view, setView] = useState<View>("timeline");
  const [returnView, setReturnView] = useState<PrimaryView>("timeline");
  const [desktop, setDesktop] = useState<DesktopSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.desklore
      .getSnapshot()
      .then(setDesktop)
      .catch((cause: unknown) => setError(String(cause)));
    return window.desklore.onSnapshot(setDesktop);
  }, []);

  useEffect(() => {
    document.querySelector<HTMLElement>(".content")?.scrollTo({ top: 0 });
  }, [view]);

  const run = useCallback(async (action: () => Promise<DesktopSnapshot>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      setDesktop(result);
      setError(result.history?.lastError);
      return !result.history?.lastError;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const navigate = useCallback(
    (next: View): void => {
      if (next === "settings" && (view === "timeline" || view === "usage")) {
        setReturnView(view);
      }
      setView(next);
    },
    [view],
  );

  const openDiagnostics = useCallback((): void => {
    if (view === "timeline" || view === "usage") setReturnView(view);
    setView("diagnostics");
  }, [view]);

  const closeSettings = useCallback((): void => setView(returnView), [returnView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ",") return;
      event.preventDefault();
      navigate("settings");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);

  const toggleRecording = (): void => {
    if (!desktop?.recordingConsentGranted) {
      void run(() => window.desklore.grantRecordingConsent());
    } else if (desktop.connectionState !== "connected") {
      void run(() => window.desklore.startCollector());
    } else if (desktop.history?.recorderState === "running") {
      void run(() => window.desklore.pause());
    } else {
      void run(() => window.desklore.resume());
    }
  };

  const locale = desktop?.locale ?? "en";
  const t = (key: MessageKey, values?: Record<string, string | number>): string =>
    translate(locale, key, values);

  if (!desktop) {
    return (
      <I18nProvider locale={locale}>
        <div className="startup-screen">
          {error && (
            <div className="error-banner">
              <strong>{t("startup.failed")}</strong>
              <span>{error}</span>
              <button onClick={() => setError(undefined)}>{t("common.close")}</button>
            </div>
          )}
        </div>
      </I18nProvider>
    );
  }

  if (!desktop.recordingConsentGranted) {
    return (
      <I18nProvider locale={locale}>
        <div className={`onboarding-root ${busy ? "busy" : ""}`}>
          <RecordingConsentView
            run={run}
            busy={busy}
            error={error}
            onDismissError={() => setError(undefined)}
          />
        </div>
      </I18nProvider>
    );
  }

  if (view === "settings") {
    return (
      <I18nProvider locale={locale}>
        <SettingsPage
          desktop={desktop}
          run={run}
          busy={busy}
          error={error}
          onDismissError={() => setError(undefined)}
          onBack={closeSettings}
          onOpenDiagnostics={openDiagnostics}
        />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      <div className={`app-shell ${busy ? "busy" : ""}`}>
        <Sidebar
          view={view}
          history={desktop?.history}
          onView={navigate}
          onToggleRecording={toggleRecording}
        />
        <main className="content">
          <ConnectionNotice desktop={desktop} run={run} onOpenDiagnostics={openDiagnostics} />
          {error && (
            <div className="error-banner">
              <strong>{t("common.actionFailed")}</strong>
              <span>{error}</span>
              <button onClick={() => setError(undefined)}>{t("common.close")}</button>
            </div>
          )}
          {view === "timeline" ? (
            <TimelineView history={desktop?.history} run={run} />
          ) : view === "usage" ? (
            <UsageView usage={desktop?.history?.usage} />
          ) : (
            <DiagnosticsView
              history={desktop?.history}
              run={run}
              onBack={() => setView("settings")}
            />
          )}
        </main>
      </div>
    </I18nProvider>
  );
}
