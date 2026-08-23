# DeskLore icon assets

`icon-source.png` is the original DeskLore icon master created for this repository on 2026-08-23
with OpenAI's built-in image generation tool. It does not reuse the previous Computer History icon
or a third-party logo.

Final generation brief:

> Create an original native macOS icon for DeskLore using three simplified overlapping archival
> cards connected by one timeline path with three milestones. Use a deep graphite and muted indigo
> plate, warm ivory cards, and one restrained amber milestone. Keep the geometry legible at 32px,
> with no text, clocks, cameras, monitors, brains, clouds, sparkles, or watermark.

Derived assets:

- `icon.png`: 1024×1024 RGBA Dock/development asset with macOS optical padding.
- `icon.icns`: packaged macOS icon containing all standard 16px through 1024px representations.

The derived files are built with the `desktop-app-icon` skill's deterministic macOS icon builder.
If the source changes, regenerate and verify both PNG and ICNS consumers rather than editing only
one output.
