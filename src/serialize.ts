/**
 * Conversation serialization for archiving.
 *
 * Discarded history is flattened to a dense, section-tagged plain-text form
 * before printing onto frames:
 *
 *   »user: <text>            user message
 *   »think: <text>           assistant reasoning (optional, see below)
 *   »ai: <text>              assistant reply
 *   »tool: name(k=v, …)      tool call; result folds in underneath:
 *     <out>
 *     <dim-ink body>
 *     </out>
 *
 * Consecutive sections of the same kind merge (prefix printed once). Tool
 * results are truncated head+tail (errors land at the tail), argument values
 * are capped individually and per call, tool output prints in dim ink so
 * conversation reads louder than tool noise, and inline base64 data URLs
 * collapse to a metadata placeholder (a sliced payload replays as a broken
 * image input on every later request — worthless and harmful).
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import type { Message } from "@earendil-works/pi-ai";
import { DIM_OFF, DIM_ON, NEWLINE_CELL } from "./normalize.ts";

export const TOOL_RESULT_MAX_CHARS = 2000;
export const TOOL_ARG_MAX_CHARS = 500;
export const TOOL_CALL_MAX_CHARS = 2000;
/** Share of each truncation budget spent on the head; the tail keeps the rest. */
export const TRUNCATE_HEAD_RATIO = 0.6;

export interface SerializeOptions {
	toolResultMaxChars?: number;
	toolArgMaxChars?: number;
	toolCallMaxChars?: number;
	truncateHeadRatio?: number;
	/** Print tool-result bodies in dim ink. Default true. */
	dimToolResults?: boolean;
	/** Include assistant reasoning sections. Set false when the archive will be
	 *  replayed to a model family that rejects visible reasoning. Default true. */
	includeThinking?: boolean;
}

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
export function truncateMiddle(text: string, maxChars: number, headRatio: number): string {
	if (text.length <= maxChars) return text;
	const ratio = Math.min(Math.max(headRatio, 0), 1);
	const head = Math.round(maxChars * ratio);
	const tail = maxChars - head;
	const elided = text.length - maxChars;
	return `${text.slice(0, head)} […${elided}ch elided…] ${tail > 0 ? text.slice(-tail) : ""}`;
}

// ---------------------------------------------------------------------------
// Data-URL elision
// ---------------------------------------------------------------------------

/** Matches one inline base64 data URL, including payloads already carrying an
 *  elision marker from a prior slice. Markdown link/image wrappers around the
 *  URL are collapsed with it. */
const DATA_URL_RE = /data:([A-Za-z][\w.+-]*\/[\w.+-]+(?:;[\w!#$%&'*+.^|~-]+=[\w!#$%&'*+.^|~-]+)*);base64,([A-Za-z0-9+/=\s]*)\)?/gi;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;
/** A non-canonical payload at least this long is a damaged fragment, not prose. */
const DAMAGED_PAYLOAD_MIN = 40;

/**
 * Replace inline base64 data URLs with a metadata placeholder. In `archive`
 * context the text may have been cut at arbitrary offsets by structure-blind
 * slices, so every recognized prefix is elided; in `source` context only
 * canonical or clearly-damaged payloads are touched.
 */
export function elideDataUrls(text: string, context: "source" | "archive" = "source"): string {
	if (!/;base64,/i.test(text)) return text;
	DATA_URL_RE.lastIndex = 0;
	return text.replace(DATA_URL_RE, (whole, mime: string, payload: string) => {
		const clean = payload.replace(/\s+/g, "");
		const isAtom = context === "archive" || CANONICAL_BASE64.test(clean) || clean.length >= DAMAGED_PAYLOAD_MIN;
		if (!isAtom) return whole;
		return `[data URL omitted: ${mime}, ${clean.length} base64 chars]`;
	});
}

/** Strip stray ink toggles from raw content so it cannot forge dim spans. */
const DIM_MARKERS_RE = /[\u000e\u000f]/g;
export function stripDimMarkers(text: string): string {
	return text.replace(DIM_MARKERS_RE, "");
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	isError?: boolean;
	content: { type: string; text?: string }[];
}

export function serializeConversation(messages: Message[], options?: SerializeOptions): string {
	const resultCap = options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
	const argCap = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS;
	const callCap = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS;
	const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO;
	const dimResults = options?.dimToolResults !== false;
	const includeThinking = options?.includeThinking !== false;

	const parts: string[] = [];
	let lastPrefix: string | null = null;
	const pushPart = (prefix: string, content: string) => {
		const last = parts.length - 1;
		if (last >= 0 && lastPrefix === prefix) {
			const sep = parts[last].endsWith("\n") || content.startsWith("\n") ? "" : "\n";
			parts[last] += sep + content;
		} else {
			parts.push(prefix + content);
			lastPrefix = prefix;
		}
	};

	// Index tool results by call id so each folds into its originating call.
	const resultTextByCallId = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const tr = msg as unknown as ToolResultMessage;
		const text = (tr.content ?? [])
			.filter(block => block.type === "text" && typeof block.text === "string")
			.map(block => block.text as string)
			.join("");
		if (text) resultTextByCallId.set(tr.toolCallId, text);
	}

	const renderResult = (raw: string): string => {
		const body = truncateMiddle(elideDataUrls(stripDimMarkers(raw)), resultCap, headRatio);
		return `<out>\n${dimResults ? `${DIM_ON}${body}${DIM_OFF}` : body}\n</out>`;
	};

	const mergedCallIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter(block => block.type === "text")
							.map(block => (block as { text: string }).text)
							.join("");
			if (content) pushPart("»user:", stripDimMarkers(content));
		} else if (msg.role === "assistant") {
			let pendingThink: string[] = [];
			let pendingText: string[] = [];
			const flush = () => {
				if (pendingThink.length > 0) pushPart("»think:", pendingThink.join("\n"));
				if (pendingText.length > 0) pushPart("»ai:", pendingText.join("\n"));
				pendingThink = [];
				pendingText = [];
			};
			for (const block of msg.content) {
				if (block.type === "text") {
					const text = stripDimMarkers(block.text);
					if (text.trim()) pendingText.push(text);
				} else if (block.type === "thinking") {
					if (!includeThinking) continue;
					const thinking = stripDimMarkers(block.thinking);
					if (thinking.trim()) pendingThink.push(thinking);
				} else if (block.type === "toolCall") {
					flush();
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					const argsStr = truncateMiddle(
						Object.entries(args)
							.map(([key, value]) => `${key}=${truncateMiddle(elideDataUrls(JSON.stringify(value) ?? "undefined"), argCap, headRatio)}`)
							.join(", "),
						callCap,
						headRatio,
					);
					const lines = [`${block.name}(${argsStr})`];
					const resultText = resultTextByCallId.get(block.id);
					if (resultText !== undefined) {
						mergedCallIds.add(block.id);
						lines.push(renderResult(resultText));
					}
					pushPart("»tool:", lines.join("\n"));
				}
			}
			flush();
		} else if (msg.role === "toolResult") {
			const tr = msg as unknown as ToolResultMessage;
			if (mergedCallIds.has(tr.toolCallId)) continue; // already folded into its call
			const resultText = resultTextByCallId.get(tr.toolCallId);
			if (resultText !== undefined) pushPart("»tool:", `\n${renderResult(resultText)}`);
		}
	}

	return parts.join("\n\n");
}

/** Archive text → plain text: drop ink toggles, restore real newlines. */
export function toPlainText(archiveText: string): string {
	return stripDimMarkers(archiveText).replaceAll(NEWLINE_CELL, "\n");
}
