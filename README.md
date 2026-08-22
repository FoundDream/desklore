# Computer History

A local-first Electron desktop application that turns macOS activity into a
searchable Markdown timeline. React/Electron owns the product and storage while a
separately signed, headless Swift Agent owns the native Accessibility boundary.

The storage model stays deliberately small:

- Raw semantic evidence is appended to ten-minute JSONL segments. Optional visual
  decisions are appended separately and joined by event ID when the segment is read.
- Periodic polling never emits events. Window, focus, AX value/selection, mouse,
  and keyboard callbacks carry a semantic `capture_reason`; duplicate callbacks
  and short bursts are normalized before persistence.
- Segment metadata distinguishes captured, persisted, policy-blocked,
  deduplicated, and burst-coalesced events so capture loss is observable.
- Completed segments produce schema-v4 Markdown with a title, stand-alone activity
  summary, optional continuation hint, and evidence-linked claims. The old task,
  progression, outcome, open-loop, and activity-state fields are not retained.
- Six-hour and daily Markdown rollups form a deterministic local memory layer.
  A six-hour rollup is materialized only after its time range has ended; daily
  memory is rebuilt from those completed ranges. An independent opt-in can
  synthesize them with the configured model; source fingerprints prevent repeat
  calls. Retrieval searches all three granularities and returns source
  document/segment IDs.
- Optional Responses API summaries use strict JSON Schema, bounded retries, exact
  evidence validation, and a deterministic raw fallback.
- There is no database. The sandboxed renderer receives summary DTOs and cannot
  read raw JSONL or API keys.

## Run

```sh
npm install
npm run dev
```

`npm run dev` builds and signs the native Agent, then starts the
main/preload/renderer development loop. To build without launching the UI:

```sh
npm run build
```

This produces `out/main`, `out/preload`, `out/renderer`, and the signed
`dist/Computer History Agent.app`. `npm run package:mac` adds the downstream
electron-builder step for DMG/ZIP artifacts under `release/`.

The Electron app and native Agent use independent bundle identifiers. Set
`COMPUTER_HISTORY_CODESIGN_IDENTITY` for a Developer ID or Apple Development
identity; the default identifier-only ad-hoc signature is for local development.

On first launch, grant Accessibility access when macOS prompts. Screen Recording
permission is requested only if the optional window-screenshot fallback is enabled.
Recording starts for all apps and domains; use **设置 → 当前观察范围** to exclude the current app
or domain. The **采集健康** page reports native listener health, capture latency,
queue depth, and raw/persisted/blocked/deduplicated/coalesced event counts.

## Architecture

```text
React renderer (timeline, local search, health, settings)
        ↕ narrow contextBridge API
Electron main
        ├── validated IPC and lifecycle
        ├── observation policy and encrypted API-key storage
        ├── coalescing, JSONL segments and Markdown timeline
        ├── AX sufficiency judge and optional visual-provider orchestration
        ├── LLM summary generation and evidence validation
        └── six-hour/day memory rollups and retrieval
        ↕ newline-delimited JSON over stdio
Signed Swift Agent
        ├── AppKit / AX / NSEvent capture and native redaction
        └── optional ScreenCaptureKit window provider and local Vision OCR
```

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, a
sandbox, and a local-only CSP. Main-process IPC exposes explicit commands rather
than arbitrary file paths or `ipcRenderer`.

## Capture semantics

AX notifications are primary. A one-second safe-value fallback detects apps that
fail to publish value/selection notifications without producing window-poll
events. Rich captures use `AXTree v2`: stable node IDs, parent/depth/sibling
relationships, control state, bounded safe scalar values, and node-level
add/remove/update/move diffs. AX reads are serialized off the main thread.

Return is classified from modifiers and the captured AX target. Shift/Option +
Return remains a shortcut; command/control Return, single-line inputs, labelled
chat inputs, and known chat text areas become `keyboard.submit`.

## Optional visual evidence

Open **设置 → 视觉证据** to enable any part of this chain. It is default-off:

```text
policy-filtered event
  → clear AX rules
  → Luna only for uncertain AX evidence (optional)
  → screenshot provider only when AX remains insufficient (optional)
  → local OCR or Luna image understanding (optional)
  → event-linked evidence.jsonl
```

The orchestrator depends on a small visual-provider contract rather than
ScreenCaptureKit directly. The bundled provider captures the exact macOS window by
runtime window ID, with a title/unique-window fallback that refuses ambiguous
matches. Capture requests expire eight seconds after the source event; stale or
ambiguous targets are recorded as visual gaps instead of capturing another window.

