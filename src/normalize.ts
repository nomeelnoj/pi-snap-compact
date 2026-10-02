/**
 * Text normalization for frame printing.
 *
 * Frame fonts cover ASCII + Latin-1 (bitmap faces) or broad Unicode (Silver
 * fallback). Normalization prepares arbitrary transcript text for printing:
 * strip ANSI escapes, collapse whitespace runs (newline runs become a single
 * full-block marker cell), fold punctuation/symbols/emoji to ASCII, decompose
 * compatibility code points via NFKD, and keep non-Latin glyphs only when the
 * selected font (or the Silver fallback) can actually draw them.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { supportedChars, type FontName } from "./fonts.ts";

/** Zero-width ink toggles embedded in serialized text (shift-out / shift-in).
 *  Text between them prints in dim gray ink; they occupy no grid cell. */
export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";

/** Printed in place of newline runs: the rasterizer fills the whole cell. */
export const NEWLINE_CELL = "\u2588"; // FULL BLOCK

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)/g;

function stripAnsi(text: string): string {
	return text.includes("\u001b") ? text.replace(ANSI_PATTERN, "") : text;
}

/** Explicit folds for punctuation/symbols that have no (useful) NFKD form. */
const CHAR_FOLD: Record<string, string> = {
	// Quotes and primes.
	"‘": "'",
	"’": "'",
	"‚": "'",
	"‛": "'",
	"“": '"',
	"”": '"',
	"„": '"',
	"′": "'",
	"″": '"',
	"‵": "'",
	"‶": '"',
	"‹": "<",
	"›": ">",
	// Dashes and the fraction slash.
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"–": "-",
	"—": "-",
	"―": "-",
	"−": "-",
	"⁄": "/",
	// Ellipses and dot leaders.
	"․": ".",
	"‥": "..",
	"…": "...",
	"⋯": "...",
	// Bullets.
	"•": "*",
	"‣": "*",
	"⁃": "-",
	"∙": "*",
	"●": "*",
	"■": "*",
	"▪": "*",
	// Arrows.
	"←": "<-",
	"↑": "^",
	"→": "->",
	"↓": "v",
	"↔": "<->",
	"⇐": "<=",
	"⇒": "=>",
	"⇔": "<=>",
	// Checks and crosses.
	"✓": "v",
	"✔": "v",
	"✗": "x",
	"✘": "x",
};

/** Status pictographs that carry meaning in tool output; other emoji drop. */
const EMOJI_FOLD: Record<string, string> = {
	"✅": "[OK]",
	"☑": "[OK]",
	"❌": "[FAIL]",
	"❎": "[FAIL]",
	"✖": "[FAIL]",
	"⚠": "[WARN]",
	"🚨": "[ALERT]",
	"ℹ": "[INFO]",
	"🐛": "[BUG]",
	"💥": "[CRASH]",
	"🔥": "[HOT]",
	"🔒": "[LOCK]",
	"🔓": "[UNLOCK]",
	"📁": "[DIR]",
	"📂": "[DIR]",
	"📄": "[FILE]",
	"📝": "[NOTE]",
	"🧪": "[TEST]",
	"⏳": "[WAIT]",
	"⌛": "[WAIT]",
	"🚀": "[RUN]",
};

const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;

/** Whitespace + zero-width format chars, collapsed in one pass. */
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
/** Leading/trailing spaces or newline cells carry no information. */
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;
/** Controls, combining/enclosing marks, lone surrogates: never printable. */
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;
const COMBINING_MARKS = /\p{M}+/gu;
/** Box-drawing block (folded to ASCII art). */
const BOX_DRAWING_MIN = 0x2500;
const BOX_DRAWING_MAX = 0x257f;

function isAsciiOrLatin1(cp: number): boolean {
	return (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff);
}

/** NFKD decompose, strip combining marks, keep ASCII/Latin-1 skeleton.
 *  Returns undefined when the code point has no usable decomposition. */
function foldToAscii(ch: string): string | undefined {
	const decomposed = ch.normalize("NFKD").replace(COMBINING_MARKS, "");
	if (decomposed === ch) return undefined;
	let out = "";
	for (const part of decomposed) {
		const cp = part.codePointAt(0);
		if (cp !== undefined && isAsciiOrLatin1(cp)) {
			out += part;
			continue;
		}
		const fold = CHAR_FOLD[part];
		if (fold === undefined) return undefined;
		out += fold;
	}
	return out;
}

/** Split input into code points after ANSI strip + whitespace collapse. */
function inputChars(text: string): string[] {
	const collapsed = stripAnsi(text)
		.replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_CELL : /[^\p{Cf}]/u.test(run) ? " " : ""))
		.replace(EDGE_RUNS, "");
	return [...collapsed];
}

/** Unique non-Latin code points that normalization alone cannot resolve —
 *  these are the candidates worth a font-support lookup. */
