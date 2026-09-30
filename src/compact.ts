/**
 * The snap-compact pass: serialize discarded history, fold it into the
 * accumulated archive source, re-render the whole source into a foveated
 * text/image/text layout, and return a short text summary (resume lead-in +
 * file list) plus the archive for persistence.
 *
 * Fully local and deterministic: no model, no API key, no network. Safe for
 * overflow recovery for the same reason.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { getArchive, type Archive, type Frame } from "./archive.ts";
import { dimStopwordRuns, DIM_OFF, DIM_ON, NEWLINE_CELL, normalize, scanRenderability } from "./normalize.ts";
import { elideDataUrls, serializeConversation, toPlainText, type SerializeOptions } from "./serialize.ts";
import { MAX_FRAMES_DEFAULT, planArchive } from "./plan.ts";
import { rasterizeFrame } from "./raster.ts";
import { denseCompanion, gridGeometry, resolveShape, type Shape, type ShapeTarget, type ShapeVariantName } from "./shapes.ts";
import type { Message } from "@earendil-works/pi-ai";

export interface CompactPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: Message[];
	turnPrefixMessages: Message[];
	tokensBefore: number;
	previousSummary?: string;
	/** details payload of the previous compaction entry, if any. */
	previousDetails?: Record<string, unknown>;
	/** Cumulative file operations extracted by the host. */
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
}

export interface CompactOptions extends SerializeOptions {
	model?: ShapeTarget;
	shape?: Shape;
	/** Force a research variant instead of model-aware auto selection. */
	variant?: ShapeVariantName | "auto";
	maxFrames?: number;
}

export interface CompactResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Persist under CompactionEntry.details. */
	details: Record<string, unknown>;
	/** Frame/edge counts for the host's notification. */
	stats: { frames: number; totalChars: number; textChars: number; truncatedChars: number };
}

/**
 * Auto shape selection with font-awareness: when the model-default font
 * cannot safely render the text, or wide CJK glyphs dominate and the Silver
 * grid can render it safely, switch to silver16. Forced variants are never
 * overridden.
 */
export function resolveShapeForText(text: string, model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
	const shape = resolveShape(model, variant);
	if (variant && variant !== "auto") return shape;
	const silver = resolveShape(model, "silver16-bw");
	if (!scanRenderability(text, { font: shape.font }).isSafe) {
		return scanRenderability(text, { font: silver.font }).isSafe ? silver : shape;
	}
	if (shape.font !== "silver" && isCjkHeavy(text) && scanRenderability(text, { font: silver.font }).isSafe) {
		return silver;
	}
	return shape;
}

const CJK_HEAVY_MIN_WIDE = 8;
const CJK_HEAVY_RATIO = 0.25;

function isCjkHeavy(text: string): boolean {
	let graphics = 0;
	let wide = 0;
	for (const ch of text) {
		if (ch === " " || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_CELL) continue;
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (/[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u.test(ch)) continue;
		graphics++;
		if (
			(cp >= 0x2e80 && cp <= 0x33ff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xff00 && cp <= 0xff60)
		) {
			wide++;
		}
	}
	return wide >= CJK_HEAVY_MIN_WIDE && graphics > 0 && wide / graphics >= CJK_HEAVY_RATIO;
}

/** Drop »think: sections from serialized archive source. Re-compaction
 *  re-renders the whole unfolded source, so scrubbing heals archives written
 *  before reasoning was excluded. */
function stripThinkingSections(text: string): string {
	return text
		.split(NEWLINE_CELL)
		.map(segment =>
			segment
				.split(/\n\n(?=»(?:user|think|ai|tool):)/)
				.filter(section => !section.startsWith("»think:"))
				.join("\n\n"),
		)
		.filter(segment => segment.length > 0)
		.join(NEWLINE_CELL);
}

/** Grouped file list for the summary's FILES section. */
function formatFileList(readFiles: string[], modifiedFiles: string[], readSet: ReadonlySet<string>): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, string>();
	for (const f of readFiles) mode.set(f, "read");
	for (const f of modifiedFiles) mode.set(f, readSet.has(f) ? "read+write" : "written");
	const all = [...mode.keys()].sort();
	const LIMIT = 20;
	const lines = all.slice(0, LIMIT).map(f => `${f} (${mode.get(f)})`);
	if (all.length > LIMIT) lines.push(`[…${all.length - LIMIT} more files elided…]`);
	return lines.join("\n");
}

