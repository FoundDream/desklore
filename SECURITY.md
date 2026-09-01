# Security policy

## Supported versions

DeskLore is currently an early source release. Security fixes target the latest `main` branch and
the newest published release. Older commits and locally modified builds are not maintained as
separate security lines.

## Report a vulnerability

Please use GitHub's private vulnerability reporting flow:

<https://github.com/FoundDream/desklore/security/advisories/new>

Include the affected commit or version, expected boundary, observed behavior, and the smallest
synthetic reproduction you can provide. Do not include real computer-history data, screenshots,
credentials, API keys, or other people's personal information.

If private reporting is unavailable, open a public issue containing only a request for a private
contact channel. Do not disclose exploit details in that issue.

## High-priority boundaries

Reports are especially valuable when they involve:

- capture occurring before explicit consent or while paused;
- password, private-browsing, or sensitive-system content escaping native redaction;
- deletion failing to remove source segments or derived rollups;
- raw JSONL or API keys reaching the renderer;
- unrequested network traffic or persisted screenshot pixels;
- path traversal, unsafe symlink handling, or permissive data-file modes;
- IPC calls accepted from an untrusted renderer.

DeskLore does not currently offer a response-time SLA or a bug-bounty program.
