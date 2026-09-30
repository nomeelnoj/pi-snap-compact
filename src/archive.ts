/**
 * Archive persistence and context-rebuild reconstruction.
 *
 * The archive lives under `CompactionEntry.details.snapcompact` as bounded
 * source text plus rendered frames. On each context rebuild it is expanded
 * into ordered content blocks: plain text at the oldest edge, image frames in
 * the middle, plain text at the newest edge. Oldest frames are dropped first
 * once the per-request payload budget is exceeded (mirroring how iterative
 * text summaries fade the oldest detail); gaps are marked in place so
 * chronology stays legible.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { NEWLINE_CELL } from "./normalize.ts";
import { elideDataUrls, toPlainText } from "./serialize.ts";

/** Key under CompactionEntry.details holding a frame archive. */
export const ARCHIVE_KEY = "snapcompact";

/** Conservative upper bound for one persisted frame's base64 payload. */
export const FRAME_BYTES_ESTIMATE = 170_000;
/**
 * Maximum frame base64 carried in every rebuilt provider request. Above this,
 * backends can accept the HTTP body but fail mid-stream; keep it independent
 * of visual-token budgeting.
 */
export const FRAME_BYTES_BUDGET = 3_000_000;

export interface Frame {
	/** Base64-encoded PNG. */
	data: string;
	mimeType: "image/png";
	cols: number;
	rows: number;
	/** Characters actually printed onto this frame. */
	chars: number;
	/** Shape metadata, for debugging and future re-render decisions. */
	font?: string;
	ink?: "bw" | "sent";
	repeat?: number;
	columns?: number;
}

export interface Archive {
	/** The summary lead-in (reading guide + file list), kept so context
	 *  rebuilds can use it without the display-only text edges the persisted
	 *  summary string carries. */
	leadIn?: string;
	/** Rendered frames, oldest → newest. Empty when everything fit in text. */
	frames: Frame[];
	/** Characters readable across all frames plus text regions. */
	totalChars: number;
	/** Characters dropped so far to respect the archive budget. */
	truncatedChars: number;
	/** Full kept archive source — re-rendered from scratch each compaction. */
	text?: string;
	/** Verbatim text region at the oldest edge. */
	textHead?: string;
	/** Verbatim text region at the newest edge. */
	textTail?: string;
}

/** Validate and extract a persisted archive from a details object. */
export function getArchive(details: Record<string, unknown> | undefined): Archive | undefined {
	const candidate = details?.[ARCHIVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const archive = candidate as Archive;
	const frames = Array.isArray(archive.frames)
		? archive.frames.filter(
				frame =>
					!!frame &&
					typeof frame.data === "string" &&
					frame.data.length > 0 &&
					frame.mimeType === "image/png" &&
					typeof frame.cols === "number" &&
					typeof frame.rows === "number" &&
					typeof frame.chars === "number",
			)
		: [];
	const text = typeof archive.text === "string" && archive.text.length > 0 ? archive.text : undefined;
	const textHead = typeof archive.textHead === "string" && archive.textHead.length > 0 ? archive.textHead : undefined;
	const textTail = typeof archive.textTail === "string" && archive.textTail.length > 0 ? archive.textTail : undefined;
	if (frames.length === 0 && text === undefined && textHead === undefined && textTail === undefined) return undefined;
	return {
		...(typeof archive.leadIn === "string" && archive.leadIn.length > 0 ? { leadIn: archive.leadIn } : {}),
		frames,
		totalChars: typeof archive.totalChars === "number" ? archive.totalChars : 0,
		truncatedChars: typeof archive.truncatedChars === "number" ? archive.truncatedChars : 0,
		...(text !== undefined ? { text } : {}),
		...(textHead !== undefined ? { textHead } : {}),
		...(textTail !== undefined ? { textTail } : {}),
	};
}

/** Persisted archive source as one flat string (for re-compaction). */
export function archiveSourceText(archive: Archive): string | undefined {
	const text =
		archive.text ??
		[archive.textHead, archive.textTail].filter((p): p is string => typeof p === "string" && p.length > 0).join(NEWLINE_CELL);
	return text.length > 0 ? elideDataUrls(toPlainText(text), "archive") : undefined;
}

// ---------------------------------------------------------------------------
// Rebuild blocks
// ---------------------------------------------------------------------------

export interface ContentBlock {
	type: "text" | "image";
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface RebuildOptions {
	/** Hard cap on image base64 bytes attached to one rebuilt request. */
	maxFrameBytes?: number;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
	return `${bytes} B`;
}

type Slot = Frame | { omittedBytes: number };

/** Keep frames that fit the byte budget, priced newest-first (the freshest
 *  history survives); dropped frames become in-place gap markers. */
function framesWithinBudget(frames: Frame[], maxBytes: number): Slot[] {
	const slots: Slot[] = new Array(frames.length);
	let used = 0;
	for (let i = frames.length - 1; i >= 0; i--) {
		const frame = frames[i];
		if (used + frame.data.length > maxBytes) {
			slots[i] = { omittedBytes: frame.data.length };
		} else {
			used += frame.data.length;
			slots[i] = frame;
		}
	}
	return slots;
}

function isOmitted(slot: Slot): slot is { omittedBytes: number } {
	return "omittedBytes" in slot;
}

const GAP_RULE = "--------------";

/**
 * Expand an archive into ordered content blocks for the rebuilt context:
 * text head, imaged middle, text tail.
 */
export function archiveBlocks(archive: Archive, options: RebuildOptions = {}): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	const maxBytes = options.maxFrameBytes ?? FRAME_BYTES_BUDGET;
	const slots = framesWithinBudget(archive.frames, maxBytes);
	const hasImages = slots.some(slot => !isOmitted(slot));

	if (archive.textHead) {
		const suffix = hasImages ? `\n${GAP_RULE} imaged middle below\n` : "";
		blocks.push({ type: "text", text: elideDataUrls(toPlainText(archive.textHead), "archive") + suffix });
	}

	let omittedCount = 0;
	let omittedBytes = 0;
	const flushOmitted = () => {
		if (omittedCount === 0) return;
		blocks.push({
			type: "text",
			text: [
				`${GAP_RULE} imaged middle section omitted`,
				`${omittedCount} archived frame${omittedCount === 1 ? "s" : ""} (${formatBytes(omittedBytes)} of base64) exceeded the per-request payload budget. The text edges and remaining frames stay available.`,
				GAP_RULE,
			].join("\n"),
		});
		omittedCount = 0;
		omittedBytes = 0;
	};
	for (const slot of slots) {
		if (isOmitted(slot)) {
			omittedCount++;
			omittedBytes += slot.omittedBytes;
			continue;
		}
		flushOmitted();
		blocks.push({ type: "image", data: slot.data, mimeType: slot.mimeType });
	}
	flushOmitted();

	if (archive.textTail) {
		const prefix = hasImages
			? `${GAP_RULE} imaged middle above\n`
			: archive.truncatedChars > 0 || slots.some(isOmitted)
				? `\n${GAP_RULE} middle history omitted above\n`
				: "";
		const tail = prefix + elideDataUrls(toPlainText(archive.textTail), "archive");
		const last = blocks[blocks.length - 1];
		if (last?.type === "text") {
			last.text += tail;
		} else {
			blocks.push({ type: "text", text: tail });
		}
	}

	return blocks;
}
