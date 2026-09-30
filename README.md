# @nomeelnoj/pi-snap-compact

Deterministic bitmap-frame context compaction for [pi](https://github.com/earendil-works/pi-coding-agent),
for vision-capable models.

When pi's context window fills up, the default compaction asks an LLM to summarize the discarded history.
This package replaces that LLM call with a **local, deterministic archival pass**: the discarded history is
serialized to dense text and printed onto PNG frames using bundled pixel fonts, and the frames are re-attached
to the context on every subsequent request. The model reads its own history back as images.

No model call, no API key, no network — so it is also safe during overflow recovery.

*Derived from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s
[`@oh-my-pi/snapcompact`](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md#snapcompact-method) (MIT).
The serialization, normalization, layout-planning, archive, and shape modules are adapted from its TypeScript
source; the renderer is a TypeScript port of its Rust `pi-natives` crate; the Pi extension wiring, settings, and
tests are original to this package. See [NOTICE.md](NOTICE.md) for the file-by-file breakdown and
[Attribution](#attribution).*

## How it works

1. **Serialize** — discarded messages flatten into a section-tagged transcript (`»user:`, `»think:`, `»ai:`,
   `»tool:`). Tool results are truncated head+tail (default 2,000 chars, 60% head), tool-call argument values
   are capped (500 per value, 2,000 per call), tool output prints in dim gray ink, and inline base64 data URLs
   collapse to a metadata placeholder.
2. **Normalize** — ANSI escapes stripped, whitespace collapsed (newline runs become one solid black cell),
   punctuation/emoji folded to ASCII, non-Latin glyphs kept only when the selected font or the bundled Silver
   fallback can draw them.
3. **Render** — text prints onto PNG frames: width fixed per shape, height hugs the printed rows. Grid shapes
   place one character per cell with no word wrap; `doc-*` shapes lay out two word-wrapped columns.
4. **Archive** — frames plus the bounded source text persist in `CompactionEntry.details.snapcompact`. Each
   later compaction re-renders from that source rather than carrying stale PNGs forward.
5. **Rebuild** — on every LLM request the `context` hook expands the archive into ordered blocks: plain text
   at the oldest edge, image frames in the middle, plain text at the newest edge. If the current model cannot
   read images, the archive replays as bounded plain text instead.

### Frame shapes

The shape resolves from the model id (not just the wire API — a Claude routed through a gateway keeps its
Claude geometry, priced for the gateway carrying the request):

| Reader                       | Shape         | Frame  | Why                                                              |
| ---------------------------- | ------------- | ------ | ---------------------------------------------------------------- |
| Claude Opus 4.7+, Fable, Mythos | `11on16-bw` | 1932px | Largest square under Anthropic's 4,784 visual-token cap          |
| Other Claude / unknown       | `11on16-bw`   | 1568px | 8x13 glyphs on an 11px advance (extra tracking), black ink       |
| Gemini 3.x                   | `8on22-bw`    | 2048px | Flat 1,120-token per-image budget — larger frames are free chars |
| GPT / Codex                  | `8on22-bw`    | 1568px | Patch billing is area-proportional; bigger frames gain nothing   |
| Kimi                         | `8on22-bw`    | 1568px | Image processor downscales past ~1792px                          |
| GLM                          | `8on16-bw`    | 1568px | Plain 8x13 grid at standard pitch                                |

`auto` selection is font-aware: when the default font cannot safely render the transcript, or wide CJK glyphs
dominate it, it switches to `silver16-bw` (the bundled Silver TrueType on a 16px grid).

Large archives foveate: when the imaged middle exceeds the frame budget, its own edges stay HQ while the
center renders on a denser tier (same pixels per frame, tighter cell), and the oldest center pages drop first.
`maxFrames` (default 80) is an upper limit, not a promised count; a per-request base64 payload budget
(default 3 MB) can also drop oldest-first frames, with gap markers left in place.

## Install

```bash
pi install /path/to/pi-snap-compact
# or from npm/git once published:
pi install npm:@nomeelnoj/pi-snap-compact
```

## Settings

Configured under the `snapcompact` key in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`
(project wins), with environment overrides:

```json
{
  "snapcompact": {
    "enabled": true,
    "shape": "auto",
    "maxFrames": 80,
    "maxFrameBytes": 3000000,
    "includeThinking": true,
    "dimToolResults": true
  }
}
```

| Setting           | Default   | Description                                                     |
| ----------------- | --------- | --------------------------------------------------------------- |
| `enabled`         | `true`    | Master switch; off = pi's default LLM compaction                |
| `shape`           | `"auto"`  | Force a research variant (e.g. `"8on22-bw"`, `"silver16-bw"`)   |
| `maxFrames`       | `80`      | Upper limit on archive frames per compaction (max 80)           |
| `maxFrameBytes`   | `3000000` | Per-request base64 budget when rebuilding context (max 3 MB)    |
| `includeThinking` | `true`    | Archive assistant reasoning sections                            |
| `dimToolResults`  | `true`    | Print tool output in dim ink                                    |

Env overrides: `PI_SNAPCOMPACT_ENABLED`, `PI_SNAPCOMPACT_SHAPE`, `PI_SNAPCOMPACT_MAX_FRAMES`.

Behavioral notes:

- Requires a vision-capable current model (`model.input` includes `"image"`); otherwise compaction falls back
  to pi's default summarizer.
- Manual `/compact <instructions>` implies a directed LLM summary, so snapcompact steps aside for it.
- Budgets can only be lowered. Project `.pi/settings.json` is untrusted input (it ships with a cloned
  repository), so `maxFrames` and `maxFrameBytes` are clamped to the engine ceilings above.
- Forced `shape` variants keep their geometry but are re-priced for the provider carrying the request.

## Development

```bash
npm install
npm run typecheck
npm test
```

Layout: `extensions/index.ts` is the pi entry point; `src/` holds the library (`serialize`, `normalize`,
`cells`, `raster`, `png`, `shapes`, `plan`, `archive`, `compact`, `settings`); `fonts/` the bundled faces.

## Attribution

- Core algorithm and most of the library code derive from
  [`@oh-my-pi/snapcompact`](https://github.com/can1357/oh-my-pi/tree/main/packages/snapcompact) by Can Bölük
  and Stencil Labs, Inc. (MIT), including the shape tuning table and provider billing formulas from its
  published research evals (`packages/snapcompact/research`). Thanks to its author for publishing both the code
  and the evals.
- Bundled fonts: X.org misc-fixed (public domain), Unscii (public domain, Viznut), Silver (CC BY 4.0,
  Poppy Works) — see `fonts/FONTS.md`.

## License

MIT (code), including the upstream `@oh-my-pi/snapcompact` copyright notice reproduced in `LICENSE`. Fonts keep
their own licenses — see `fonts/FONTS.md`. `NOTICE.md` lists which files derive from upstream.
