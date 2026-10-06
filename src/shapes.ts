/**
 * Frame shapes and reader-aware resolution.
 *
 * A "shape" describes how serialized history is printed onto PNG frames:
 * which font, the cell advance/pitch glyphs are laid out on, ink coloring,
 * redundancy (line repetition), layout (grid vs two-column), and the frame
 * edge in pixels. Attached to each shape is a per-frame billed-token estimate
 * for the provider actually carrying the request.
 *
 * The tuning table (which shape wins for which reader, and the provider
 * billing formulas below) derives from the published snapcompact research in
 * oh-my-pi (packages/snapcompact/research, SQuAD recall evals against live
 * provider billing). This file re-implements the idea; the constants are
 * provider billing facts:
 *  - Anthropic bills images in ~28px patches, capped at 4,784 visual tokens
 *    per image (larger images are downscaled server-side).
 *  - Gemini 3.x bills a flat media-resolution budget per image (1,120 tokens
 *    at default HIGH resolution) regardless of pixel size.
 *  - OpenAI bills area-proportionally in 32px patches with a flagship
 *    multiplier and a 10k-patch budget.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import type { FontName } from "./fonts.ts";

/** One frame shape: geometry + ink + billing. */
export interface Shape {
	font: FontName;
	/** Cell advance (px). When it differs from the font's natural advance and
	 *  `stretch` is not false, glyph bitmaps are resampled to fit. */
	cellW: number;
	/** Cell pitch (px). */
	cellH: number;
	/** false = draw glyphs at natural size on a larger pitch (extra leading/
	 *  tracking); true/undefined = resample when cell differs from natural. */
	stretch?: boolean;
	/** "bw" prints black ink; "sent" cycles six dark hues at sentence ends. */
	ink: "bw" | "sent";
	/** Print function words in dim gray (content words keep full ink). */
	dimStopwords?: boolean;
	/** 1/undefined = row-major grid; 2 = two word-wrapped columns. */
	columns?: 1 | 2;
	/** Print each text line this many times; copies after the first sit on a
	 *  pale highlight band (redundancy coding). */
	repeat: number;
	/** Frame edge in px (frames are square, width fixed; height hugs content). */
	frameSize: number;
	/** Estimated billed tokens per frame for the carrying provider. */
	frameTokens: number;
}

/** Shape without billing — a pure layout recipe. */
export type ShapeGeometry = Omit<Shape, "frameTokens">;

/**
 * The research-eval layout variants, keyed by name. Font codes: `8x8` =
 * unscii, `5x8`/`6x12`/`8x13` = X.org misc-fixed, `silver` = Silver TrueType.
 * `Non` = Npx advance on an Mpx pitch without resampling (extra leading or
 * tracking around the readable natural glyph).
 */
export const SHAPE_VARIANTS = {
	// Square unscii grids from the eval sweeps.
	"8x8u-bw": { font: "8x8", cellW: 8, cellH: 8, ink: "bw", repeat: 1, frameSize: 1568 },
	"8x8u-sent": { font: "8x8", cellW: 8, cellH: 8, ink: "sent", repeat: 1, frameSize: 1568 },
	"8x8r-bw": { font: "8x8", cellW: 8, cellH: 8, ink: "bw", repeat: 2, frameSize: 1568 },
	"8x8r-sent": { font: "8x8", cellW: 8, cellH: 8, ink: "sent", repeat: 2, frameSize: 1568 },
	"6x6u-bw": { font: "8x8", cellW: 6, cellH: 6, ink: "bw", repeat: 1, frameSize: 1568 },
	"6x6u-sent": { font: "8x8", cellW: 6, cellH: 6, ink: "sent", repeat: 1, frameSize: 1568 },
	// Legacy X.org 5x8 on its original large frame.
	"5x8-bw": { font: "5x8", cellW: 5, cellH: 8, ink: "bw", repeat: 1, frameSize: 2576 },
	"5x8-sent": { font: "5x8", cellW: 5, cellH: 8, ink: "sent", repeat: 1, frameSize: 2576 },
	// X.org faces on tuned pitches — the eval winners.
	"6x12-dim": { font: "6x12", cellW: 6, cellH: 12, ink: "bw", dimStopwords: true, repeat: 1, frameSize: 1568 },
	"8x13-bw": { font: "8x13", cellW: 8, cellH: 13, ink: "bw", repeat: 1, frameSize: 1568 },
	"8on16-bw": { font: "8x13", cellW: 8, cellH: 16, stretch: false, ink: "bw", repeat: 1, frameSize: 1568 },
	"8on22-bw": { font: "8x13", cellW: 8, cellH: 22, stretch: false, ink: "bw", repeat: 1, frameSize: 1568 },
	"11on16-bw": { font: "8x13", cellW: 11, cellH: 16, stretch: false, ink: "bw", repeat: 1, frameSize: 1568 },
	// Silver TrueType on a square 16px grid — the CJK / non-Latin shape.
	"silver16-bw": { font: "silver", cellW: 16, cellH: 16, ink: "bw", repeat: 1, frameSize: 1568 },
	// Two-column word-wrapped "document" layouts.
	"doc-8on16-bw": { font: "8x13", cellW: 8, cellH: 16, stretch: false, ink: "bw", columns: 2, repeat: 1, frameSize: 1568 },
	"doc-8on16-sent": { font: "8x13", cellW: 8, cellH: 16, stretch: false, ink: "sent", columns: 2, repeat: 1, frameSize: 1568 },
	"doc-8on16-sent-dim": {
		font: "8x13",
		cellW: 8,
		cellH: 16,
		stretch: false,
		ink: "sent",
		dimStopwords: true,
		columns: 2,
		repeat: 1,
		frameSize: 1568,
	},
} as const satisfies Record<string, ShapeGeometry>;

