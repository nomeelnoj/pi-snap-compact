/**
 * pi-snap-compact — deterministic bitmap-frame compaction for pi.
 *
 * Replaces the LLM summarization call in compaction with a local, deterministic
 * archival pass: discarded history is serialized, normalized, and printed onto
 * PNG frames that a vision-capable model reads back directly. No model call,
 * no API key, no network.
 *
 * Wiring:
 *  - `session_before_compact`: run the archival pass; write frame PNGs to a
 *    per-compaction directory beside the session file and persist file
 *    references (not inline base64) under CompactionEntry.details.snapcompact.
 *    Falls back to pi's default compaction when the current model cannot read
 *    images or when /compact carries directed instructions.
 *  - `session_compact`: index the new archive for context injection, clean up
 *    the superseded archive's frame directory, and post a footer status.
 *  - `context`: before every LLM call, expand archived compaction summaries
 *    into ordered blocks (text head, imaged middle, text tail) — or into a
 *    bounded plain-text rendering when the current model lacks vision.
 *  - `/snapcompact [status|on|off]`: inspect or toggle the extension.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	ARCHIVE_CLOSE,
	ARCHIVE_OPEN,
	archiveBlocks,
	frameFileMatches,
	frameFileName,
	FRAMES_DIR_PREFIX,
	getArchive,
	isFramesDirName,
	signArchive,
	verifyArchive,
	type Archive,
	type Frame,
} from "../src/archive.ts";
import { compact, resolveShapeForText, type CompactResult } from "../src/compact.ts";
import { loadOrCreateKey, verificationDisabled } from "../src/integrity.ts";
import { elideDataUrls, toPlainText } from "../src/serialize.ts";
import { loadSettings, type SnapcompactSettings } from "../src/settings.ts";
import { describeShape, resolveShape, type ShapeTarget } from "../src/shapes.ts";

/** Max chars of archive source text replayed as plain text for non-vision models. */
const TEXT_FALLBACK_CHARS = 24_000;

interface ModelLike {
	id?: string;
	provider?: string;
	api?: string;
	input?: string[];
}

function isVisionCapable(model: ModelLike | undefined): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

function shapeTarget(model: ModelLike | undefined): ShapeTarget | undefined {
	if (!model) return undefined;
	return { api: model.api, id: model.id, provider: model.provider };
}

function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

