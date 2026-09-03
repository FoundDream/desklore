# Evaluation

DeskLore includes local evaluators for capture coverage, semantic fidelity, and conditional summary
value. Evaluation inputs can contain private activity data and remain ignored under `.eval-data/`.

## Evaluation contract

Quality claims must name the layer being measured. The layers are related, but they are not
interchangeable:

1. **Reference similarity** compares DeskLore with a separately collected signal. It can reveal
   capture regressions, but the reference is not ground truth.
2. **Human correctness** checks whether claims are supported by the inspected evidence and whether
   important activity was omitted. Automatic judges are triage aids, not substitutes for this
   review.
3. **Product usefulness** asks whether the resulting history helps a person recover context or
   continue work. It requires controlled tasks and human outcomes, not event-count parity.

Every retained report must include its schema version, generation time, evaluator settings, input
completeness, and the exact segment IDs used in headline metrics. Only segments classified as
`complete` on both sides enter paired capture scores. Open, partial, malformed, or unreadable
segments remain visible as data-quality diagnostics instead of being silently discarded.

Reports and generated summaries are private local artifacts. They must not contain raw prompt
payloads, credentials, or unredacted source text unless the evaluator explicitly documents that
need. A single reference collector, model judge, or benchmark run is never enough to publish a
general quality claim.

## Capture coverage

Compare a candidate recording against a separately collected reference:

```bash
pnpm eval:history -- \
  --candidate "$HOME/Library/Application Support/DeskLore/history" \
  --reference codex-local
```

`codex-local` is an explicit read-only opt-in. On macOS it discovers the Computer History Skysight
root under the Codex CUA service Group Container without hard-coding the Team ID. It reads segment
metadata and events in place; it does not read Codex chats or prompts, change Computer History
settings, copy source events into the repository, or make model requests. An explicit Skysight
history root and `CODEX_COMPUTER_HISTORY_ROOT` remain supported for automation.

The report uses bundle-aware, one-to-one timestamp matching and reports precision, recall, F1,
semantic agreement, latency, duplicate-burst, per-kind, complete app-by-kind, active-bucket
sensitivity, and privacy-safe Return-key context diagnostics. Headline precision and recall retain
their original kind/application/time definition; diagnostics are a separate layer and do not
redefine those scores.

### Interpreting shared segments

Headline reference-similarity scores are conditional on both recorders producing the same complete
ten-minute segment. DeskLore creates segment storage when the server receives an event or a
suppression metric; it does not write empty heartbeat segments merely because the application is
running. If the DeskLore process is killed during a segment, that segment can remain `open`, while
later intervals produce no candidate segment at all. A reference-only complete segment can
therefore indicate candidate downtime, a disconnected collector, disabled capture, or a permission
failure rather than an event-level algorithm miss.

Do not divide shared complete segments by reference complete segments and describe the result as
algorithm recall unless candidate runtime availability is independently known. Keep these concerns
separate:

1. **Paired reference similarity** uses only mutually complete segments and measures event matching
   while both datasets are available.
2. **Recorder availability** requires process, collector, permission, and pause-state telemetry. In
   reports without that telemetry, label reference-only intervals `candidate_availability_unknown`.
3. **End-to-end capture reliability** combines availability with event quality and needs a deliberate
   continuously running collection session.

Recorder availability telemetry is stored separately from history events under
`usage/recorder-availability/`. Each ServerCore process run owns one atomically updated file with a
start time, last heartbeat, optional clean end time, and privacy-safe state transitions. ServerCore
requests a native collector heartbeat every 30 seconds; the evaluator treats a run without a fresh
heartbeat for 90 seconds as unavailable. The telemetry contains no application identity, window
title, URL, typed text, or captured content. It moves with history during clear and restore.

`history-paired-v4` reports availability for every complete reference segment as `available`,
`unavailable`, or `unknown`. Older segments recorded before this telemetry existed remain `unknown`.
Availability is a diagnostic in v4 and does not silently change the headline cohort or its matching
definition.

For example, the retained local report generated on 2026-09-01 contains 51 complete candidate
segments, 88 complete reference segments, and 49 mutually complete segments. The other 39 complete
reference segments do not enter F1. The report did not record recorder settings or runtime
heartbeats, so development-time process termination is a plausible explanation but cannot be proven
for every missing segment. Its 57.8% headline F1 must be read as a conditional score over the 49
shared segments, not as an end-to-end coverage claim. On the 35 shared segments where both sides
recorded at least 20 events, precision was 58.2%, recall was 76.2%, and F1 was 66.0%; this active
subset is more useful for diagnosing event algorithms, while still treating the reference as an
observational comparator rather than ground truth.

To rerun an exact frozen cohort, pass a previous evaluator report, a JSON object with
`segmentIDs`, or a JSON array of segment IDs. The evaluator fails if any selected segment is missing
or incomplete instead of silently shrinking the cohort:

```bash
pnpm eval:history -- \
  --reference codex-local \
  --segment-ids-file /path/to/frozen-report.json \
  --output .eval-data/history-frozen
```

A passing code test or an old retained bucket is not evidence of current live capture recall.
Collector changes require a fresh baseline of at least 30 complete paired ten-minute buckets before
making a release comparison.

## Semantic frame replay

Replay retained segments through the current frame extractor:

```bash
pnpm eval:semantic -- --root "$HOME/Library/Application Support/DeskLore/history"
```

