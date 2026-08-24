# Evaluation

DeskLore includes local evaluators for capture coverage, semantic fidelity, visual-policy behavior,
and conditional summary value. Evaluation inputs can contain private activity data and remain
ignored under `.eval-data/`.

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
  --reference /path/to/reference/history-root
```

The report uses bundle-aware, one-to-one timestamp matching and reports precision, recall, F1,
semantic agreement, latency, duplicate-burst, and per-kind diagnostics. Headline precision and
recall retain their original kind/application/time definition; semantic diagnostics are a separate
layer and do not redefine those scores.

A passing code test or an old retained bucket is not evidence of current live capture recall.
Collector changes require a fresh baseline of at least 30 complete paired ten-minute buckets before
making a release comparison.

## Paired timeline benchmark

Create a same-evidence manifest without model calls:

```bash
pnpm eval:timeline -- --max-cases 12
```

To compare two previously generated candidate files, pass JSONL files containing the manifest's
`segmentID`, exact `evidenceHash`, and a Timeline Agent-shaped `summary`:

```bash
pnpm eval:timeline -- \
  --arm-a /path/to/current.jsonl \
  --arm-b /path/to/candidate.jsonl
```

The evaluator validates both arms against the same complete sanitized event IDs and evidence hash,
then writes a blind `human-review.jsonl` template. An optional automatic judge is explicit:

```bash
OPENAI_API_KEY=... pnpm eval:timeline -- \
  --arm-a /path/to/current.jsonl \
  --arm-b /path/to/candidate.jsonl \
  --run-judge
```

The automatic judge scores activity-thread coverage, factual support, continuation value, citation
support, focus, unsupported claims, and incidental details. Citation membership is checked
deterministically first. Skysight summaries may be retained as a same-window observational
reference, but they are not a controlled arm because its generator cannot consume DeskLore's exact
same-evidence contract.

## Visual policy replay

```bash
pnpm eval:visual -- \
  --input "$HOME/Library/Application Support/DeskLore/history"
```

This replays persisted event evidence through policy diagnostics. It does not prove that screenshots
improve summaries.

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
including on-demand evidence inspection, turn and byte budgets, and `submit_timeline` citation
validation. The final blind judge remains a separate structured model call.

Generated summaries can repeat sanitized source content and must still be treated as private. A
manifest, one generation, or an automatic judge is not a causal product result. Use a fresh
controlled set and human review before publishing quality claims.