export default function (pi: ExtensionAPI) {
	let settings: SnapcompactSettings = loadSettings(process.cwd());
	/** compaction-entry timestamp (epoch ms) → archive, for correlating context rebuilds. */
	const archives = new Map<number, Archive>();
	/** Leaf id the archive map was built for; rebuilt lazily on navigation. */
	let indexedLeaf: string | null = null;
	/** Last compaction's stats, for the status command. */
	let lastRun: { at: string; stats: CompactResult["stats"]; reason: string } | null = null;
	/** Frame directory of the archive a successful compaction supersedes;
	 *  removed only after the new compaction persists. */
	let supersededFramesDir: string | undefined;
	/** Per-machine HMAC key; loaded lazily, undefined when unavailable. */
	let signingKey: Uint8Array | undefined | null = null;
	/** Archives on the current leaf that failed verification (for status/warnings). */
	let rejectedArchives = 0;
	let warnedRejected = false;

	const key = (): Uint8Array | undefined => {
		if (signingKey === null) signingKey = loadOrCreateKey();
		return signingKey;
	};

	/**
	 * Extract and authenticate a persisted archive. Unsigned, tampered, or
	 * foreign archives return undefined so they are never replayed to the
	 * model; the entry's own summary string still shows as pi wrote it.
	 */
	const trustedArchive = (details: Record<string, unknown> | undefined): Archive | undefined => {
		const archive = getArchive(details);
		if (!archive) return undefined;
		if (verificationDisabled()) return archive;
		const k = key();
		if (k && verifyArchive(archive, k)) return archive;
		rejectedArchives++;
		return undefined;
	};

	const warnIfRejected = (ctx: ExtensionContext) => {
		if (rejectedArchives === 0 || warnedRejected) return;
		warnedRejected = true;
		ctx.ui.notify(
			`snapcompact: ${rejectedArchives} archived compaction${rejectedArchives === 1 ? "" : "s"} failed verification and will not be replayed (unsigned, modified, or signed on another machine). The text summaries remain. See README § Integrity.`,
			"warning",
		);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!settings.enabled) {
			ctx.ui.setStatus("snapcompact", undefined);
			return;
		}
		const last = lastRun ? `${lastRun.stats.frames}f/${Math.round(lastRun.stats.totalChars / 1000)}k` : "ready";
		ctx.ui.setStatus("snapcompact", `snap:${last}`);
	};

	const reindex = (ctx: ExtensionContext) => {
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId === indexedLeaf && archives.size > 0) return;
		indexedLeaf = leafId;
		archives.clear();
		rejectedArchives = 0;
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			const e = entry as { type?: string; timestamp?: string; details?: Record<string, unknown> };
			if (e.type !== "compaction" || typeof e.timestamp !== "string") continue;
			const archive = trustedArchive(e.details);
			if (archive) archives.set(new Date(e.timestamp).getTime(), archive);
		}
		warnIfRejected(ctx);
	};

	/** Write frame PNGs to disk as content-addressed files and rewrite the
	 *  archive's frames as file refs. Identical frames share one file. */
	const externalizeFrames = (ctx: ExtensionContext, result: CompactResult): void => {
		const archive = result.details.snapcompact as Archive;
		if (!archive || result.framePngs.length === 0) return;
		const dirName = `${FRAMES_DIR_PREFIX}${Date.now()}`;
		const absDir = join(ctx.sessionManager.getSessionDir(), dirName);
		mkdirSync(absDir, { recursive: true });
		const written = new Set<string>();
		archive.frames = archive.frames.map((frame, i): Frame => {
			const png = result.framePngs[i];
			const file = frameFileName(png);
			if (!written.has(file)) {
				writeFileSync(join(absDir, file), png);
				written.add(file);
			}
			return { ...frame, data: "", file };
		});
		archive.framesDir = dirName;
	};

	/** Sign the archive over its normalized form (what getArchive() will hand
	 *  back on load), so verification compares like with like. */
	const signResult = (result: CompactResult): boolean => {
		const archive = result.details.snapcompact as Archive | undefined;
		if (!archive) return true;
		const k = key();
		if (!k) return false;
		const normalized = getArchive({ snapcompact: archive });
		if (!normalized) return true; // empty archive: nothing to replay, nothing to sign
		archive.mac = signArchive(normalized, k);
		return true;
	};

	/** Delete a plugin-created frame directory. Only names matching the exact
	 *  shape this extension generates are ever removed. */
	const removeFramesDir = (ctx: ExtensionContext, dirName: string | undefined): void => {
		if (!isFramesDirName(dirName)) return;
		rmSync(join(ctx.sessionManager.getSessionDir(), dirName), { recursive: true, force: true });
	};

	pi.on("session_start", async (_event, ctx) => {
		settings = loadSettings(ctx.cwd);
		indexedLeaf = null; // force reindex on next context build
		updateStatus(ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		const entry = event.compactionEntry as unknown as { timestamp?: string; details?: Record<string, unknown> };
		if (typeof entry.timestamp !== "string") return;
		const archive = trustedArchive(entry.details);
		if (archive) archives.set(new Date(entry.timestamp).getTime(), archive);
		// The new archive re-rendered from source; the superseded archive's
		// frames are orphaned — remove them now that the compaction persisted.
		if (archive) {
			removeFramesDir(ctx, supersededFramesDir);
			supersededFramesDir = undefined;
		}
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!settings.enabled) return; // default LLM compaction
		// Directed summaries (/compact <instructions>) imply an LLM pass.
		if (event.customInstructions) return;

		const model = ctx.model as ModelLike | undefined;
		if (!isVisionCapable(model)) {
			ctx.ui.notify("snapcompact: current model cannot read images — using default summarization", "info");
			return;
		}

		if (!verificationDisabled() && !key()) {
			ctx.ui.notify(
				"snapcompact: cannot read or create the archive signing key — using default summarization (set PI_SNAPCOMPACT_VERIFY=off to run unsigned)",
				"warning",
			);
			return;
		}

		const { preparation } = event;
		// Find the previous compaction entry's details (for archive continuity).
		// Its archive is folded into the new one and re-signed, so it must
		// authenticate first; an untrusted previous archive is dropped and the
		// pass continues from pi's previous summary string instead.
		let previousDetails: Record<string, unknown> | undefined;
		let previousFramesDir: string | undefined;
		for (let i = event.branchEntries.length - 1; i >= 0; i--) {
			const entry = event.branchEntries[i] as { type?: string; details?: Record<string, unknown> };
			if (entry.type === "compaction") {
				const raw = getArchive(entry.details);
				const trusted = trustedArchive(entry.details);
				if (raw && !trusted) {
					ctx.ui.notify(
						"snapcompact: previous archive failed verification; continuing from its text summary only",
						"warning",
					);
				}
				previousDetails = trusted ? entry.details : undefined;
				previousFramesDir = raw?.framesDir;
				break;
			}
		}

		const count = preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
		ctx.ui.notify(`snapcompact: archiving ${count} messages (${formatCount(preparation.tokensBefore)} tokens)…`, "info");

		try {
			const result = compact(
				{
					firstKeptEntryId: preparation.firstKeptEntryId,
					messagesToSummarize: convertToLlm(preparation.messagesToSummarize),
					turnPrefixMessages: convertToLlm(preparation.turnPrefixMessages),
					tokensBefore: preparation.tokensBefore,
					previousSummary: preparation.previousSummary,
					previousDetails,
					fileOps: preparation.fileOps,
				},
				{
					model: shapeTarget(model),
					variant: settings.shape,
					maxFrames: settings.maxFrames,
					includeThinking: settings.includeThinking,
					dimToolResults: settings.dimToolResults,
				},
			);

			externalizeFrames(ctx, result);
			if (!signResult(result)) throw new Error("archive signing key unavailable");
			// The new archive's source text supersedes the previous archive's
			// frames (re-rendered from source); its directory becomes garbage,
			// removed on session_compact once this compaction has persisted.
			supersededFramesDir = previousFramesDir;

			lastRun = { at: new Date().toISOString(), stats: result.stats, reason: event.reason };
			updateStatus(ctx);
			ctx.ui.notify(
				`snapcompact: ${formatCount(result.stats.totalChars)} chars onto ${result.stats.frames} frame${result.stats.frames === 1 ? "" : "s"}` +
					(result.stats.textChars > 0 ? ` (+${formatCount(result.stats.textChars)} chars as text)` : "") +
					(result.stats.truncatedChars > 0 ? `, ${formatCount(result.stats.truncatedChars)} chars dropped` : "") +
					` [${result.stats.shape}]`,
				"info",
			);

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					details: result.details,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`snapcompact failed: ${message} — falling back to default compaction`, "error");
			return;
		}
	});

	pi.on("context", async (event, ctx) => {
		if (archives.size === 0 && indexedLeaf !== null) return;
		reindex(ctx);
		if (archives.size === 0) return;

		const model = ctx.model as ModelLike | undefined;
		const vision = isVisionCapable(model);
		const sessionDir = ctx.sessionManager.getSessionDir();
		let changed = false;

		const messages = event.messages.map(msg => {
			if (msg.role !== "compactionSummary") return msg;
			const archive = archives.get((msg as { timestamp?: number }).timestamp ?? -1);
			if (!archive) return msg;
			changed = true;

			const summary = (msg as { summary: string }).summary;
			if (vision) {
				// Expand to lead-in + text head + image frames + text tail. Use the
				// persisted lead-in (not msg.summary) so the display-only text edges
				// appended to the summary are not injected twice; archives written
				// before leadIn existed keep the summary as the lead block.
				const blocks = archiveBlocks(archive, {
					maxFrameBytes: settings.maxFrameBytes,
					resolveFile: (frame: Frame) => {
						if (!archive.framesDir || !frame.file) return undefined;
						// getArchive() already allow-listed both names by exact shape (no
						// path components possible). Re-verify containment against the
						// resolved session directory anyway before touching disk, and
						// reject any file whose bytes no longer hash to its own name.
						const framesDirAbs = resolve(sessionDir, archive.framesDir);
						const filePath = resolve(framesDirAbs, frame.file);
						if (!filePath.startsWith(framesDirAbs + sep)) return undefined;
						try {
							const png = readFileSync(filePath);
							return frameFileMatches(frame.file, png) ? png.toString("base64") : undefined;
						} catch {
							return undefined;
						}
					},
				});
				const content = [
					{ type: "text", text: archive.leadIn ?? summary },
					...blocks.map(block =>
						block.type === "image"
							? { type: "image", data: block.data as string, mimeType: block.mimeType as string }
							: { type: "text", text: block.text as string },
					),
				];
				return { role: "user", content, timestamp: msg.timestamp } as unknown as ContextMessage;
			}

			// Non-vision fallback: the model cannot read the frames, so replay the
			// archive source as bounded plain text. When the summary already
			// carries the text edges (leadIn present), replay only the imaged
			// middle — the part the summary lacks.
			let source =
				archive.text ??
				[archive.textHead, archive.textTail].filter((p): p is string => !!p && p.length > 0).join("\n");
			if (archive.leadIn) {
				if (archive.textHead && source.startsWith(archive.textHead)) source = source.slice(archive.textHead.length);
				if (archive.textTail && source.endsWith(archive.textTail)) source = source.slice(0, source.length - archive.textTail.length);
			}
			const plain = elideDataUrls(toPlainText(source), "archive");
			const bounded =
				plain.length > TEXT_FALLBACK_CHARS
					? `${plain.slice(0, TEXT_FALLBACK_CHARS / 2)}\n[…${plain.length - TEXT_FALLBACK_CHARS}ch of archived history omitted for a non-vision model…]\n${plain.slice(-TEXT_FALLBACK_CHARS / 2)}`
					: plain;
			if (!bounded.trim()) return msg; // summary already carries everything
			return {
				role: "user",
				content: [{ type: "text", text: `${summary}\n\n${ARCHIVE_OPEN}\n${bounded}\n${ARCHIVE_CLOSE}` }],
				timestamp: msg.timestamp,
			} as unknown as ContextMessage;
		});

		type ContextMessage = (typeof event.messages)[number];
		return changed ? { messages } : undefined;
	});

	pi.registerCommand("snapcompact", {
		description: "snapcompact status and control: /snapcompact [status|on|off]",
		getArgumentCompletions: prefix =>
			["status", "on", "off"].filter(a => a.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				settings = { ...settings, enabled: arg === "on" };
				updateStatus(ctx as unknown as ExtensionContext);
				ctx.ui.notify(`snapcompact ${arg === "on" ? "enabled" : "disabled"} for this session`, "info");
				return;
			}
			// status (default)
			reindex(ctx as unknown as ExtensionContext);
			const model = ctx.model as ModelLike | undefined;
			const shape = resolveShapeForText("", shapeTarget(model), settings.shape);
			let totalFrames = 0;
			let totalChars = 0;
			let totalTruncated = 0;
			for (const archive of archives.values()) {
				totalFrames += archive.frames.length;
				totalChars += archive.totalChars;
				totalTruncated += archive.truncatedChars;
			}
			const lines = [
				`snapcompact ${settings.enabled ? "enabled" : "DISABLED"}`,
				`  model: ${model?.id ?? "unknown"} (vision: ${isVisionCapable(model) ? "yes" : "no"})`,
				`  shape: ${settings.shape === "auto" ? "auto → " : ""}${describeShape(shape)}`,
				`  archives this session: ${archives.size} (${totalFrames} frames, ${formatCount(totalChars)} chars${totalTruncated > 0 ? `, ${formatCount(totalTruncated)} dropped` : ""})`,
				`  integrity: ${verificationDisabled() ? "verification OFF (PI_SNAPCOMPACT_VERIFY)" : key() ? "HMAC-SHA256, per-machine key" : "NO KEY — compaction disabled"}${rejectedArchives > 0 ? `, ${rejectedArchives} archive${rejectedArchives === 1 ? "" : "s"} rejected` : ""}`,
			];
			if (lastRun) {
				lines.push(
					`  last run (${lastRun.reason}): ${formatCount(lastRun.stats.totalChars)} chars → ${lastRun.stats.frames} frames + ${formatCount(lastRun.stats.textChars)} text chars [${lastRun.stats.shape}]`,
				);
			}
			lines.push(`  settings: shape=${settings.shape} maxFrames=${settings.maxFrames ?? 80} maxFrameBytes=${settings.maxFrameBytes ?? 3_000_000} thinking=${settings.includeThinking} dim=${settings.dimToolResults}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
