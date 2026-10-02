# Notices

`pi-snap-compact` is a derivative work of [`@oh-my-pi/snapcompact`](https://github.com/can1357/oh-my-pi) by
Can Bölük and Stencil Labs, Inc., published under the MIT License. Both the original and this package are MIT;
upstream's copyright notice is reproduced in [`LICENSE`](LICENSE) as that license requires.

## What derives from upstream

Reference point: `oh-my-pi` commit `79808c3bf8`, `@oh-my-pi/snapcompact` 18.4.5.

| File | Relationship to upstream |
| --- | --- |
| `src/cells.ts` | Adapted from `packages/snapcompact/src/snapcompact.ts` (grid-cell accounting, pagination, word wrap). Largely verbatim. |
| `src/plan.ts` | Adapted from the same file (foveated head/frames/tail layout planner). Largely verbatim. |
| `src/normalize.ts` | Adapted from the same file (ANSI strip, whitespace collapse, ASCII folding, stopword dimming, renderability scan). |
| `src/serialize.ts` | Adapted from the same file (section-tagged transcript serialization, head+tail truncation, data-URL elision, dim-marker stripping). Pi message types replace oh-my-pi's; `useless`-result and intent-field handling removed. |
| `src/compact.ts` | Adapted from the same file (`compact()` pass, shape-for-text resolution, thinking-section scrub, summary lead-in). |
| `src/archive.ts` | Adapted from the same file (archive validation, byte-budgeted rebuild into text/image blocks). Content-addressed on-disk frame references, their allow-list validation, HMAC signing/verification, the `<archived-history>` delimiters, and the frame banner are new. |
| `src/shapes.ts` | Shape variant table, model-id rules, and provider billing constants reproduced from the same file and its research evals (`packages/snapcompact/research`). |
| `src/fonts.ts`, `src/raster.ts`, `src/png.ts` | TypeScript ports of the Rust renderer in `crates/pi-natives/src/snapcompact.rs` (BDF/hex/TTF parsing, cell blitting, repeat bands, indexed/RGB PNG encoding). Reimplemented in a different language; structure follows the original. The reserved banner strip is new. |
| `fonts/` | The same bundled faces upstream embeds; see below for their own licenses. |

## What is original to this package

- `extensions/index.ts` — the Pi extension: `session_before_compact` / `session_compact` / `context` hook wiring,
  per-compaction frame directories beside the session file with deferred cleanup of superseded frames, the
  non-vision plain-text replay, the `/snapcompact` command, footer status, and the `[snapcompact]` summary header.
- `src/settings.ts` — Pi settings and `PI_SNAPCOMPACT_*` environment resolution.
- `src/integrity.ts` — per-machine archive signing key management.
- `test/`, `scripts/`, CI and release workflows.

## Bundled fonts

| File | Face | License |
| --- | --- | --- |
| `fonts/5x8.bdf`, `fonts/6x12.bdf`, `fonts/8x13.bdf` | X.org misc-fixed | Public domain |
| `fonts/unscii-8.hex` | Unscii 8x8 (Viznut) | Public domain |
| `fonts/Silver.ttf` | Silver (Poppy Works) | CC BY 4.0 — see `fonts/Silver.LICENSE` |

Details and sources are in [`fonts/FONTS.md`](fonts/FONTS.md).

## Repository conventions

The CI `check` gate, package-content verification, clean-install smoke test, GitHub Actions workflows, and
community-health files follow the conventions established by
[pi-copy-code](https://github.com/penumbral-labs/pi-copy-code) (MIT).
