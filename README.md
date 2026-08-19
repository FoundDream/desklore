# Computer History

A local-first Electron desktop application that turns macOS activity into a
Markdown timeline. The product UI runs in React/Electron while a signed,
headless Swift Agent keeps native Accessibility capture and privacy-sensitive
processing outside the renderer.

It deliberately keeps the storage model small:

- Raw interaction evidence is appended to ten-minute JSONL segments.
- Noisy OS callbacks are normalized before storage: a drag is one event,
  unchanged window polling is suppressed, repeated click/window bursts carry an
  `occurrence_count`, and text/selection changes use short trailing debounce.
- Completed segments produce human-readable Markdown timeline documents.
- An optional Responses API summarizer produces strict-schema semantic titles,
  descriptions, lifecycle state, and evidence event IDs, with retries and
  rules-based fallback.
- The Electron UI receives sanitized timeline DTOs from the Swift Agent; there
  is no database and the renderer cannot read raw JSONL or API keys.
- Observation is enabled for all apps and domains by default. Settings can
  exclude the current app or domain at any time.

## Run

```sh
npm install
npm run dev
```

`npm run dev` first builds and signs the native Agent, then starts the
main/preload/renderer development loop through
`electron-vite-plus@0.1.0-alpha.0`.

To build each layer without launching the UI:

```sh
npm run build
```

This produces `out/main`, `out/preload`, `out/renderer`, and the signed
`dist/Computer History Agent.app`. Run `npm run preview -- --skip-build` to
exercise those production outputs. `npm run package:mac` adds the downstream
electron-builder step for DMG/ZIP artifacts under `release/`.

The Electron app and native Agent use independent bundle identifiers. Set
`COMPUTER_HISTORY_CODESIGN_IDENTITY` to use a Developer ID or Apple Development
identity for distributable builds; the default identifier-only ad-hoc signature
is intended for local development. This version starts with independent storage,
settings, Keychain secrets, and macOS privacy grants; it does not import state
from the former SwiftUI application.

On first launch, grant Accessibility access when macOS prompts. Recording starts
for all apps and domains automatically; use **设置 → 当前观察范围** to exclude
the active app or domain. Accessibility trust also allows the read-only global
`NSEvent` monitor to observe Return and modified shortcuts; a separate Input
Monitoring permission is not required. The **采集健康** page reports Accessibility,
AX observer/subscription status, and separate Return, submit, shortcut, text, and
selection counters. It also reports the latest AX tree node/visit counts, capture
latency, queue depth, slow captures, and truncated captures. The first timeline
Markdown file is generated when its ten-minute segment closes.

## Architecture

```text
React renderer (timeline, health, settings)
        ↕ narrow contextBridge API
Electron main (window, tray, lifecycle, validated IPC)
        ↕ newline-delimited JSON over stdio
Signed Swift Agent
        ├── AppKit / AX / NSEvent collectors
        ├── privacy policy and Keychain
        ├── JSONL segments and Markdown timeline
        └── LLM summarizer and evaluator
```

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, a
sandbox, and a local-only CSP. It receives summary documents and capture health,
not raw events. Main-process IPC exposes explicit commands rather than passing
`ipcRenderer` or arbitrary file paths through preload.

## LLM summaries

Open **设置 → 语义摘要**, enter a Responses API model, endpoint, and API key,
then enable semantic summaries. The renderer sends the key directly through the
narrow bridge to the Swift Agent, which stores it in macOS Keychain; only the
model and endpoint are saved in `UserDefaults`. The default model is
`gpt-5.6-luna`, and `OPENAI_API_KEY` is also supported for development launches.

Model output is constrained by strict JSON Schema. Evidence IDs are checked
against the exact input segment before writing Markdown. A full quality gate also
requires application, time-range, event-kind, and lifecycle support. Model output
that misses that gate is persisted as an explicit `rules-quality-fallback` instead
of a misleading semantic summary. Authentication errors fall back immediately;
transient errors and invalid model evidence are retried before falling back to the
deterministic rules summarizer. Fallback Markdown is upgraded in place only after
a later model result passes the same gate; document IDs, timestamps, and file paths
stay stable.

Every new Markdown document can include `activity_state`: `researching`,
`planning`, `implementation_started`, `implementation_completed`, `validated`,
`blocked`, or `unknown`. A deterministic evidence check rejects summaries that
regress an observed implementation/build/test milestone back to research or
planning.

Before the API call, semantic sampling guarantees representation for milestone
and rich AX evidence, briefly visited applications, and rare actions such as
submit/shortcut/drag, then fills the remaining budget with app transitions and
chronological coverage. Local Markdown can retain up to 48,000 characters of
sanitized AX context per event; the model request is independently capped at
12,000 characters per event.

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

Timeline generation is serialized per source segment and rechecks the Markdown
directory before its atomic write. If interrupted work produces duplicate
documents, the UI chooses one best summary using integrity and quality evidence.

Data is written to:

```text
~/Library/Application Support/ComputerHistoryDesktop/
  segments/<utc-segment-id>/events.jsonl
  segments/<utc-segment-id>/metadata.json
  timeline/<utc-segment-id>-<id>-10min-<slug>.md
```

## Verify

```sh
npm run check
npm test
npm run build
npm run doctor
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
selections, mouse targets, submissions, and keyboard shortcuts. Rich captures use
`AXTree v2`: stable node IDs, parent/depth/sibling relationships, control states,
bounded safe scalar values, and node-level add/remove/update/move diffs. Traversal
prioritizes the focused path, web/document roots, editable controls, and meaningful
interactive nodes. AX reads are serialized off the main thread; lightweight polls
skip the rich tree. Browser URL discovery walks accessible web/document nodes. It
watches the Markdown directory for edits, recovers interrupted segments, passes
the two previous summaries into the next LLM request for continuity, and removes
raw segments after 48 hours. Range-based clearing and a full observation-rule
editor remain follow-up work.

Electron is now the primary product entry and owns the window, tray, timeline,
capture-health dashboard, observation controls, and LLM settings. macOS capture
remains in the separately signed Swift Agent so Electron upgrades do not couple
AX behavior to Node native-module ABI changes. Windows UI Automation and Linux
AT-SPI collectors remain future platform work.