const URL_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i;

function computeFileLists(fileOps: CompactPreparation["fileOps"]): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter(f => !URL_SCHEME_RE.test(f)));
	const readFiles = [...fileOps.read].filter(f => !URL_SCHEME_RE.test(f) && !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

function buildSummary(options: {
	frameCount: number;
	cols: string;
	rows: number;
	docColumns: boolean;
	sentenceInk: boolean;
	stopwordDimmed: boolean;
	lineRepeated: boolean;
	truncatedChars: number;
	includedPreviousSummary: boolean;
	files: string;
	includeThinking: boolean;
}): string {
	const lines: string[] = [];
	lines.push("Resume the prior conversation. Earlier turns are archived under HISTORY below, oldest to newest.");
	lines.push("Read HISTORY fully, then continue the live conversation that follows it.");
	lines.push("");
	lines.push("Archived transcript sections:");
	if (options.includeThinking) {
		lines.push("- `»user:`, `»think:`, `»ai:`, `»tool:` — user, assistant reasoning, assistant reply, tool call.");
	} else {
		lines.push("- `»user:`, `»ai:`, `»tool:` — user, assistant reply, tool call.");
	}
	lines.push("- Unprefixed following lines continue the current section; consecutive same-kind sections omit the prefix.");
	lines.push("- Tool call: `»tool:name(args)`; output sits in an `<out>…</out>` block beneath it.");
	lines.push("");
	lines.push("Reading HISTORY:");
	lines.push("- Plain text regions are the verbatim transcript; rely on them exactly.");
	if (options.frameCount > 0) {
		lines.push(
			`- The middle ${options.frameCount} section${options.frameCount === 1 ? " is" : "s are"} images, not text. Each image is one page of the transcript, in reading order between the marked delimiters. A solid black cell is a newline; runs of spaces collapse to one.`,
		);
		if (options.docColumns) {
			lines.push(
				`  - Each frame holds two side-by-side columns, each ${options.cols} characters wide, up to ${options.rows} rows tall; read the left column top to bottom, then the right.`,
			);
		} else {
			lines.push(
				`  - Each frame holds one grid ${options.cols} characters wide and up to ${options.rows} rows tall; read left to right, top to bottom. There is no word wrap; words may break across rows.`,
			);
		}
		if (options.sentenceInk) lines.push("  - Ink cycles through six colors, one per sentence.");
		if (options.stopwordDimmed) lines.push("  - Function words print in dim gray; content words carry full ink.");
		if (options.lineRepeated) lines.push("  - Every line is printed twice (white band, then pale-yellow band); the copies are identical.");
	}
	if (options.includedPreviousSummary) {
		lines.push("- HISTORY opens with a condensed digest of still-older context predating the archived turns.");
	}
	if (options.truncatedChars > 0) {
		lines.push(`- About ${options.truncatedChars.toLocaleString()} characters of older middle history were dropped to fit the archive budget.`);
	}
	lines.push("- If an exact earlier detail matters and a section is unclear, re-derive it from the workspace (re-read files, re-run commands) rather than guessing.");
	if (options.files) {
		lines.push("");
		lines.push("FILES");
		lines.push("===================");
		lines.push(options.files);
	}
	lines.push("");
	lines.push("HISTORY");
	lines.push("===================");
	return lines.join("\n");
}

/** Run one snap-compact pass over prepared messages. */
export function compact(preparation: CompactPreparation, options?: CompactOptions): CompactResult {
	const { firstKeptEntryId, tokensBefore, previousSummary, previousDetails, fileOps } = preparation;
	if (!firstKeptEntryId) throw new Error("firstKeptEntryId missing — session may need migration");

	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const serialized = serializeConversation(messages, options);

	const previousArchive = getArchive(previousDetails);
	const previousRaw = previousArchive?.text ??
		[previousArchive?.textHead, previousArchive?.textTail]
			.filter((p): p is string => typeof p === "string" && p.length > 0)
			.join(NEWLINE_CELL);
	// Heal data URLs a prior structure-blind slice may have cut, then scrub
	// reasoning when this pass excludes it.
	const healed = elideDataUrls(previousRaw ?? "", "archive");
	const previousText = options?.includeThinking === false && healed.length > 0 ? stripThinkingSections(healed) : healed;
	const hasPreviousText = previousText.length > 0;
	const includePreviousSummary = !hasPreviousText && !!previousSummary;

	// Probe text for shape selection: prior archive (or summary) + new history.
	const probe = hasPreviousText
		? `${toPlainText(previousText)}${NEWLINE_CELL}${serialized}`
		: includePreviousSummary
			? `${previousSummary}${NEWLINE_CELL}${serialized}`
			: serialized;
	const baseShape = options?.shape ?? resolveShapeForText(probe, options?.model, options?.variant);
	const high = baseShape;
	const low = denseCompanion(high, options?.model?.api);
	const maxFrames = Math.max(1, Math.min(options?.maxFrames ?? MAX_FRAMES_DEFAULT, MAX_FRAMES_DEFAULT));

	let archiveText = normalize(serialized, { font: high.font });
	if (includePreviousSummary && previousSummary) {
		const head = `[Summary of earlier history] ${normalize(previousSummary, { font: high.font })}`;
		archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
	}

	let truncatedChars = previousArchive?.truncatedChars ?? 0;
	if (hasPreviousText) {
		archiveText = archiveText.length > 0 ? `${previousText}${NEWLINE_CELL}${archiveText}` : previousText;
	}
	// planArchive's edge slices are structure-blind; no data URL may reach it.
	archiveText = elideDataUrls(archiveText);

	const layout = planArchive(archiveText, high, low, maxFrames);
	truncatedChars += layout.truncatedChars;

	// Render planned frames, carrying any open dim span across boundaries:
	// textHead → frames → textTail.
	let dimOpen = layout.textHead.lastIndexOf(DIM_ON) > layout.textHead.lastIndexOf(DIM_OFF);
	const frames: Frame[] = [];
	for (const planned of layout.frames) {
		let pageText = dimOpen ? DIM_ON + planned.text : planned.text;
		dimOpen = pageText.lastIndexOf(DIM_ON) > pageText.lastIndexOf(DIM_OFF);
		if (planned.shape.dimStopwords) pageText = dimStopwordRuns(pageText);
		const rendered = rasterizeFrame(pageText, planned.shape);
		frames.push({
			data: rendered.png.toString("base64"),
			mimeType: "image/png",
			cols: rendered.cols,
			rows: rendered.rows,
			chars: rendered.chars,
			font: planned.shape.font,
			ink: planned.shape.ink,
			repeat: planned.shape.repeat,
			...(planned.shape.columns === 2 ? { columns: 2 } : {}),
		});
	}

	const textHead = layout.textHead;
	const textTail = layout.textTail.length > 0 ? (dimOpen ? DIM_ON : "") + layout.textTail : "";
	const textChars = textHead.length + textTail.length;
	const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0) + textChars;

	const frameCols: number[] = [];
	for (const frame of frames) {
		if (!frameCols.includes(frame.cols)) frameCols.push(frame.cols);
	}
	const geo = gridGeometry(high);
	const colsDesc = frameCols.length > 0 ? frameCols.join(" or ") : String(geo.cols);

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	const files = formatFileList(readFiles, modifiedFiles, fileOps.read);

	let summary: string;
	if (frames.length === 0 && textHead.length === 0 && textTail.length === 0 && files.length === 0) {
		summary = "No prior history.";
	} else {
		summary = buildSummary({
			frameCount: frames.length,
			cols: colsDesc,
			rows: geo.rows,
			docColumns: high.columns === 2,
			sentenceInk: high.ink === "sent",
			stopwordDimmed: high.dimStopwords === true,
			lineRepeated: high.repeat > 1,
			truncatedChars,
			includedPreviousSummary: includePreviousSummary,
			files,
			includeThinking: options?.includeThinking !== false,
		});
	}

	const archive: Archive = {
		frames,
		totalChars,
		truncatedChars,
		...(layout.keptText.length > 0 ? { text: layout.keptText } : {}),
		...(textHead ? { textHead } : {}),
		...(textTail ? { textTail } : {}),
	};

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles, snapcompact: archive },
		stats: { frames: frames.length, totalChars, textChars, truncatedChars },
	};
}
