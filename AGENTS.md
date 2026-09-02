# DeskLore repository guide

DeskLore is a local-first macOS desktop app. Keep privacy and process boundaries visible in the
directory structure; the detailed design is in `docs/ARCHITECTURE.md`. The product definition,
load-bearing commitments, and layer model are in `docs/DIRECTION.md`; place new code in the layer
it belongs to.

## Repository map

- `src/desktop/`: Electron main/preload/React renderer; UI and OS integration only.
- `src/server/`: ServerCore utility-process runtime, history domains, and external adapters.
- `src/shared/`: structured-cloneable DTOs, defaults, i18n, and model validation.
- `src/platform/`: reusable Node platform primitives with no Electron dependency.
- `native/collector/`: independent Swift package for macOS capture and native redaction.
- `evaluation/`: offline evaluators and their tests; outputs stay under private `.eval-data/`.
- `scripts/`: build, packaging, and process-smoke entrypoints.
- `resources/branding/`: application icon sources and derived assets.

## Boundaries

- Renderer code uses `window.desklore` and shared DTOs; never import Node, Electron, or server code.
- Preload exposes the smallest typed API. Electron main may depend on `server/api`, not ServerCore
  internals.
- ServerCore owns policy, persistence, timeline details and rollups, usage, and optional model/visual work.
- The Swift collector owns Accessibility and ScreenCaptureKit access. It emits sanitized NDJSON;
  it does not write history or call models.
- Raw events and API keys never enter the renderer. Screenshots remain transient and are not stored.
- Put tests next to the module they verify; use only synthetic activity fixtures.

## Verification

Run `pnpm check` and `pnpm test` for normal changes. Run `pnpm build` when process entries, native
code, or packaging paths change. Run `pnpm site:build` for website changes. Keep generated `dist/`,
`out/`, `release/`, `site-dist/`, `.build/`, and private `.eval-data/` out of Git.
