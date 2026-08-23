<div align="center">
  <img src="build/icon.png" width="128" alt="DeskLore app icon">
  <h1>DeskLore</h1>
  <p><strong>Open-source Computer History for macOS.</strong></p>
  <p>Semantic activity events first. No continuous screen recording. Local by default.</p>
  <p><a href="README.zh-CN.md">简体中文</a></p>
</div>

<p align="center">
  <img src="docs/assets/desklore-timeline.png" alt="DeskLore timeline showing synthetic launch activity">
</p>
<p align="center"><sub>Real DeskLore interface with a fully synthetic activity history.</sub></p>

DeskLore turns ordinary Mac activity into a searchable timeline and layered personal memory. It
uses macOS Accessibility semantics instead of continuously recording the screen. An optional
visual fallback exists for gaps in Accessibility evidence, but it is disabled by default.

> **Status:** [`0.1.0`](https://github.com/FoundDream/desklore/releases/tag/v0.1.0) is an early
> source release for macOS 14+ on Apple Silicon. There is no official signed binary yet.

## Why DeskLore

- **History is the product.** The core output is a readable timeline and local memory, not a raw
  recording archive or a general agent platform.
- **Semantic capture first.** App, window, interaction, URL, and Accessibility context are
  normalized into evidence-aware events.
- **Local-first storage.** Raw events, Markdown timelines, memory rollups, settings, and encrypted
  API credentials stay on your Mac unless you explicitly enable a model-backed feature.
- **Explicit recording consent.** The native collector does not start before the first-run consent
  screen is accepted.
- **Inspectable artifacts.** Timeline and memory outputs are Markdown files with source IDs and
  deterministic fallbacks.

## Privacy defaults

After explicit consent, DeskLore observes ordinary applications and URLs by default. It excludes
DeskLore itself, sensitive macOS system surfaces, private-browsing windows, and password-like
fields. Recording can be paused at any time.

| Capability          | Default          | Network                              | Retention                                      |
| ------------------- | ---------------- | ------------------------------------ | ---------------------------------------------- |
| Semantic events     | On after consent | None                                 | Raw segments: 48 hours                         |
| Timeline and memory | On               | None with deterministic summaries    | Until deleted                                  |
| Visual fallback     | Off              | None for capture; optional model use | Text evidence: 24 hours; pixels are not stored |
| Model summaries     | Off              | User-configured HTTPS endpoint       | Generated Markdown stays local                 |
| Telemetry           | Not included     | None                                 | N/A                                            |

Deleting a timeline item also deletes its source segment and related visual evidence; affected
memory rollups are regenerated without it. **Clear all history** removes raw events, timelines,
memory, and visual evidence, then leaves recording paused. See [PRIVACY.md](PRIVACY.md) for the
complete boundary.

## Requirements

- macOS 14 or newer
- Apple Silicon
- Node.js 24+
- pnpm 11+
- Xcode Command Line Tools with Swift 6.2+

## Run from source

```bash
git clone https://github.com/FoundDream/desklore.git
cd desklore
pnpm install --frozen-lockfile
pnpm dev
```

On first launch, DeskLore remains stopped until you accept the local recording boundary. macOS
then asks for Accessibility permission for **DeskLore Collector**, the embedded native capture
component. Screen Recording permission is requested only if you later enable visual fallback.

Useful commands:

```bash
pnpm check           # format, lint, and TypeScript checks
pnpm test            # renderer/main tests and evaluator tests
swift test          # native collector/core tests
pnpm build           # production Electron and Swift build
pnpm package:mac     # local DMG and ZIP; signing depends on your keychain
```

## Capture-safe demo data

The repository includes a deterministic synthetic history generator for screenshots, UI review,
and onboarding checks. It writes only under a marked child directory of the checkout; the desktop
app refuses an unmarked demo root and refuses a path inside the normal macOS application-data
directory.

```bash
pnpm demo             # seed two synthetic timeline sessions and launch the UI
pnpm demo:onboarding  # create an isolated first-run root for the onboarding state
DESKLORE_DEMO_ROOT="$PWD/.desklore-onboarding" pnpm dev:ui
```

The demo contains fixed Example Writer, Example Browser, and Example Terminal events. Demo mode
uses an inert collector, so it does not read the normal DeskLore history directory or capture new
activity. It also does not enable model-backed features. Demo files are ignored by Git and should
not be committed. The demo workflow validates UI state and privacy boundaries; it is not evidence
of capture quality or external adoption.

## Architecture

```text
React renderer
  -> narrow preload API and validated IPC
  -> Electron main process
     -> policy, coalescing, storage, timeline, memory, optional model calls
     -> NDJSON over stdio
        -> DeskLore Collector (Swift)
           -> Accessibility, AXObserver, NSWorkspace, global interaction events
           -> native redaction, optional ScreenCaptureKit fallback
```

The renderer receives sanitized DTOs only. API keys and raw JSONL never enter the renderer.
Collector and UI have separate bundle identifiers so macOS can sign and authorize the native
capture boundary independently.

Local data lives at:

```text
~/Library/Application Support/DeskLore/history/
  segments/       # 10-minute raw JSONL buckets, retained for 48 hours
  timeline/       # derived Markdown timeline cards
  memory/6h/      # six-hour Markdown rollups
  memory/day/     # daily Markdown rollups
  state/          # consent, policy, visual, and model settings
```

Files are created with owner-only permissions where supported. DeskLore does not add application-
level encryption to timeline or memory files; use macOS FileVault if disk-at-rest protection is
required.

DeskLore 0.1.0 intentionally starts with a new, versioned local schema. It does not import data or
unversioned settings created by pre-release Computer History builds.

## Optional model features

DeskLore works without an API key. Deterministic rules create timeline and memory artifacts
offline. If you enable model summaries, DeskLore sends filtered evidence to the HTTPS endpoint you
configure. API keys are encrypted with Electron `safeStorage` and are not exposed to the renderer.

Visual fallback has three independently configured parts:

1. AX sufficiency judgment (`rules` by default, optional model judgment).
2. Window capture (`off` by default).
3. Understanding (`off`, local OCR, or an explicitly configured model).

Raw screenshots stay in memory and are not written to event files. See
[docs/EVALUATION.md](docs/EVALUATION.md) before making quality claims from the included benchmarks.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Privacy, deletion semantics,
native permission boundaries, and evidence integrity are compatibility contracts in this project.
Security issues should follow [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Ziwen Song.

Licensed under the [Apache License 2.0](LICENSE).
