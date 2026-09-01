---
name: desklore-find-simplifications
description: Find and assess evidence-backed code simplifications in DeskLore. Use for requests to clean up, simplify, remove dead or duplicated code, reduce over-built surfaces, or review cleanup candidates. Default to read-only analysis unless the user explicitly authorizes implementation.
---

# Finding DeskLore Simplifications

Find a few well-proven ways to reduce DeskLore's code or supported surface without weakening its product, privacy, persistence, or native-process contracts. Static-analysis output is a lead, not deletion proof.

## Preserve The Requested Scope

- Treat requests to find, inspect, audit, review, or analyze cleanup opportunities as read-only. Report findings in the conversation; do not edit code, add TODOs, create issues or PRs, stage files, or commit.
- Implement only when the user explicitly asks to make a change. Limit the implementation to confirmed candidates and preserve unrelated worktree changes.
- A cleanup request does not authorize product removal, schema migration, compatibility breakage, external writes, or destructive data operations.
- It is valid to conclude that no candidate has enough evidence.

## Start With Current Repository Context

1. Inspect `git status --short --branch` and the relevant diff before judging current code. Do not treat in-progress work as stale or dead.
2. Read the current project contracts in [CONTRIBUTING.md](../../../CONTRIBUTING.md), the architecture section of [README.md](../../../README.md), and [PRIVACY.md](../../../PRIVACY.md). Read [docs/EVALUATION.md](../../../docs/EVALUATION.md) when capture or visual quality is involved.
3. Inspect [package.json](../../../package.json), Swift package entry points, build scripts, and packaging configuration before calling a file, dependency, or executable unused.
4. Use current runtime and release evidence. Do not import DeepSeek Harness assumptions such as pre-release deletion freedom, Agent Notes, ACP, Cordis, `packages/*`, or `origin/master`.

## Protected Boundaries

Assume these are intentional unless stronger repository evidence proves otherwise:

- The Swift Collector owns Accessibility access, native capture, native redaction, capture health, and optional ScreenCaptureKit work. Electron main owns policy enforcement, persistence, derived artifacts, model calls, and renderer-facing DTOs.
- Collector and Electron main communicate through newline-delimited JSON over stdio. Commands, response types, request IDs, timeouts, wire strings, and Swift/TypeScript DTOs are consumers even when ordinary symbol search cannot connect them.
- The renderer receives a narrow preload API and sanitized DTOs. Raw events, raw history files, screenshots, and API keys must not enter the renderer.
- Recording consent, sensitive-surface filtering, private-browsing filtering, default-off model and visual features, local-first storage, and explicit network opt-in are product contracts.
- Native capture-time redaction and main-process normalization may look duplicated while protecting different trust boundaries. Do not merge them merely to remove repeated code.
- Schema versions, atomic writes, retention, cascading deletion, recovery, persisted settings, encrypted credentials, and compatibility readers require explicit consumer and migration analysis.
- Collector bundle identity, application bundle identity, packaged executable paths, `extraResources`, entitlements, permissions, signing, and notarization are runtime consumers.
- Evaluator manifests, mocked judges, and one model run do not prove live capture or visual value. Preserve the distinction between static replay, fresh capture evidence, and human review.

## Survey The Real Consumer Corpus

Classify evidence before proposing a candidate:

- **Runtime production:** `src/main`, `src/preload`, `src/renderer`, `src/shared`, `Sources`, application entry points, native build scripts, and packaged resource configuration.
- **Maintainer and public surfaces:** evaluation scripts, `website`, release files, user documentation, privacy documentation, and contributor workflows. These are not automatically disposable because they are outside the app bundle.
- **Tests:** `Tests`, `*.test.ts`, and `*.test.mjs`. A test-only consumer is evidence to investigate, not automatic proof that the behavior should remain or be removed.
- **Dynamic and persisted consumers:** IPC channel strings, NDJSON commands, event names, localization keys, environment variables, bundle identifiers, schema keys, file names, stored Markdown/JSONL, and compatibility paths.
- **Generated or local artifacts:** `.build`, `dist`, `out`, `release`, `site-dist`, and `.eval-data` are not source consumers, but inspecting a fresh build or package may be required to validate removal.

Useful survey domains include:

- Electron main/preload/renderer API and state duplication.
- Collector command handling, capture lifecycle, and TypeScript/Swift wire representations.
- History service lifecycle, coalescing, policy, storage, timeline, rollups, visual scheduling, and error paths.
- Persisted schemas, settings compatibility, retention, deletion, recovery, and derived-artifact invalidation.
- Evaluator helpers, synthetic fixtures, website assets, localization, build scripts, packaging, and dependencies.

Survey the relevant domains before stopping at the first unused symbol. For breadth, prioritize large production-code surfaces and cross-boundary lifecycle machinery rather than file size alone.

## What Makes A Strong Candidate