The report stays free of source text. It counts, overall and per application, how many events
carried structured Accessibility nodes, how many produced a frame (deltas without a base cannot),
how the frame and its list-view summary compare in bytes with the rendered tree text, and how often
a frame carries identity, content, and a focused element. `meanContentShare` is the share of text
characters that fell in the content region rather than navigation or chrome. Stored frames are
compared with the fresh replay so a rule change that would alter persisted frames is visible before
it ships.

Frame extraction is a pure function over recorded snapshots, so this evaluator is the replay
discipline for the semantic layer: run it before changing region rules, surface tables, or frame
limits, keep the `report.json`, then run it again with `--baseline <report.json>`. Any
per-application drop in identity, content, focus, or content share beyond
`--regression-threshold` (default `0.01`) is listed as a regression, and `--fail-on-regression`
turns that into a non-zero exit code for automation. Coverage here measures the extractor, not
timeline quality; the paired timeline benchmark below remains the place for summary claims.

## Paired timeline benchmark

Start by freezing the exact complete segments used by every arm. A comma-separated
`--segment-ids` list overrides newest-first selection and is recorded in the report:

```bash
pnpm eval:timeline -- \
  --segment-ids 2026-08-22T12-00-00Z,2026-08-22T12-10-00Z \
  --output .eval-data/timeline-manifest
```

Omit `--segment-ids` to select the newest complete segments with `--max-cases`. Manifest-only mode
makes no model calls and writes IDs, counts, applications, and evidence hashes without source event
payloads.

Generate the current DeskLore arm through the production Pi Timeline Agent:

```bash
OPENAI_API_KEY=... pnpm eval:timeline -- \
  --segment-ids 2026-08-22T12-00-00Z,2026-08-22T12-10-00Z \
  --generate-current \
  --model gpt-5.6-luna \
  --output .eval-data/timeline-current
```

`generated-current.jsonl` includes the validated summary, evidence hash, and per-case runtime
metrics: model turns, provider requests, tool calls, inspected events, evidence bytes, token usage,
submission attempts, normalization repairs, and latency. It never includes source event payloads.
Generation uses the production agent prompts, evidence tools, request timeout, structured
submission repair, and exact claim/evidence union validation. The agent has no cumulative turn,
tool, evidence-byte, retry, or elapsed-time cap; request-scoped limits still apply. Utility-process
isolation and persistent scheduling are runtime concerns covered by application tests, not this
in-process benchmark runner.

To compare two generated files, pass JSONL arms containing the manifest's `segmentID`, exact
`evidenceHash`, and a Timeline Agent-shaped `summary`:

```bash
pnpm eval:timeline -- \
  --segment-ids 2026-08-22T12-00-00Z,2026-08-22T12-10-00Z \
  --arm-a /path/to/current.jsonl \
  --arm-b /path/to/candidate.jsonl \
  --output .eval-data/timeline-pair
```

Alternatively, generate current as arm A and pair it with an existing arm B in one run by combining
`--generate-current` and `--arm-b`.

The evaluator validates both arms against the same complete sanitized event IDs and evidence hash.
The summary-level evidence IDs must be exactly the union of claim citations. It then writes a blind
`human-review.jsonl` template. Fill every 0-4 score and `winner` (`a`, `b`, or `tie`), save the
completed file, and aggregate it against the unchanged arms:

```bash
pnpm eval:timeline -- \
  --segment-ids 2026-08-22T12-00-00Z,2026-08-22T12-10-00Z \
  --arm-a .eval-data/timeline-current/generated-current.jsonl \
  --arm-b /path/to/candidate.jsonl \
  --human-review /path/to/completed-human-review.jsonl \
  --output .eval-data/timeline-reviewed
```

Human-review import verifies the segment, evidence hash, randomized candidate contents, score
ranges, and duplicate rows before mapping displayed labels back to the real arms. Notes are not
copied into the aggregate report. An optional automatic judge is explicit and remains separate:

```bash
OPENAI_API_KEY=... pnpm eval:timeline -- \
  --arm-a /path/to/current.jsonl \
  --arm-b /path/to/candidate.jsonl \
  --run-judge \
  --judge-model gpt-5.6-luna
```

The automatic judge scores activity-thread coverage, factual support, continuation value, citation
support, focus, unsupported claims, and incidental details. Citation membership is checked
deterministically first. Skysight summaries may be retained as a same-window observational
reference, but they are not a controlled arm because its generator cannot consume DeskLore's exact
same-evidence contract.

## Paired visual-value benchmark

Create a manifest without model calls:

```bash
pnpm eval:visual-value -- \
  --input "$HOME/Library/Application Support/DeskLore/history" \
  --max-cases 12 \
  --output .eval-data/visual-value-manifest
```

The evaluator uses the same complete set of sanitized event IDs for both arms. AX-only removes only
persisted visual evidence; AX+Visual retains sanitized OCR and visual understanding. Raw pixels are
never read.

Model mode is explicit:

```bash
OPENAI_API_KEY=... pnpm eval:visual-value -- \
  --input "$HOME/Library/Application Support/DeskLore/history" \
  --run-models
```

Each summary arm runs through the same Pi tool-calling Timeline Agent used by the application,
including on-demand evidence inspection, request-scoped safeguards, and `submit_timeline` citation
validation. There is no cumulative agent-work cap. The final blind judge remains a separate
structured model call.

Generated summaries can repeat sanitized source content and must still be treated as private. A
manifest, one generation, or an automatic judge is not a causal product result. Use a fresh
controlled set and human review before publishing quality claims.