function fontCandidates(chars: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const ch of chars) {
		const cp = ch.codePointAt(0);
		if (cp === undefined || isAsciiOrLatin1(cp) || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_CELL) {
			continue;
		}
		if (
			CHAR_FOLD[ch] !== undefined ||
			(cp >= BOX_DRAWING_MIN && cp <= BOX_DRAWING_MAX) ||
			EMOJI_FOLD[ch] !== undefined ||
			EMOJI_PICTOGRAPH.test(ch) ||
			foldToAscii(ch) !== undefined ||
			UNRENDERABLE.test(ch)
		) {
			continue;
		}
		unique.add(ch);
	}
	return [...unique];
}

/** Characters a shape can print: its own font, plus Silver as fallback for
 *  bitmap shapes. */
function printableSet(chars: readonly string[], font: FontName | undefined): ReadonlySet<string> {
	if (chars.length === 0) return new Set();
	const primary = font ?? "5x8";
	const supported = supportedChars(primary, chars);
	if (primary !== "silver") {
		for (const ch of supportedChars("silver", chars)) supported.add(ch);
	}
	return supported;
}

export interface NormalizeOptions {
	/** Font whose coverage (plus Silver fallback) gates non-Latin passthrough. */
	font?: FontName;
}

interface NormalizeStats {
	text: string;
	totalGraphics: number;
	fallbackCount: number;
}

function normalizeWithStats(text: string, options?: NormalizeOptions): NormalizeStats {
	const chars = inputChars(text);
	const printable = printableSet(fontCandidates(chars), options?.font);
	const out: string[] = [];
	let totalGraphics = 0;
	let fallbackCount = 0;

	for (const ch of chars) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (isAsciiOrLatin1(cp)) {
			out.push(ch);
			totalGraphics++;
			continue;
		}
		if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_CELL) {
			out.push(ch);
			continue;
		}
		const emoji = EMOJI_FOLD[ch];
		if (emoji !== undefined) {
			out.push(emoji);
			totalGraphics++;
			continue;
		}
		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			out.push(fold);
			totalGraphics++;
			continue;
		}
		if (cp >= BOX_DRAWING_MIN && cp <= BOX_DRAWING_MAX) {
			// Vertical strokes → |, horizontal → -, corners/junctions → +.
			out.push(cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+");
			totalGraphics++;
			continue;
		}
		if (!EMOJI_PICTOGRAPH.test(ch) && printable.has(ch)) {
			out.push(ch);
			totalGraphics++;
			continue;
		}
		const folded = foldToAscii(ch);
		if (folded !== undefined) {
			out.push(folded);
			totalGraphics++;
		} else if (EMOJI_PICTOGRAPH.test(ch)) {
			// Decorative emoji drop silently rather than burning a cell as '?'.
		} else if (!UNRENDERABLE.test(ch)) {
			out.push("?");
			totalGraphics++;
			fallbackCount++;
		}
	}

	return {
		text: out.join("").replace(/ +/g, " ").replace(EDGE_RUNS, ""),
		totalGraphics,
		fallbackCount,
	};
}

/** Prepare text for printing at the given font. */
export function normalize(text: string, options?: NormalizeOptions): string {
	return normalizeWithStats(text, options).text;
}

/** Unsafe = more than 5% of printable characters would degrade to '?'. */
export function scanRenderability(
	text: string,
	options?: NormalizeOptions,
): { isSafe: boolean; unrenderableRatio: number } {
	const { totalGraphics, fallbackCount } = normalizeWithStats(text, options);
	const ratio = totalGraphics > 0 ? fallbackCount / totalGraphics : 0;
	return { isSafe: ratio <= 0.05, unrenderableRatio: ratio };
}

// ---------------------------------------------------------------------------
// Stopword dimming
// ---------------------------------------------------------------------------

/** High-frequency function words a reader can reconstruct from context. */
const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but " +
		"he she his her they their them which also who whom when where while will would could should there then than " +
		"into over under about after before between during each such these those some most more other only same so"
	).split(" "),
);

/** Maximal alphabetic runs (ASCII + Latin-1 letters). */
const ALPHA_RUN = /[a-zA-ZÀ-ÖØ-öø-ÿ]+/g;
const DIM_MARKER_SPLIT = /([\u000e\u000f])/;

/**
 * Wrap stopwords in dim-ink toggles. Spans already dim (e.g. archived tool
 * output) pass through untouched so the enclosing span is not terminated
 * early. Markers are zero-width: the visible glyph count is unchanged.
 */
export function dimStopwordRuns(text: string): string {
	const parts = text.split(DIM_MARKER_SPLIT);
	let dim = false;
	let out = "";
	for (const part of parts) {
		if (part === DIM_ON) {
			dim = true;
			out += part;
		} else if (part === DIM_OFF) {
			dim = false;
			out += part;
		} else if (dim) {
			out += part;
		} else {
			out += part.replace(ALPHA_RUN, word => (STOPWORDS.has(word.toLowerCase()) ? DIM_ON + word + DIM_OFF : word));
		}
	}
	return out;
}
