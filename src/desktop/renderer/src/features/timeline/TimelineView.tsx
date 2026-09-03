import { useEffect, useMemo, useState } from "react";
import type {
  HistorySearchMatch,
  HistorySearchResponse,
  HistorySnapshot,
  TimelineDocument,
  TimelineRollup,
} from "../../../../../shared/contracts/index.js";
import { Icon } from "../../components/Icon.js";
import {
  ApplicationList,
  DaySwitcher,
  PageHeader,
  dateKey,
  durationLabel,
  summaryFailureLabel,
  timeLabel,
  type DatedGroup,
  type Translate,
} from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";
import type { RunAction } from "../../app/types.js";
import { TimelineRollupView } from "./TimelineRollupView.js";

type TimelineResolution = "10min" | "6h" | "day";

interface TimelineDay extends DatedGroup {
  documents: TimelineDocument[];
  sixHourRollups: TimelineRollup[];
  dailyRollups: TimelineRollup[];
}

function searchKindLabel(kind: TimelineResolution, t: Translate): string {
  if (kind === "day") return t("timeline.dailyOverview");
  if (kind === "6h") return t("timeline.sixHourSummary");
  return t("timeline.tenMinuteDetail");
}

function visibleSearchAnswer(answer: string): string {
  return answer.replace(/\s+\[(?:10min|6h|day):[^\]]+\]/g, "");
}

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

export function TimelineView({ history, run }: { history?: HistorySnapshot; run: RunAction }) {
  const { t } = useI18n();
  const [resolution, setResolution] = useState<TimelineResolution>("10min");
  const [selectedDate, setSelectedDate] = useState<string>();
  const [referencedDocumentIDs, setReferencedDocumentIDs] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<HistorySearchResponse>();
  const [searching, setSearching] = useState(false);

  const days = useMemo(() => {
    const groups = new Map<string, TimelineDay>();
    const ensureDay = (startedAt: string): TimelineDay => {
      const date = dateKey(startedAt);
      const existing = groups.get(date);
      if (existing) return existing;
      const day = { date, startedAt, documents: [], sixHourRollups: [], dailyRollups: [] };
      groups.set(date, day);
      return day;
    };
    for (const document of history?.documents ?? [])
      ensureDay(document.startedAt).documents.push(document);
    for (const rollup of history?.rollups ?? []) {
      const day = ensureDay(rollup.startedAt);
      if (rollup.kind === "6h") day.sixHourRollups.push(rollup);
      else day.dailyRollups.push(rollup);
    }
    for (const day of groups.values()) {
      day.documents.sort((lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt));
      day.sixHourRollups.sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt));
      day.dailyRollups.sort((lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt));
    }
    return [...groups.values()].sort(
      (lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt),
    );
  }, [history?.documents, history?.rollups]);

  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0];
  const referencedDocuments = useMemo(
    () => new Set(referencedDocumentIDs),
    [referencedDocumentIDs],
  );

  useEffect(() => {
    if (selectedDate && days.some((day) => day.date === selectedDate)) return;
    setSelectedDate(days[0]?.date);
    setReferencedDocumentIDs([]);
  }, [days, selectedDate]);

  const action = async (name: "open" | "delete", id: string): Promise<void> => {
    await run(() =>
      name === "open" ? window.desklore.openDocument(id) : window.desklore.deleteDocument(id),
    );
  };

  const selectDate = (date?: string): void => {
    setSelectedDate(date);
    setReferencedDocumentIDs([]);
  };

  const selectResolution = (next: TimelineResolution): void => {
    setResolution(next);
    setReferencedDocumentIDs([]);
  };

  const openSearchMatch = (match: HistorySearchMatch): void => {
    setSelectedDate(dateKey(match.startedAt));
    setResolution(match.kind);
    setReferencedDocumentIDs(match.kind === "10min" ? match.sourceDocumentIDs : []);
  };

  const submitSearch = async (): Promise<void> => {
    const value = query.trim();
    if (!value) {
      setSearch(undefined);
      return;
    }
    setSearching(true);
    try {
      setSearch(await window.desklore.searchHistory(value));
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PageHeader
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
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={selectDate} />
            )}
          </div>
        }
      />

      <div className="timeline-resolution" role="tablist" aria-label={t("timeline.resolution")}>
        {(["10min", "6h", "day"] as const).map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={resolution === item}
            className={resolution === item ? "active" : ""}
            onClick={() => selectResolution(item)}
          >
            {searchKindLabel(item, t)}
          </button>
        ))}
      </div>

      <section className="history-search">
        <div>
          <span className="section-kicker">{t("timeline.searchKicker")}</span>
          <h2>{t("timeline.searchTitle")}</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitSearch();
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("timeline.searchPlaceholder")}
            maxLength={500}
          />
          <button disabled={searching}>
            {searching ? t("timeline.searching") : t("timeline.search")}
          </button>
        </form>
        {search && (
          <div className="history-answer">
            <p>{visibleSearchAnswer(search.answer)}</p>
            {search.matches.length > 0 && (
              <div>
                {search.matches.slice(0, 5).map((match) => (
                  <button key={`${match.kind}-${match.id}`} onClick={() => openSearchMatch(match)}>
                    {searchKindLabel(match.kind, t)} · {match.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {!history ? (
        <section className="archive">
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.connecting")}</h2>
          </div>
        </section>
      ) : days.length === 0 ? (
        <section className="archive">
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.empty")}</h2>
          </div>
        </section>
      ) : selectedDay && resolution === "10min" ? (
        <section className="archive">
          {selectedDay.documents.length > 0 ? (
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
          ) : (
            <div className="empty-state">
              <div className="empty-clock" />
              <h2>{t("timeline.noTenMinuteDetail")}</h2>
            </div>
          )}
        </section>
      ) : selectedDay ? (
        <TimelineRollupView
          kind={resolution === "6h" ? "6h" : "day"}
          rollups={resolution === "6h" ? selectedDay.sixHourRollups : selectedDay.dailyRollups}
        />
      ) : null}
    </>
  );
}
