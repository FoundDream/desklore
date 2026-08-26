# DeskLore privacy boundary

DeskLore is designed to keep computer-history data on the user's Mac. This document describes the
behavior of version 0.2.0. It is a technical product boundary, not a promise that local files are
safe from every process or user with access to the same Mac.

## Consent and permissions

DeskLore does not start its native collector before the user accepts the first-run recording
notice. After consent, DeskLore records ordinary applications and URLs by default.

The embedded **DeskLore Collector** requests macOS Accessibility permission because it owns the
native Accessibility and global-interaction boundary. The Electron UI does not need a second
Accessibility grant. Screen Recording permission is requested separately only after the user
enables visual fallback.

## Data collected locally

Depending on the active application and available Accessibility information, semantic events may
contain:

- application name and bundle identifier;
- window title and URL;
- interaction kind, target role, label, and sanitized value;
- bounded Accessibility tree text;
- timestamps, source IDs, capture health, and aggregation counts;
- optional OCR or visual-understanding text when visual fallback is enabled.

DeskLore blocks its own windows, known sensitive macOS system surfaces, private-browsing windows,
and password-like fields. Native sanitization also filters common credentials, access tokens,
payment-card patterns, email addresses, and sensitive URL components before events leave the Swift
collector. These controls reduce risk; they cannot guarantee that every application labels
sensitive UI correctly or that every private value matches a known pattern.

Users can also exclude installed applications, domains, and exact or partial window titles in
Settings. Window-title rules may optionally be limited to one application. These policies are
enforced before retained history is produced.

## Storage

Data is stored under:

```text
~/Library/Application Support/DeskLore/history/
```

DeskLore creates owner-only directories and files where supported. Raw event segments are retained
for 48 hours. Persisted visual text evidence is removed after 24 hours. Timeline and memory
Markdown remain until the user deletes them.

Raw screenshot pixels are processed in memory and are not written to the event store. Timeline and
memory Markdown are not encrypted by DeskLore. API keys are encrypted with Electron `safeStorage`.
Use FileVault and an appropriate macOS account password when disk-at-rest protection is required.

## Deletion

Deleting one timeline item removes:

- the timeline Markdown file;
- its source raw segment;
- visual evidence inside that segment;
- memory rollups derived from the deleted source, which are regenerated from remaining documents.

**Clear all history** pauses recording and removes all raw segments, timeline documents, memory
rollups, and visual evidence. It intentionally keeps application settings, recording consent, and
an encrypted API key so deletion does not silently change unrelated preferences. Users can remove
the API key separately in Settings.

## Network access

DeskLore contains no telemetry or automatic crash upload. Its deterministic timeline and memory
paths require no network access.

Network requests occur only when the user enables a model-backed feature and supplies a compatible
HTTPS endpoint and API key. Depending on enabled options, filtered semantic evidence, generated
timeline summaries, locally processed OCR, or a privacy-processed window image may be sent to that
endpoint. Model requests set `store: false`, but the endpoint operator's own retention policy still
applies.

Treat content captured from applications and returned by models as untrusted input. DeskLore tells
models not to follow instructions found in captured content, but prompt-injection risk cannot be
eliminated completely.

## Reporting a privacy issue

Do not attach real activity logs, screenshots, API keys, or unredacted personal data to a public
issue. Follow [SECURITY.md](SECURITY.md) and use a minimal synthetic reproduction.