Raw pixels are never written to segment files or exposed to the renderer. Local-only
capture and OCR remain inside the signed native Agent. Luna image understanding is
an independent opt-in: the Agent applies OCR-based secret-pattern masking before
returning a transient image to Electron main, which sends it with the configured
Responses API credentials and persists only the bounded result.

Raw segments are retained for 48 hours. Interrupted segments are recovered on
startup and during maintenance. Ten-minute summaries retain source event IDs;
six-hour and daily memories retain source document and source segment IDs.

## LLM summaries

Open **设置 → 语义摘要**, enter a Responses API model, endpoint, and API key,
then enable semantic summaries. Electron main encrypts the key with
`safeStorage`; only model settings are saved as JSON. `OPENAI_API_KEY` is also
supported for development launches.

Every schema-v4 model claim must cite supplied event IDs. Document-level evidence
is also checked against the exact sampled segment. Invalid or transient responses
retry with progressively smaller inputs; otherwise an explicit raw fallback is
persisted and can later be upgraded in place.

Summaries use a stand-alone title and narrative description rather than task,
progress, result, and unfinished-work fields. A single optional continuation hint
is kept only when the observed activity explicitly supports a concrete next action.
Prior summaries are continuity hints only and cannot support claims about the
current segment.

**模型归纳长期记忆** is a separate, default-off setting. When enabled, local
ten-minute summaries are sent to the same endpoint to synthesize the 6-hour/day
narrative. Exact source citations are appended by local code, and unchanged source
fingerprints reuse the existing rollup without another API call.

## Privacy boundaries

- URL credentials, query parameters, and fragments are removed before disk/API.
- API keys, bearer tokens, password assignments, and card numbers are redacted.
- Secure fields, password/token-labelled controls, and private browser windows are
  excluded from text capture.
- Ordinary keystrokes are not logged. Text comes from allowed AX fields; the
  global monitor records only mouse actions, Return, navigation keys, and
  modified shortcuts.
- Raw events, timeline documents, rollups, and search stay local. Semantic
  summaries send policy-filtered, redacted, byte-bounded event samples; the
  independent long-term-memory toggle sends existing ten-minute summaries.
- Visual capture is default-off and runs only after application/domain policy.
  Capture permission is never prompted by an event. A user action enables it;
  denied, stale, ambiguous, and provider-missing cases remain explicit gaps.
- App-owned directories are mode `0700` and files are mode `0600`. Existing files
  are tightened on startup without following symbolic links.

Data is written to:

```text
~/Library/Application Support/ComputerHistoryDesktop/
  segments/<utc-segment-id>/events.jsonl
  segments/<utc-segment-id>/evidence.jsonl  # optional, no pixels
  segments/<utc-segment-id>/metadata.json
  timeline/<utc-segment-id>-<id>-10min-<slug>.md
  memory/6h/<bucket>-6h-memory.md
  memory/day/<bucket>-day-memory.md
```

## Paired evaluation against Codex

Compare the candidate and Codex Skysight over identical completed ten-minute
buckets:

```sh
npm run eval:history -- \
  --reference "$CODEX_COMPUTER_HISTORY_ROOT" \
  --candidate "$HOME/Library/Application Support/ComputerHistoryDesktop"
```

The ignored `.eval-data/history/report.json` and `report.md` contain both the
overall retained-data result and a recent 12-segment slice. Matching uses bundle
identifiers, reports exact and default ±2-second one-to-one matches, and breaks
precision/recall/F1 down by event kind. The report also surfaces per-segment
scores, the largest kind/application count gaps, capture-reason counts, unstable
application identities, and kinds seen only in the reference. The development
Electron host and this app's packaged bundle are excluded by default because the
native collector does not observe itself. Use `--tolerance-ms`,
`--recent-segments`, `--since`, or `--exclude-bundles id.one,id.two` to adjust
those boundaries. Keep the candidate and reference running together for
meaningful paired results; use `--since` after deploying a collector change so
older implementations do not dominate the score.

## Verify

```sh
npm run check
npm test
npm run build
npm run doctor
npm run eval:history -- --reference /path/to/Skysight
swift test
swift build
```

Windows UI Automation and Linux AT-SPI collectors, range-based clearing, and a
full observation-rule editor remain future work.
