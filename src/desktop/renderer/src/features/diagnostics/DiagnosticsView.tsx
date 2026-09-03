import type { HistorySnapshot } from "../../../../../shared/contracts/index.js";
import { PageHeader } from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";
import type { RunAction } from "../../app/types.js";

export function DiagnosticsView({
  history,
  run,
  onBack,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const health = history?.health;
  const rows = [
    [t("health.accessibility"), health?.accessibilityGranted],
    [t("health.globalInteractions"), health?.interactionMonitorActive],
    [t("health.axObserver"), health?.axObserverActive],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow={t("health.eyebrow")}
        title={t("health.title")}
        action={
          <div className="header-actions">
            <button className="secondary" onClick={onBack}>
              {t("health.backToSettings")}
            </button>
            <button
              className="secondary"
              onClick={() =>
                void run(() =>
                  health?.accessibilityGranted && !health.interactionMonitorActive
                    ? window.desklore.requestPermissions()
                    : window.desklore.refreshPermissions(),
                )
              }
            >
              {t("health.recheck")}
            </button>
          </div>
        }
      />
      <section className="health-layout">
        <div className="health-primary">
          {rows.map(([label, healthy]) => (
            <div className="health-row" key={label}>
              <span className={healthy ? "health-icon ok" : "health-icon warn"}>
                {healthy ? "✓" : "!"}
              </span>
              <div>
                <strong>{label}</strong>
              </div>
              <b>{healthy ? t("common.ready") : t("common.notReady")}</b>
            </div>
          ))}
          {!health?.accessibilityGranted && (
            <button
              className="permission-callout"
              onClick={() => void run(() => window.desklore.requestPermissions())}
            >
              <span>{t("health.permissionRequired")}</span>
              <strong>{t("health.openPermission")}</strong>
            </button>
          )}
        </div>
        <div className="metric-grid">
          <div>
            <span>{t("health.captureDuration")}</span>
            <strong>
              {Math.round(health?.lastAXCaptureDurationMilliseconds ?? 0)}
              <small> ms</small>
            </strong>
          </div>
          <div>
            <span>{t("health.semanticEvents")}</span>
            <strong>
              {(health?.keyboardSubmitCount ?? 0) +
                (health?.keyboardShortcutCount ?? 0) +
                (health?.textInputEventCount ?? 0)}
            </strong>
          </div>
          <div>
            <span>{t("health.captureQueue")}</span>
            <strong>{health?.axCaptureBacklog ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.enhancedAccessibility")}</span>
            <strong>{health?.enhancedAccessibilityRequestCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.rawEvents")}</span>
            <strong>{health?.capturedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.persisted")}</span>
            <strong>{health?.persistedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.policyBlocked")}</span>
            <strong>{health?.policyBlockedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.duplicatesDropped")}</span>
            <strong>{health?.deduplicatedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.eventsCoalesced")}</span>
            <strong>{health?.burstCoalescedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.axValueTargets")}</span>
            <strong>{health?.axValueNotificationTargets ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.axSelectionTargets")}</span>
            <strong>{health?.axSelectionNotificationTargets ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.returnKeys")}</span>
            <strong>{health?.returnKeyEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.submitEvents")}</span>
            <strong>{health?.keyboardSubmitCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.textInputEvents")}</span>
            <strong>{health?.textInputEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.selectionEvents")}</span>
            <strong>{health?.selectionEventCount ?? 0}</strong>
          </div>
        </div>
      </section>
    </>
  );
}
