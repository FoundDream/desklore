import { useEffect, useMemo, useState } from "react";
import type {
  HistorySearchResponse,
  HistorySnapshot,
  MemoryRollup,
} from "../../../../../shared/contracts/index.js";
import { Icon } from "../../components/Icon.js";
import {
  ApplicationList,
  ContinuationHint,
  DaySwitcher,
  PageHeader,
  dateKey,
  timeLabel,
  type DatedGroup,
  type Translate,
} from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";
import type { RunAction } from "../../app/types.js";

interface MemoryDay extends DatedGroup {
  daily?: MemoryRollup;
  periods: MemoryRollup[];
}

function memoryRangeLabel(memory: MemoryRollup, locale: "en" | "zh-CN"): string {
  return `${timeLabel(memory.startedAt, locale)}–${timeLabel(memory.endedAt, locale)}`;
}

function searchKindLabel(kind: "10min" | "6h" | "day", t: Translate): string {
  if (kind === "day") return t("memory.dailyOverview");
  if (kind === "6h") return t("memory.activitySummary");
  return t("memory.timeline");
}

function visibleSearchAnswer(answer: string): string {
  return answer.replace(/\s+\[(?:10min|6h|day):[^\]]+\]/g, "");
}

function MemorySourceFooter({
  memory,
  onOpenTimeline,
}: {
  memory: MemoryRollup;
  onOpenTimeline: (memory: MemoryRollup) => void;
}) {
  const { t } = useI18n();
  if (memory.sourceDocumentIDs.length === 0 && memory.applications.length === 0) return null;
  return (
    <footer className="memory-source">
      <ApplicationList applications={memory.applications} />
      {memory.sourceDocumentIDs.length > 0 && (
        <div className="memory-source-meta">
          <span>{t("memory.basedOnActivities", { count: memory.sourceDocumentIDs.length })}</span>
          <button onClick={() => onOpenTimeline(memory)}>{t("memory.viewTimeline")}</button>
        </div>
      )}
    </footer>
  );
}

export function MemoryView({
  history,
  run,
  onOpenTimeline,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  onOpenTimeline: (memory: MemoryRollup) => void;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<HistorySearchResponse>();
  const [searching, setSearching] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>();
  const days = useMemo(() => {
    const memories = history?.memories ?? [];
    const periods = memories.filter((memory) => memory.kind === "6h");
    const coveredPeriods = new Set<string>();
    const groups: MemoryDay[] = memories
      .filter((memory) => memory.kind === "day")
      .map((daily) => {
        const startedAt = Date.parse(daily.startedAt);
        const endedAt = Date.parse(daily.endedAt);
        const matchingPeriods = periods
          .filter((period) => {
            const periodStart = Date.parse(period.startedAt);
            const matches = periodStart >= startedAt && periodStart < endedAt;
            if (matches) coveredPeriods.add(period.id);
            return matches;
          })
          .sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt));
        return {
          date: daily.id,
          startedAt: daily.startedAt,
          daily,
          periods: matchingPeriods,
        };
      });

    const fallbackGroups = new Map<string, MemoryRollup[]>();
    for (const period of periods) {
      if (coveredPeriods.has(period.id)) continue;
      const key = dateKey(period.startedAt);
      fallbackGroups.set(key, [...(fallbackGroups.get(key) ?? []), period]);
    }
    for (const [key, fallbackPeriods] of fallbackGroups) {
      fallbackPeriods.sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt));
      groups.push({
        date: `periods-${key}`,
        startedAt: fallbackPeriods[0].startedAt,
        periods: fallbackPeriods,
      });
    }
    return groups.sort((lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt));
  }, [history?.memories]);
  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0];

  useEffect(() => {
    if (selectedDate && days.some((day) => day.date === selectedDate)) return;
    setSelectedDate(days[0]?.date);
  }, [days, selectedDate]);

  const submitSearch = async (): Promise<void> => {
    const value = query.trim();
    if (!value) {
      setSearch(undefined);
      return;
    }
    setSearching(true);
    try {
      setSearch(await window.desklore.searchMemory(value));
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t("memory.eyebrow")}
        title={t("memory.title")}
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
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={setSelectedDate} />
            )}
          </div>
        }
      />
      <section className="memory-search">
        <div>
          <span className="section-kicker">{t("memory.searchKicker")}</span>
          <h2>{t("memory.searchTitle")}</h2>
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
            placeholder={t("memory.searchPlaceholder")}
            maxLength={500}
          />
          <button disabled={searching}>
            {searching ? t("memory.searching") : t("memory.search")}
          </button>
        </form>
        {search && (
          <div className="memory-answer">
            <p>{visibleSearchAnswer(search.answer)}</p>
            {search.matches.length > 0 && (
              <div>
                {search.matches.slice(0, 5).map((match) => (
                  <span key={`${match.kind}-${match.id}`}>
                    {searchKindLabel(match.kind, t)} · {match.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <section className="memory-archive">
        {!history ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("memory.connecting")}</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("memory.empty")}</h2>
          </div>
        ) : selectedDay ? (
          <div className="memory-day" key={selectedDay.date}>
            {selectedDay.daily && (
              <article className="daily-memory">
                <span className="section-kicker">{t("memory.dailyOverview")}</span>
                <h2>{selectedDay.daily.title}</h2>
                <p>{selectedDay.daily.description}</p>
                <ContinuationHint item={selectedDay.daily.continuationHint} />
                <MemorySourceFooter memory={selectedDay.daily} onOpenTimeline={onOpenTimeline} />
              </article>
            )}
            {selectedDay.periods.length > 0 && (
              <section className="memory-periods">
                <header>
                  <div>
                    <span className="section-kicker">{t("memory.byTime")}</span>
                    <h2>{t("memory.activitySummary")}</h2>
                  </div>
                  <span>{t("memory.periodCount", { count: selectedDay.periods.length })}</span>
                </header>
                <div>
                  {selectedDay.periods.map((memory) => (
                    <details className="memory-period" key={memory.id}>
                      <summary>
                        <time>{memoryRangeLabel(memory, locale)}</time>
                        <div>
                          <h3>{memory.title}</h3>
                          <p>{memory.description}</p>
                        </div>
                        <span>{t("common.details")}</span>
                      </summary>
                      <div className="memory-period-details">
                        <ContinuationHint item={memory.continuationHint} />
                        <MemorySourceFooter memory={memory} onOpenTimeline={onOpenTimeline} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}
