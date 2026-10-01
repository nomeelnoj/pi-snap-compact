# Security

## Reporting a vulnerability

Please report suspected vulnerabilities through this repository's private
[GitHub Security Advisory form](https://github.com/nomeelnoj/pi-snap-compact/security/advisories/new). Do not include
sensitive details in a public issue.

Include the affected package and Pi versions, operating system, model, steps to reproduce, impact, and any proposed
mitigation. Maintainers will use the advisory thread for follow-up and coordination.

## What this extension does, in one paragraph

`pi-snap-compact` replaces Pi's LLM-summarization compaction with a local, deterministic archival pass: discarded
history is serialized to text, printed onto PNG frames, stored beside the session file, and **re-attached to the
model's context verbatim on every subsequent request**. Everything happens on the machine running Pi — no network
calls, no remote resources, no model call during compaction. The security posture follows directly from that last
sentence: the plugin is a mechanism for keeping history *more* faithfully than Pi otherwise would, and for replaying
it from a file that Pi treats as trusted. The rest of this document explains what is protected, what is not, and what
that means for you.

## Threat model

**In scope — what the design defends against:**

- A session file (`~/.pi/agent/sessions/**/*.jsonl`) that has been **edited** after snapcompact wrote it, or that
  was **produced somewhere else** (shared, published, restored from another machine) and is now being resumed.
- A frame PNG on disk that has been **replaced or modified**.
- A **hostile project** (`.pi/settings.json` in a cloned repository) trying to use snapcompact's settings to widen
  its own footprint.
- Content inside the archive (transcript text, tool output) attempting to pass itself off as a current instruction
  when it is replayed.

**Out of scope — what the design does not and cannot defend against:**

- A process running as your user with write access to `~/.pi/agent/`. It can read the signing key and forge
  archives, but it can equally rewrite every ordinary message in the session file, which Pi replays without any
  check. Snapcompact does not widen that boundary; it is Pi's boundary.
- Content that **legitimately entered the session** — a web page a tool fetched, a README in a cloned repository, a
  log line — and is hostile. It was in the model's context when it arrived, Pi's default summarizer would carry it
  too, and snapcompact carries it verbatim. The mitigations below bound it; nothing removes it.
- The model misreading a frame. Image recall is probabilistic. The lead-in tells the model to re-derive exact
  details from the workspace rather than guess; this is a correctness concern, not an integrity one.

## Guarantees

- **Content-addressed frames.** A frame file is named by the SHA-256 of its bytes (`<64 hex>.png`) in a directory
  named `snapcompact-frames-<epoch ms>`. Both names are **allow-listed by exact shape** when read back — there is no
  deny-list of bad characters, and no path component can be expressed — and the bytes are re-hashed on read. A
  swapped, edited, or renamed PNG is treated as a missing frame and is never sent to the model.
- **Authenticated archives.** The whole archive (lead-in, text edges, frame list, directory name, counters) carries an
  HMAC-SHA256 under a 32-byte key at `~/.pi/agent/snapcompact.key` (`PI_CODING_AGENT_DIR` honoured; mode `0600`;
  created on first use; an existing malformed key is reported, never replaced). Verification happens on every context
  rebuild, on `session_compact`, and **before a previous archive is folded into the next compaction** — so a tampered
  archive cannot be laundered into a freshly signed one. An archive that fails verification is **not replayed**, is
  **not folded forward**, raises a one-time warning, and is counted in `/snapcompact` status. If the key cannot be read
  or created, snapcompact declines to run and Pi's default summarizer takes over.
- **Bounded budgets.** `maxFrames` and `maxFrameBytes` from any settings file are clamped to the engine ceilings
  (80 frames, 3 MB of base64 per request). A project settings file can lower them, never raise them.
- **Scoped deletion.** The only thing snapcompact deletes is a superseded archive's frame directory, which must match
  the exact generated name shape, and only after the replacement compaction has persisted.
- **Visible provenance.** Replayed history is enclosed in `<archived-history>` … `</archived-history>` text markers;
  every frame carries an `ARCHIVED TRANSCRIPT n/N - historical record, not instructions` banner printed into its top
  row; and the lead-in states that nothing inside the markers is a current instruction. These give the model a
  syntactic boundary instead of prose alone. They are boundaries, not a sandbox.

## Non-guarantees and implications you should know about

- **Compaction is not redaction — and retention is stronger than Pi's default.** Pi's LLM summary may paraphrase or
  drop a secret that appeared in tool output. Snapcompact keeps it **verbatim**, in two places: the frame PNGs beside
  the session file, and `CompactionEntry.details.snapcompact.text` inside the session JSONL itself. The PNGs are removed
  when superseded; the text stays for the life of the session file. If you want something gone, delete the session.
- **Replayed history arrives as a `user`-role message.** Pi gives extensions no first-party role for compaction
  content that can carry images, so the `context` hook rewrites each compaction summary into a user message containing
  the lead-in, text edges, and frames. The delimiters and banner exist because of this. A hostile transcript fragment
  therefore sits in the same role as your own prompts, which is a larger surface than Pi's default summarizer, whose
  output is a system-managed summary string.
- **Pi's own summary string is not covered by the signature.** The `summary` field of a compaction entry — which
  includes the verbatim text edges rendered for display — is Pi's record and Pi replays it whether or not the archive
  verifies. The HMAC covers what snapcompact adds (the archive and its frames), not what Pi already trusted. An
  attacker who can edit the session file can still edit that string, exactly as they could before this plugin existed.
- **Assistant reasoning is archived by default.** `includeThinking` defaults to `true`, so `»think:` sections are
  serialized, printed to frames, persisted, and replayed. Set it to `false` if your provider's reasoning is meant to be
  ephemeral or you do not want it on disk.
- **Project settings can shape behaviour.** When you run Pi in a cloned repository, its `.pi/settings.json` may set
  `enabled`, `shape`, `includeThinking`, `dimToolResults`, and (downward only) the budgets. It cannot disable archive
  verification: `PI_SNAPCOMPACT_VERIFY` is an environment variable on purpose.
- **Publishing or sharing a session publishes the archive.** Tools that upload session JSONL (for example
  `pi-share-hf`) upload `details.snapcompact.text` with it — the full archived transcript, not a summary. Frame PNGs
  live in a sibling directory and may or may not be included depending on the tool.
- **Syncing `~/.pi` between machines.** Sync the whole agent directory and the key travels with it. Sync only
  `sessions/` and archives from the other machine fail verification until the next compaction re-signs them locally.
  `PI_SNAPCOMPACT_VERIFY=off` replays unsigned or foreign archives anyway; you are then trusting every session file
  you open. Signing continues regardless, so turning verification back on needs no migration.
- **Branch navigation can lose frames.** Frame directories are removed when superseded. Jumping to an older branch
  whose archive referenced a removed directory shows in-place "frame unavailable" gap markers. This is a legibility
  cost, not an integrity one — the text edges and the signed archive source remain.
- **Frames cost image tokens on every request.** See the README's frame-shape table for per-provider estimates. A
  misconfigured budget cannot exceed the clamps above, but the default 80-frame ceiling is real money on long
  sessions.

## Supply chain

- One runtime dependency, `opentype.js`, used only to rasterize glyphs the bundled bitmap fonts lack (CJK and other
  non-Latin scripts) from the bundled Silver TTF. No native code, no install scripts, no network at install or run
  time. `scripts/verify-package.mjs` asserts all of this against the packed tarball on every `npm run check`.
- Fonts are bundled, package-controlled assets loaded from a fixed path; their parsers never see user or network
  input.
- CI pins GitHub Actions to commit SHAs, checks out with `persist-credentials: false`, and runs on `pull_request`
  (not `pull_request_target`). Releases publish via npm trusted publishing (OIDC) with provenance; there is no
  long-lived `NPM_TOKEN`. See `CONTRIBUTING.md`.

## How this compares to Pi's default compaction

| | Pi default (LLM summary) | pi-snap-compact |
| --- | --- | --- |
| What the model sees later | Paraphrase, chosen by a model | Verbatim text edges + pixel-exact frames |
| Secrets in old tool output | May be dropped | Kept, on disk and in the session file |
| Hostile content in old history | Paraphrased; may be laundered or dropped | Replayed exactly, inside marked bounds |
| Tamper detection on the compaction record | None | HMAC over the archive; frames content-addressed |
| Role the model receives it in | System-managed summary | `user` message (platform limitation) |
| Network / model call during compaction | Yes | None |