A candidate is strong when repository evidence shows that its cost exceeds its current value and the proposed change produces a real net reduction. Examples include:

- A method, IPC channel, native command, DTO field, configuration option, event, helper, dependency, or artifact has no runtime, public-tool, persisted, compatibility, or documented consumer.
- Tests or docs are the only consumers, and the behavior they pin is not a current product or safety contract.
- Multiple states or representations mirror the same fact without protecting separate process, trust, persistence, rollback, or lifecycle boundaries.
- An abstraction requires every implementation to support unused methods or speculative generality.
- Compatibility code has no supported persisted input, released format, migration obligation, or rollback role.
- A hand-rolled implementation can be replaced by a Node/macOS builtin or a healthy dependency and the implementation, dedicated tests, and documentation removed exceed the remaining glue.
- A feature was added and later removed, but implementation, configuration, schema, migration, compatibility, documentation, packaging, and tests still retain obsolete pieces.

Large files, repeated syntax, a one-off `rg` result, an unused-looking exported symbol, or a `knip`/duplicate-code warning are thin evidence by themselves.

## Prove Or Reject Each Candidate

For each candidate:

1. Search the exact symbol and every string-level identity: IPC channel, command, event, config key, schema field, file name, bundle ID, localization key, and wire value. Use `rg` first, then read call sites and loaders.
2. Separate runtime, maintainer/public, test, documentation, dynamic, persisted, and compatibility consumers.
3. Explain the current ownership or lifecycle cost. For asynchronous code, map state flags, timers, pending requests, cancellation, teardown, retries, rollback, and terminal outcomes to their owners before combining them.
4. State the complete removal or consolidation boundary, including affected types, IPC/preload APIs, Swift messages, settings, schemas, tests, translations, documentation, build entries, and dependencies when applicable.
5. Calculate net reduction conceptually: removed implementation, tests, docs, and maintenance surface minus new glue, migration code, wrappers, and validation burden.
6. Name the observable behavior that remains and what capability or compatibility is intentionally given up.
7. Reject or downgrade the idea when it is actually a product decision, privacy change, schema migration, public contract change, or broad churn with little net reduction.

For dependency substitutions, also check license compatibility, maintenance, adoption, security history, transitive footprint, bundle impact, Node/macOS version support, module format, and residual semantics. Prefer builtins when they cover the requirement cleanly; a wrapper that relocates the same complexity is not a simplification.

## Report The Audit

Return a compact, evidence-backed set ordered by confidence and value. For each item include:

- Classification: `Safe cleanup`, `Decision required`, or `Protected / rejected`.
- Current surface and concrete file or symbol evidence.
- Consumer findings, including negative searches and ambiguous consumers inspected.
- Exact proposed reduction and expected net effect.
- Behavior, privacy, persistence, packaging, and compatibility risks.
- Proportional validation plan.
- Confidence and the evidence still missing.

Prefer three to five strong candidates over a long speculative backlog. Stop after the relevant major domains have been surveyed and additional searches only repeat known evidence. Report protected or rejected cases when they prevent tempting but unsafe cleanup.

## Implement A Confirmed Simplification

When the user explicitly requests implementation:

- Recheck the worktree and target branch immediately before editing.
- Make the smallest coherent change that removes the confirmed surface completely. Do not leave orphaned IPC handlers, preload methods, DTOs, Swift commands, settings, translations, tests, docs, package entries, or dependencies.
- Preserve unrelated modifications and stage exact paths only if the user asks for a commit. Do not push, create a PR, close issues, or delete external artifacts unless explicitly requested.
- Add or update regression tests for changed policy, deletion, retention, protocol, schema, consent, or privacy behavior.
- Use synthetic fixtures; never introduce real activity, AX, OCR, screenshot, timeline, or rollup data into the repository.

Choose validation according to the outgoing change:

- TypeScript, renderer, or evaluator changes: `pnpm check` and `pnpm test`.
- Swift capture or native protocol changes: `swift test`, the relevant JavaScript tests, and a fresh native build.
- Cross-process, persistence, privacy, deletion, or schema changes: run both TypeScript and Swift suites plus focused regression tests.
- Packaging, bundle identity, permissions, icons, or Collector resources: `pnpm build` or `pnpm package:mac` as appropriate, then inspect the actual packaged artifact or runtime behavior.
- Website changes: `pnpm site:build`.
- Capture-quality claims: collect fresh, complete data and apply the evaluation limits in `docs/EVALUATION.md`; passing unit tests or a manifest is insufficient.

Do not run expensive packaging or live-capture validation for unrelated docs-only or local cleanup. Report exactly what was and was not verified.

## Provenance

This workflow is conceptually adapted from DeepSeek's [`dsh-find-simplifications`](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills/dsh-find-simplifications) skill (Copyright 2026 DeepSeek, MIT License) and rewritten for DeskLore's architecture and repository contracts.
