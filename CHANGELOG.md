# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-02

### Added

- Deterministic compaction for vision-capable models: discarded history is serialized, normalized, and rasterized
  onto model-aware PNG frames with bundled pixel fonts — no LLM summarization call, no network, no API key.
- Model-aware shape table (frame size, font, layout, ink, frame budget) for Anthropic, Google, OpenAI, and other
  providers, with per-request token pricing of each variant.
- Foveated layout: the oldest and newest edges of discarded history stay as verbatim text (reading like pi's
  default summary); the imaged middle rides as image frames.
- Tool-result dimming (dim gray ink between zero-width toggles), newline black-block cells, section prefixes
  (`»user:`, `»think:`, `»ai:`, `»tool:`) and `<out>…</out>` blocks for per-message structure on the grid.
- Bundled bitmap fonts (X.org misc-fixed 5x8, 6x12, 8x13; unscii 8x8) plus a bundled Silver TrueType fallback for
  scripts the bitmap faces do not cover (CJK, Hangul, Cyrillic, and friends), with automatic shape switching to
  the Silver grid when the default font cannot render the text or CJK density is high.
- Derived from `@oh-my-pi/snapcompact` (MIT); upstream copyright reproduced in `LICENSE`, file-level provenance
  in `NOTICE.md`.
- Frame PNGs persist as content-addressed files (`<sha256>.png`) beside the session file and are referenced (not
  embedded) from `CompactionEntry.details.snapcompact`; directory and file names are allow-listed by exact shape
  on read and frame bytes are re-hashed against their name. Superseded frame directories are cleaned up after the
  next compaction persists. Frames encode as indexed-palette PNGs with an RGB fallback.
- Archives are signed with HMAC-SHA256 under a per-machine key (`~/.pi/agent/snapcompact.key`, 0600); unsigned,
  edited, or foreign archives are not replayed and are never folded into a later compaction.
  `PI_SNAPCOMPACT_VERIFY=off` opts out of verification.
- Context rebuild via the `context` hook: archives expand into ordered blocks (text head, image frames, text
  tail) enclosed in `<archived-history>` markers on every request, with a byte budget that drops oldest frames
  first into in-place gap markers. Every frame carries an `ARCHIVED TRANSCRIPT n/N` banner in its top row.
  Non-vision models get a bounded plain-text replay instead of images.
- `/snapcompact` command (`status` / `on` / `off`), a persistent `snap:Nf/Mk` footer status, and a
  `[snapcompact]` header line on every archival summary.
- Settings via the `snapcompact` key in Pi settings (project overrides global) and `PI_SNAPCOMPACT_*` environment
  variables: `enabled`, `shape`, `maxFrames`, `maxFrameBytes`, `includeThinking`, `dimToolResults`.
- Falls back to Pi's default LLM compaction for non-vision models and for directed `/compact <instructions>`
  summaries.
