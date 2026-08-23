# Changelog

## 0.1.0 — 2026-08-23

DeskLore's first public source release.

### Included

- Native macOS semantic activity collection through Accessibility APIs.
- A local timeline, six-hour memory rollups, daily memory, and search.
- Explicit first-run recording consent with independently authorized Collector access.
- Local JSONL and Markdown artifacts with deletion and retention controls.
- Sensitive-surface, private-browsing, and password-field filtering.
- Optional model summaries and visual fallback, both disabled by default.
- Separate `com.desklore.desktop` and `com.desklore.collector` bundle identifiers.

### Current limits

- macOS 14+ on Apple Silicon only.
- Source distribution only; no official signed or notarized binary yet.
- Application, window, and URL exclusion controls are planned after 0.1.0.
