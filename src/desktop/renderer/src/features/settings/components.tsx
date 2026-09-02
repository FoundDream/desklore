import { useEffect, useRef, type ReactNode } from "react";
import type {
  InstalledApplication,
  ObservationPolicy,
} from "../../../../../shared/contracts/index.js";
import { useI18n } from "../../app/i18n.js";

export function SettingsSection({
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

export function SettingRow({
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

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return <span className={`setting-status setting-status-${tone}`}>{children}</span>;
}

export function InstalledApplicationIcon({ application }: { application: InstalledApplication }) {
  const source = application.iconDataURL;
  return (
    <span className={`settings-application-icon${source ? "" : " fallback"}`} aria-hidden="true">
      {source ? <img src={source} alt="" /> : application.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export function applicationIsExcluded(
  policy: ObservationPolicy,
  bundleIdentifier: string,
): boolean {
  if (policy.blockedBundleIdentifiers.includes(bundleIdentifier)) return true;
  return (
    policy.defaultApplicationBehavior === "do_not_observe" &&
    !policy.allowedBundleIdentifiers.includes(bundleIdentifier)
  );
}

export function SettingsDialog({
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
