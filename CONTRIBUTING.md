# Contributing to DeskLore

Thank you for helping build open-source personal context infrastructure: a local, cited, deletable memory of your work on macOS. Read [docs/DIRECTION.md](docs/DIRECTION.md) for the definition and layer model.

## Before you start

Open an issue before large product, schema, platform, or privacy changes. Small fixes and focused
tests can go directly to a pull request. Keep contributions scoped; unrelated cleanup makes privacy
and native-boundary review harder.

By submitting a contribution, you agree that it is licensed under Apache License 2.0, as described
in section 5 of [LICENSE](LICENSE). No separate CLA is currently required.

## Development setup

Requirements are macOS 14+, Apple Silicon, Node.js 24+, pnpm 11+, and Swift 6.2+.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Use `pnpm dev` for local Electron development. The first native build creates
`dist/DeskLore Collector.app`. Do not commit `dist/`, `out/`, `release/`, `.build/`, local activity
data, evaluation output, or credentials.

## Pull requests

- Use a focused Conventional Commit-style title such as `fix(history): cascade timeline deletion`.
- Explain the user-visible effect, the trust boundary touched, and the validation performed.
- Add regression tests for policy, deletion, retention, protocol, and schema changes.
- Use synthetic fixtures. Never copy real timeline, rollup, AX, OCR, or screenshot content into the
  repository.
- Preserve the Swift Collector boundary for Accessibility, native redaction, and capture health.
- Keep renderer APIs narrow. Raw events and API keys must not enter the renderer.
- Do not claim capture quality from a manifest, mocked judge, or one automatic model run.

CI is intentionally not a prerequisite for the first source release. Contributors should include
local results for `pnpm check`, `pnpm test`, and `pnpm build`; maintainers may request a packaged
macOS verification for changes to signing, permissions, icons, or the Collector bundle.

## Privacy review checklist

For changes that touch recorded data, answer these questions in the pull request:

1. What new data can be captured, persisted, rendered, or sent over the network?
2. Which process sees it, and how is it sanitized?
3. How is it deleted and when does it expire?
4. Which tests prove the default-off or consent behavior?
5. Does the documentation still match runtime behavior?

Security reports should use [SECURITY.md](SECURITY.md), not a public pull request.
