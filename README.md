# Computer History Timeline

A local-first macOS prototype that turns application activity into a
Markdown timeline. It deliberately keeps the storage model small:

- Raw interaction evidence is appended to ten-minute JSONL segments.
- Noisy OS callbacks are normalized before storage: a drag is one event,
  unchanged window polling is suppressed, repeated click/window bursts carry an
  `occurrence_count`, and text/selection changes use short trailing debounce.
- Completed segments produce human-readable Markdown timeline documents.
- An optional Responses API summarizer produces strict-schema semantic titles,
  descriptions, lifecycle state, and evidence event IDs, with retries and
  rules-based fallback.
- The UI rebuilds its in-memory index from Markdown; there is no database.
- Observation is enabled for all apps and domains by default. The menu bar can
  exclude the current app or domain at any time.

## Run

```sh
swift run ComputerHistoryApp
```

For a stable local app bundle and Accessibility identity:

```sh
./scripts/build-app.sh
open "dist/Computer History.app"
```

On first launch, grant Accessibility access when macOS prompts. Recording starts
for all apps and domains automatically; use the menu bar to exclude sensitive
apps or domains. Accessibility trust also allows the read-only global `NSEvent`
monitor to observe Return and modified shortcuts; a separate Input Monitoring
permission is not required. The **采集健康** section reports Accessibility,
listener status, and the most recent keyboard semantic event. The first timeline
Markdown file is generated when its ten-minute segment closes.

## LLM summaries

Open the menu bar item, expand **模型摘要**, enter a Responses API model,
endpoint, and API key, then enable semantic summaries. The API key is stored in
macOS Keychain; only the model and endpoint are saved in `UserDefaults`. The
default model is `gpt-5.6-luna`, and `OPENAI_API_KEY` is also supported for
development launches.

Model output is constrained by strict JSON Schema. Evidence IDs are checked
against the exact input segment before writing Markdown. Authentication errors
fall back immediately; transient errors and invalid model evidence are retried
before falling back to the deterministic rules summarizer. Fallback Markdown is
marked explicitly and upgraded in place when the model becomes available again;
document IDs, timestamps, and file paths stay stable.

Every new Markdown document can include `activity_state`: `researching`,
`planning`, `implementation_started`, `implementation_completed`, `validated`,
`blocked`, or `unknown`. A deterministic evidence check rejects summaries that
regress an observed implementation/build/test milestone back to research or
planning.

Before the API call, semantic sampling guarantees representation for milestone
and rich AX evidence, briefly visited applications, and rare actions such as
submit/shortcut/drag, then fills the remaining budget with app transitions and
chronological coverage.

## Privacy boundaries

- URL credentials, query parameters, and fragments are removed before disk/API.
- Common API keys, bearer tokens, password assignments, and card numbers are
  redacted before disk/API.
- Secure fields, password/token-labelled controls, and private browser windows
  are excluded from text capture.
- Ordinary keystrokes are not logged. Text changes come from allowed AX fields;
  the global monitor records only mouse actions, Return, and modified shortcuts.
- AX context snapshots contain a bounded structural tree with roles, labels,
  descriptions, help text, and safe scalar values; secure or sensitive controls
  are still excluded.

Data is written to:

```text
~/Library/Application Support/ComputerHistory/
  segments/<utc-segment-id>/events.jsonl
  segments/<utc-segment-id>/metadata.json
  timeline/<utc-segment-id>-<id>-10min-<slug>.md
```

## Verify

```sh
swift test
swift build
swift run ComputerHistoryEval /path/to/events.jsonl /path/to/timeline.md
```

The evaluator exits non-zero for unknown evidence IDs, unsupported applications
named in the prose, empty evidence, or detected sensitive residuals. Its quality
gate also checks timeline-bucket coverage, evidence-kind diversity, and generic
titles/descriptions, plus lifecycle-state support from captured evidence.

## Current scope

The recorder observes application/window changes, safe AX text changes and
selections, bounded AX tree snapshots/diffs, mouse targets, submissions, and keyboard
shortcuts. Browser URL discovery walks accessible web/document nodes. It watches
the Markdown directory for edits, recovers interrupted segments, passes the two
previous summaries into the next LLM request for continuity, and removes raw
segments after 48 hours. Range-based clearing and a full observation-rule editor
remain follow-up work.
