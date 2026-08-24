# Timeline Agent Runtime

This document describes the implemented DeskLore Timeline Agent runtime. Its central contract is
simple: a closed segment becomes readable immediately, while model enrichment runs as durable,
interruptible background work.

## Runtime flow

```text
closed event segment
  -> sanitize and exclude protected events
  -> atomically write a raw-baseline timeline document
  -> persist an owner-only Timeline Agent job
  -> fair scheduler grants one model turn
  -> Electron utility process runs Pi with read-only evidence tools
  -> main process validates every returned citation
  -> atomically upgrade the same document to generator: agent
```

The baseline is the availability contract. Model configuration errors, provider outages, a worker
crash, or a long investigation never prevent the ten-minute record from appearing. Successful
enrichment preserves the document ID and file path so downstream consumers do not observe a second
record for the same segment.

## Work model

There is no fixed cumulative ceiling on turns, submissions, tool calls, inspected evidence, or
retries for a retained source segment. Instead, the runtime controls work at smaller boundaries:

- one scheduler lease advances exactly one model turn;
- jobs rotate by source segment so one investigation cannot monopolize the queue;
- evidence reads remain paginated and individually bounded;
- provider requests retain timeout and output-token bounds;
- old tool output is compacted when the serialized model context grows beyond the runtime
  threshold, while recent turns and tool-call/result structure remain intact;
- three consecutive turns without new evidence, a new inspection request, or a changed submission
  yield the lease as `stalled`; this is a retryable scheduling state, not a task-wide evidence cap;
- retryable provider failures use exponential backoff with deterministic jitter, capped at a
  six-hour delay between attempts, but the number of attempts is not capped.

Progress is semantic rather than textual. Repeating the same tool request or resubmitting an
unchanged invalid payload does not count as progress.

## Persistent job state

`timeline/timeline-agent-jobs.json` is written atomically with owner-only permissions. A job stores
only identifiers, runtime fingerprint, state, counters, failure classes, and scheduling times. It
does not store event text, model prompts, tool results, API keys, or the Pi transcript.

The primary states are:

```text
baseline_ready -> queued -> running -> succeeded
                     |         |
                     |         +-> stalled -> backoff -> queued
                     +------------> waiting_provider -> backoff -> queued
                     +------------> waiting_configuration
                     +------------> paused
```

`source_unavailable` and `cancelled` are terminal. A changed model, endpoint, protocol,
configuration availability, or generator version changes the runtime fingerprint and wakes an
otherwise configuration-blocked or stalled job. App shutdown aborts active work and records
runnable jobs as paused. On restart, a job is reconstructed from its retained source segment; the
ephemeral model transcript is intentionally not persisted.

## Submission and evidence contract

The model can inspect only the in-memory, sanitized segment DTO and the explicit read-only Timeline
tools. `submit_timeline` is the only accepted output path and must be the sole tool call in its turn.
The submitted document-level evidence list is derived from claim citations rather than trusted as
an independent field.

Duplicate citations are normalized. Empty claims and citations that were not inspected return
structured repair information to the model, allowing a later turn to correct the submission. On a
successful worker response, Electron main independently checks that every document and claim
citation is both:

1. reported as inspected by the evidence session; and
2. present in the retained source segment.

Only then may the baseline be upgraded.

## Process boundary

Production model work runs in an Electron utility process. The worker receives a minimal
allowlisted environment and a structured-cloneable input containing sanitized events, bounded prior
summaries, locale, and the selected model runtime. It is not given the history storage root or a
write-capable application service. A small command protocol allows only session creation, one-turn
advance, abort, and disposal. Worker exit rejects pending requests as retryable failures, leaving the
baseline and persistent job intact.

This boundary protects Electron main from model-loop crashes and long-running provider work. It is
not an operating-system sandbox: the worker ships with application code, and the API key exists in
worker memory while its session is active. Prompt-level access is constrained by the Pi tool
allowlist, sanitization, citation validation, and the absence of write-capable tools.

## Diagnostics and recovery

Privacy-safe run diagnostics use schema version 2 and record turns, tool counts, inspected-event
count, evidence bytes, provider token usage, estimated request input, submission/repair counters,
latency, terminal state, and normalized failure reason. They retain no observed text or secrets and
continue to use the existing bounded 30-day/2,000-run retention policy.

History deletion removes the corresponding job. Clear and restore archive the job file together
with timeline state. Provider and worker failures preserve the readable baseline and retry from
retained evidence. A non-retryable invalid worker result remains stalled until its runtime
fingerprint changes or the record is otherwise regenerated.

## Remaining M3 gates

The runtime mechanics are implemented, but M3 parity is not complete. Remaining gates include the
expanded prompt-injection and prior-context threat model, provider capability probing, controlled
Skysight comparison across representative segments, human review, and release-quality health UI.
