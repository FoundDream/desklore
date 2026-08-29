import { useEffect, useMemo, useState } from "react";
import type { HistorySnapshot, TimelineDocument } from "../../../../../shared/contracts/index.js";
import { Icon } from "../../components/Icon.js";
import {
  ApplicationList,
  DaySwitcher,
  PageHeader,
  dateKey,
  durationLabel,
  summaryFailureLabel,
  timeLabel,
} from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";
import type { RunAction } from "../../app/types.js";

function ActivityRow({
  document,
  referenced,
  onAction,
}: {
  document: TimelineDocument;
  referenced: boolean;
  onAction: (action: "open" | "delete", id: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article className={`timeline-entry ${referenced ? "referenced" : ""}`}>
      <time>{timeLabel(document.startedAt, locale)}</time>
      <div className="entry-body">
        <div className="entry-title">
          <h3>{document.title}</h3>
        </div>
        <p>{document.description}</p>
        {document.generatorFailureReason && (
          <div className="summary-error" role="status">
            <strong>{t("summary.failed")}</strong>
            <span>
              {t("summary.retrying", {
                message: summaryFailureLabel(document.generatorFailureReason, t),
                reason: document.generatorFailureReason,
              })}
            </span>
          </div>
        )}
        <footer>
          <ApplicationList
            applications={document.applications}
            trailing={<span className="duration">{durationLabel(document, t)}</span>}
          />
          <div className="entry-actions">
            <button onClick={() => void onAction("open", document.id)}>
              {t("timeline.openRecord")}
            </button>
            <button
              className={confirmDelete ? "confirm" : ""}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => {
                if (confirmDelete) void onAction("delete", document.id);
                else setConfirmDelete(true);
              }}
            >
              {confirmDelete ? t("common.confirmDelete") : t("common.delete")}
            </button>
          </div>
        </footer>
      </div>
    </article>
  );
}

export function TimelineView({
  history,
  run,
  selectedDate,
  referencedDocumentIDs,
  onSelectDate,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  selectedDate?: string;
  referencedDocumentIDs: string[];
  onSelectDate: (date?: string) => void;
}) {
  const { t } = useI18n();
  const days = useMemo(() => {
    const groups = new Map<string, TimelineDocument[]>();
    const documents = [...(history?.documents ?? [])].sort(
      (lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt),
    );
    for (const document of documents) {
      const key = dateKey(document.startedAt);
      groups.set(key, [...(groups.get(key) ?? []), document]);
    }
    return [...groups.entries()].map(([date, documents]) => ({
      date,
      startedAt: documents[0].startedAt,
      documents,
    }));
  }, [history?.documents]);
  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0];
  const referencedDocuments = useMemo(
    () => new Set(referencedDocumentIDs),
    [referencedDocumentIDs],
  );

  useEffect(() => {
    if (selectedDate && days.some((day) => day.date === selectedDate)) return;
    onSelectDate(days[0]?.date);
  }, [days, onSelectDate, selectedDate]);

  const action = async (name: "open" | "delete", id: string): Promise<void> => {
    await run(() =>
      name === "open" ? window.desklore.openDocument(id) : window.desklore.deleteDocument(id),
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={t("timeline.eyebrow")}
        title={t("timeline.title")}
        action={
          <div className="header-actions">
            <button
              className="secondary"
              onClick={() => void run(() => window.desklore.revealStorage())}
            >
              <Icon name="folder" />
              {t("common.revealFiles")}
            </button>
            {selectedDay && (
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={onSelectDate} />
            )}
          </div>
        }
      />
      <section className="archive">
        {!history ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.connecting")}</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.empty")}</h2>
          </div>
        ) : selectedDay ? (
          <div className="day-group" key={selectedDay.date}>
            {selectedDay.documents.map((document) => (
              <ActivityRow
                key={document.id}
                document={document}
                referenced={referencedDocuments.has(document.id)}
                onAction={action}
              />
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}
