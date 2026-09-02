# Changelog

## Unreleased

### Evidence

- The collector now sends Accessibility context as structured node snapshots and deltas instead
  of pre-rendered text. ServerCore renders the text, keeps the nodes in segment files, and gives
  model-facing consumers text only. Text-only segments written by earlier builds still load.

### Direction

- Redefined DeskLore as open-source personal context infrastructure: a local, cited, deletable
  memory of your work, used first by DeskLore and then by agents you trust. See
  `docs/DIRECTION.md` for the layer model and the current phase, which is collecting
  comprehensive context. README, website copy, and package metadata follow the new definition.

## 0.2.0 — 2026-08-26

DeskLore's second early source release makes Timeline Agent work durable, adds user-controlled
observation exclusions, and introduces a bilingual product surface and evaluation toolkit.

### Included

- A Pi-powered Timeline Agent with citation-validated summaries, persistent jobs, fair scheduling,
  bounded retry backoff, and Electron utility-process isolation.
- Configurable application, domain, and window-title exclusions, including an installed-app picker.
- Redesigned timeline, diagnostics, recovery, and tabbed settings surfaces in English and Simplified
  Chinese.
- Local capture, timeline, and visual-value evaluators with explicit completeness, provenance, and
  human-review boundaries.
- A bilingual project website and GitHub Pages deployment.
- OpenAI Responses and Chat Completions protocol support for optional model features.

### Reliability fixes

- Restored Timeline Agent summaries after worker startup and IPC failures.
- Corrected retry scheduling for stalled, runtime-blocked, and provider-blocked jobs.
- Reduced duplicate window-transition noise while preserving meaningful capture context.
- Centralized atomic owner-only writes for retained history state.

### Current limits

- macOS 14+ on Apple Silicon only.
- Source distribution only; no official signed or notarized binary yet.
- Included evaluators support local investigation; they do not establish product-quality claims
  without fresh controlled data and human review.

## 0.1.0 — 2026-08-23

DeskLore's first public source release.

### Included

- Native macOS semantic activity collection through Accessibility APIs.
- A local timeline with ten-minute, six-hour, and daily resolutions, plus search.
- Explicit first-run recording consent with independently authorized Collector access.
- Local JSONL and Markdown artifacts with deletion and retention controls.
- Sensitive-surface, private-browsing, and password-field filtering.
- Optional model summaries and visual fallback, both disabled by default.
- Separate `com.desklore.desktop` and `com.desklore.collector` bundle identifiers.

### Current limits

- macOS 14+ on Apple Silicon only.
- Source distribution only; no official signed or notarized binary yet.
- Application, window, and URL exclusion controls are planned after 0.1.0.
