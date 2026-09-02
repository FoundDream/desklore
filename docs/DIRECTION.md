# Direction

This document defines what DeskLore is, which commitments are load-bearing, and which phase the
project is in. It is the reference for product and architecture decisions; `ARCHITECTURE.md`
describes how the current code is organized.

## Definition

> Your computer's memory. Owned by you, usable by the agents you trust.
>
> 你的电脑记忆，归你所有，供你信任的 agent 使用。

DeskLore is open-source infrastructure for personal context. It observes what you do on your Mac
through Accessibility semantics instead of screen recording, and grows that activity into a memory
stored on your machine as plain files. Every statement in that memory can be traced to the evidence
behind it and deleted together with it. DeskLore uses this memory itself first; agents you trust can
use it within the scope you grant.

DeskLore is built as a public utility, not a commercial product. The desktop application is the
first reference client and the one its authors use every day. The formats, adapters, and access
contracts around it are meant to outlive any single client.

## What DeskLore is not

- Not a screen recorder or replay archive. Pixels are a fallback, never the record.
- Not a general automation agent. In this phase DeskLore delivers information; it does not act on
  the user's behalf.
- Not a cloud service. Memory does not leave the machine except through model calls the user has
  explicitly enabled and scoped.
- Not a data aggregator. External sources are added only when the memory layer has a place for
  them, and they follow the same evidence, retention, and deletion rules as native capture.

## Load-bearing commitments

These are compatibility contracts. Any producer, derivation, or consumer added to DeskLore must
honor them.

- **Local.** Raw events, memory, settings, and credentials stay on the user's machine. Owner-only
  files, plain Markdown and JSONL, versioned schemas.
- **Cited.** Every claim in a derived artifact points to retained evidence. Memory cites timeline
  documents; timeline documents cite segments. A claim whose evidence is gone is marked
  unverifiable, not silently kept as fact.
- **Deletable.** Deleting evidence cascades to everything derived from it. Clear-all leaves nothing
  behind and leaves recording paused.
- **Yours.** Each boundary that widens observation or sends data off the machine is a separate,
  explicit consent. Consumers see sanitized data within a scope the user can inspect and revoke.
- **Semantic over pixels.** Structured Accessibility state is the primary evidence source. Visual
  capture exists only to fill gaps and stays off by default.

## Layers

```text
Producers        native collector (macOS AX)      shipped
                 source adapters (files, calendar) planned
        |
Evidence         segments, timeline documents,    shipped
                 rollups, coverage metrics
        |
Memory           projects, open loops, routines,  planned
                 user-editable profile
        |
Outputs          timeline client                  shipped
                 search                           shipped
                 proactive cards                  planned
                 agent access (MCP)               planned
```

Producers write evidence. The memory layer derives durable state from evidence and is pluggable:
which model and prompts turn evidence into memory should be replaceable. Outputs consume memory
and evidence. The desktop UI is one output among several and should stay thin.

When adding code, decide which layer it belongs to. Keep the core small; push app-specific
extraction into producers and use-case logic into outputs.

## Current phase: collect comprehensive context

The immediate goal is evidence that is complete enough that any later consumer can be built on it
without re-collecting. "Comprehensive" is measured, not assumed:

- **Coverage.** For each minute of foreground time, does DeskLore know the application, the
  document or page, its content, and the user's action? Coverage is reported per application so
  low-coverage applications get dedicated semantic extractors.
- **Retention.** Evidence must survive until it is consumed. Raw segments stay short-lived; a
  compacted evidence tier keeps text, URLs, document identity, and actions for months; timeline
  documents and rollups are permanent.
- **Explicit context.** A user-editable profile is the one layer capture cannot produce. It is the
  highest-quality input and the cheapest to add.

Priorities in this phase, in order: tiered retention and a coverage evaluator; application-level
semantic extractors for the tools the authors use most; local file sources such as agent session
logs and version control; cheap environment signals; a policy-gated clipboard channel; the
profile; then calendar as the first external source.

## Later phases

**Memory.** A cross-segment derivation that maintains projects, open loops, and routines as
Markdown under `history/memory/`, cited to timeline documents. The profile is user-owned; model
updates never overwrite user edits.

**Outputs.** Proactive assistance is one output, and it is built as infrastructure rather than as
an assistant: a trigger layer over the live context stream, an attention budget owned by the core
so no card source can interrupt without limit, feedback on every card, and offline replay of trigger
rules against recorded context before they ship. The first proactive scenario is resumption: when
the user returns to a project, show where they left off. Agent access exposes the same memory
files through MCP under scoped, auditable permissions.

Sequencing is driven by one test: the authors use it every day. Outputs that fail that test are
removed; the evidence and memory beneath them remain.
