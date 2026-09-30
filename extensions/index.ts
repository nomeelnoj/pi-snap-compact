/**
 * pi-snap-compact — deterministic bitmap-frame compaction for pi.
 *
 * Replaces the LLM summarization call in compaction with a local, deterministic
 * archival pass: discarded history is serialized, normalized, and printed onto
 * PNG frames that a vision-capable model reads back directly. No model call,
 * no API key, no network.
 *
 * Wiring:
 *  - `session_before_compact`: run the archival pass and return its result,
 *    persisting the frame archive under `CompactionEntry.details.snapcompact`.
 *    Falls back to pi's default compaction when the current model cannot read
 *    images or when /compact carries directed instructions.
 *  - `session_compact`: index the new archive for context injection.
 *  - `context`: before every LLM call, expand archived compaction summaries
 *    into ordered blocks (text head, imaged middle, text tail) — or into a
 *    bounded plain-text rendering when the current model lacks vision.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { archiveBlocks, getArchive, type Archive } from "../src/archive.ts";
import { compact } from "../src/compact.ts";
import { toPlainText, elideDataUrls } from "../src/serialize.ts";
import { loadSettings, type SnapcompactSettings } from "../src/settings.ts";
import type { ShapeTarget } from "../src/shapes.ts";

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

export default function (pi: ExtensionAPI) {
	let settings: SnapcompactSettings = loadSettings(process.cwd());
	/** compaction-entry timestamp → archive, for correlating context rebuilds. */
	const archives = new Map<number, Archive>();
	/** Leaf id the archive map was built for; rebuilt lazily on navigation. */
	let indexedLeaf: string | null = null;

	const reindex = (ctx: { sessionManager: { getLeafId(): string | null; buildContextEntries(): unknown[] } }) => {
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId === indexedLeaf && archives.size > 0) return;
		indexedLeaf = leafId;
		archives.clear();
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			const e = entry as { type?: string; timestamp?: string; details?: Record<string, unknown> };
			if (e.type !== "compaction" || typeof e.timestamp !== "string") continue;
			const archive = getArchive(e.details);
			if (archive) archives.set(new Date(e.timestamp).getTime(), archive);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		settings = loadSettings(ctx.cwd);
		indexedLeaf = null; // force reindex on next context build
	});

	pi.on("session_compact", async (event) => {
		// Entry timestamps are ISO strings; message timestamps are epoch ms.
		const entry = event.compactionEntry as unknown as { timestamp?: string; details?: Record<string, unknown> };
		if (typeof entry.timestamp !== "string") return;
		const archive = getArchive(entry.details);
		if (archive) archives.set(new Date(entry.timestamp).getTime(), archive);
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

		const { preparation } = event;
		// Find the previous compaction entry's details (for archive continuity).
		let previousDetails: Record<string, unknown> | undefined;
		for (let i = event.branchEntries.length - 1; i >= 0; i--) {
			const entry = event.branchEntries[i] as { type?: string; details?: Record<string, unknown> };
			if (entry.type === "compaction") {
				previousDetails = entry.details;
				break;
			}
		}

		const count = preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
		ctx.ui.notify(`snapcompact: archiving ${count} messages (${preparation.tokensBefore.toLocaleString()} tokens)…`, "info");

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

			ctx.ui.notify(
				`snapcompact: ${result.stats.totalChars.toLocaleString()} chars onto ${result.stats.frames} frame${result.stats.frames === 1 ? "" : "s"}` +
					(result.stats.textChars > 0 ? ` (+${result.stats.textChars.toLocaleString()} chars as text)` : "") +
					(result.stats.truncatedChars > 0 ? `, ${result.stats.truncatedChars.toLocaleString()} chars dropped` : ""),
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
		let changed = false;

		type ContextMessage = (typeof event.messages)[number];
		const messages: ContextMessage[] = event.messages.map((msg): ContextMessage => {
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
				const blocks = archiveBlocks(archive, { maxFrameBytes: settings.maxFrameBytes });
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
				content: [{ type: "text", text: `${summary}\n\n${bounded}` }],
				timestamp: msg.timestamp,
			} as unknown as ContextMessage;
		});

		return changed ? { messages } : undefined;
	});
}
