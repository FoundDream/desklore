# Evaluation

DeskLore includes local evaluators for capture coverage, visual-policy behavior, and conditional
visual value. Evaluation inputs can contain private activity data and remain ignored under
`.eval-data/`.

## Capture coverage

Compare a candidate recording against a separately collected reference:

```bash
pnpm eval:history -- \
  --candidate "$HOME/Library/Application Support/DeskLore/history" \
  --reference /path/to/reference/events.jsonl
```

The report uses bundle-aware, one-to-one timestamp matching and reports precision, recall, F1, and
per-kind diagnostics. A passing code test is not evidence of live capture recall; collect fresh,
complete ten-minute buckets after collector changes.

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

The evaluator samples identical event IDs for two arms. AX-only removes only persisted visual
evidence; AX+Visual retains sanitized OCR and visual understanding. Raw pixels are never read.

Model mode is explicit:

```bash
OPENAI_API_KEY=... pnpm eval:visual-value -- \
  --input "$HOME/Library/Application Support/DeskLore/history" \
  --run-models
```

Generated summaries can repeat sanitized source content and must still be treated as private. A
manifest, one generation, or an automatic judge is not a causal product result. Use a fresh
controlled set and human review before publishing quality claims.