export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;
export const SHAPE_VARIANT_NAMES = Object.keys(SHAPE_VARIANTS) as readonly ShapeVariantName[];

export function isShapeVariantName(value: unknown): value is ShapeVariantName {
	return typeof value === "string" && value in SHAPE_VARIANTS;
}

// ---------------------------------------------------------------------------
// Provider billing
// ---------------------------------------------------------------------------

/** Provider families with materially different image billing. */
export type BillingFamily = "anthropic" | "google" | "openai" | "unknown";

/** Map a pi wire-API id to a billing family. */
export function billingFamily(api?: string): BillingFamily {
	if (!api) return "unknown";
	if (api.startsWith("anthropic") || api.startsWith("bedrock")) return "anthropic";
	if (api.startsWith("google")) return "google";
	if (api.startsWith("openai") || api.startsWith("azure-openai")) return "openai";
	return "unknown";
}

const ANTHROPIC_PATCH_PX = 28;
const ANTHROPIC_PATCH_CAP = 4784;
const ANTHROPIC_MARGIN = 1.05;
const GOOGLE_FLAT_TOKENS = 1120;
const OPENAI_PATCH_PX = 32;
const OPENAI_PATCH_CAP = 10_000;
const OPENAI_MULTIPLIER = 1.2;

/** Per-frame billed-token estimate for a square frame of `frameSize` px. */
export function familyBilling(family: BillingFamily, frameSize: number): number {
	switch (family) {
		case "google":
			return GOOGLE_FLAT_TOKENS;
		case "openai": {
			const patches = Math.min(Math.ceil(frameSize / OPENAI_PATCH_PX) ** 2, OPENAI_PATCH_CAP);
			return Math.ceil(patches * OPENAI_MULTIPLIER);
		}
		default: {
			// anthropic + unknown share the pixel-area ceiling (safe upper bound).
			const patches = Math.min(Math.ceil(frameSize / ANTHROPIC_PATCH_PX) ** 2, ANTHROPIC_PATCH_CAP);
			return Math.ceil(patches * ANTHROPIC_MARGIN);
		}
	}
}

/** Attach billing for `family` to a geometry. */
export function priceShape(base: ShapeGeometry, family: BillingFamily): Shape {
	return { ...base, frameTokens: familyBilling(family, base.frameSize) };
}

// ---------------------------------------------------------------------------
// Reader resolution
// ---------------------------------------------------------------------------

/** Eval-winning variant per family when the model line is unmeasured. */
const FAMILY_VARIANT: Record<BillingFamily, ShapeVariantName> = {
	anthropic: "11on16-bw",
	google: "8on22-bw",
	openai: "8on22-bw",
	unknown: "8on22-bw",
};

/** Denser companion per family for the foveated archive middle: same pixels
 *  (identical per-frame bill) on a tighter cell. */
const FAMILY_VARIANT_DENSE: Record<BillingFamily, ShapeVariantName> = {
	anthropic: "8on16-bw",
	google: "8on16-bw",
	openai: "8on16-bw",
	unknown: "8on16-bw",
};

export interface IdealShape {
	variant: ShapeVariantName;
	frameSize?: number;
}

/** Largest square that stays under Anthropic's 4,784-patch cap:
 *  floor(sqrt(4784)) = 69 patches * 28px = 1932px (also under the stricter
 *  <=2000px limit that applies to requests carrying many images). */
const HIGH_RES_FRAME = 1932;
const HIGH_RES_ANTHROPIC: IdealShape = { variant: "11on16-bw", frameSize: HIGH_RES_FRAME };

/**
 * Model-id rules, first match wins. The reader's model line — not the gateway
 * — picks the shape: a Claude routed through a proxy still reads its Claude
 * shape, priced for the gateway that carries the request.
 */
const MODEL_RULES: readonly (readonly [RegExp, IdealShape])[] = [
	// Versionless fable/mythos aliases never carry a numeric version.
	[/claude.*(fable|mythos)/i, HIGH_RES_ANTHROPIC],
	// Opus 4.7+ and Opus 5+ read high-res natively (same recall, a third fewer
	// frames). The lookahead keeps date-stamped ids such as
	// claude-opus-4-20250514 from reading as a two-digit minor version.
	[/claude.*opus[-.](?:4[-.](?:[7-9]|[1-9]\d)|[5-9]|[1-9]\d)(?!\d)/i, HIGH_RES_ANTHROPIC],
	// Older Claude lines downscale past 1568px.
	[/claude/i, { variant: "11on16-bw" }],
	// Gemini 3.x flat per-image budget: bigger frames are free chars.
	[/gemini/i, { variant: "8on22-bw", frameSize: 2048 }],
	// GPT/Codex patch billing is area-proportional: 1568 is already optimal.
	[/gpt|codex/i, { variant: "8on22-bw" }],
	// Kimi's processor downscales past ~1792px; 1568 wins on chars/$.
	[/kimi/i, { variant: "8on22-bw" }],
	// GLM measured best on the plain 8x13 grid at standard pitch.
	[/glm/i, { variant: "8on16-bw" }],
];

/** Eval-ideal format for a model id, or undefined when unmeasured. */
export function idealShapeForModel(modelId: string): IdealShape | undefined {
	return MODEL_RULES.find(([pattern]) => pattern.test(modelId))?.[1];
}

/** What will read the frames: the wire API (billing) and model id (shape). */
export interface ShapeTarget {
	api?: string;
	id?: string;
	provider?: string;
}

/**
 * Pick the frame shape for a reader. A forced `variant` keeps its geometry
 * and is re-priced for the carrying provider. Otherwise the model id selects
 * the eval winner for its line, falling back to the API family's winner.
 */
export function resolveShape(model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
	const family = billingFamily(model?.api);
	if (variant && variant !== "auto") return priceShape(SHAPE_VARIANTS[variant], family);
	const ideal = model?.id ? idealShapeForModel(model.id) : undefined;
	const name = ideal?.variant ?? FAMILY_VARIANT[family];
	const base = SHAPE_VARIANTS[name];
	return priceShape(ideal?.frameSize ? { ...base, frameSize: ideal.frameSize } : base, family);
}

/** Denser companion of `high` for the foveated middle of a large archive.
 *  Returns `high` unchanged for doc layouts and TrueType shapes (no denser
 *  variant) or when the dense tier would not actually fit more text. */
export function denseCompanion(high: Shape, api?: string): Shape {
	if (high.columns === 2 || high.font === "silver") return high;
	const family = billingFamily(api);
	const low = priceShape({ ...SHAPE_VARIANTS[FAMILY_VARIANT_DENSE[family]], frameSize: high.frameSize }, family);
	return gridGeometry(low).capacity > gridGeometry(high).capacity ? low : high;
}

/** Human-readable one-line shape description for logs and status displays. */
export function describeShape(shape: ShapeGeometry & { frameTokens?: number }): string {
	const layout = shape.columns === 2 ? "two-column" : shape.repeat > 1 ? `repeat x${shape.repeat}` : "grid";
	const dim = shape.dimStopwords ? "+dim" : "";
	const tokens = shape.frameTokens !== undefined ? `, ~${shape.frameTokens.toLocaleString()} tok/frame` : "";
	return `${shape.font} ${shape.cellW}x${shape.cellH} ${layout} @${shape.frameSize}px, ${shape.ink}${dim} ink${tokens}`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface GridGeometry {
	/** Characters per row (per-column line width for two-column shapes). */
	cols: number;
	/** Text rows per frame (unique lines; repeat copies excluded, banner strip excluded). */
	rows: number;
	/** Characters that fit one frame (nominal for doc shapes). */
	capacity: number;
}

/** Char cells between the two columns of a doc layout. */
export const DOC_GUTTER = 3;

/**
 * Every frame reserves one cell-row strip at the top for a banner that labels
 * the image as an archived transcript page, so the provenance boundary is
 * visible inside the pixels the model reads rather than only in surrounding
 * text. The strip is drawn once (never repeated) in black ink, and its height
 * is taken out of the content grid so frames stay within `frameSize`.
 */
export const BANNER_ROWS = 1;

/** Pixel height of the banner strip for `shape`. */
export function bannerHeight(shape: ShapeGeometry): number {
	return BANNER_ROWS * shape.cellH;
}

export function gridGeometry(shape: ShapeGeometry, size: number = shape.frameSize): GridGeometry {
	const gridCols = Math.floor(size / shape.cellW);
	const rows = Math.max(1, Math.floor((size - bannerHeight(shape)) / shape.cellH / shape.repeat));
	if (shape.columns === 2) {
		const cols = Math.floor((gridCols - DOC_GUTTER) / 2);
		return { cols, rows, capacity: 2 * cols * rows };
	}
	return { cols: gridCols, rows, capacity: gridCols * rows };
}
