/**
 * Frame rasterizer: prints normalized text onto an RGB pixel canvas and
 * encodes it as PNG.
 *
 * Layout model:
 *  - Frames are `frameSize` px wide; height hugs the rows actually printed
 *    (a partially filled frame never bills blank pixel rows).
 *  - Grid shapes place one character per cell, left→right, top→bottom, no
 *    word wrap. Doc shapes receive pre-wrapped `\n`-separated lines and lay
 *    them out as two newspaper columns.
 *  - Glyph cells may differ from the font's natural advance/pitch: with
 *    `stretch: false` the natural bitmap is drawn on the roomier pitch (extra
 *    leading/tracking); otherwise the glyph is resampled to the cell.
 *  - Ink: "bw" is black; "sent" cycles six dark hues at sentence boundaries
 *    (`.!?'` followed by whitespace or a newline cell). Dim spans (zero-width
 *    toggles in the text) print gray. Newline cells print as a solid black
 *    block. Repeated line copies after the first sit on a pale yellow band.
 *  - Characters missing from the bitmap face fall back to the embedded Silver
 *    TrueType, one glyph at a time; wide (CJK) code points span two cells.
 *
 * TypeScript port of the Rust renderer in @oh-my-pi/pi-natives
 * (crates/pi-natives/src/snapcompact.rs, MIT, Copyright (c) 2025-2026 Can Bölük,
 * (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { charCells, isWideCodePoint } from "./cells.ts";
import { loadFont, type BitmapFont, type BitmapGlyph, type TtfFont } from "./fonts.ts";
import { DIM_OFF, DIM_ON, NEWLINE_CELL } from "./normalize.ts";
import { encodePngRgb } from "./png.ts";
import { DOC_GUTTER, gridGeometry, type Shape } from "./shapes.ts";

/** Ink palette. Hue entries are dark, saturated colors chosen for contrast on
 *  white; index 6 is plain black, 7 the repeat band, 8 the dim gray. */
const INK_HUES: [number, number, number][] = [
	[109, 2, 2], // red
	[109, 53, 2], // amber
	[24, 109, 2], // green
	[2, 109, 109], // teal
	[2, 32, 109], // blue
	[75, 2, 109], // violet
];
const INK_BLACK: [number, number, number] = [0, 0, 0];
const BAND_COLOR: [number, number, number] = [255, 247, 194];
const INK_DIM: [number, number, number] = [128, 128, 128];

const MAX_FRAME_SIZE = 16384;

/** Result of rasterizing one frame. */
export interface RasterResult {
	png: Buffer;
	cols: number;
	rows: number;
	/** Visible characters printed (ink toggles excluded). */
	chars: number;
}

class Canvas {
	readonly width: number;
	readonly height: number;
	readonly px: Uint8Array;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.px = new Uint8Array(width * height * 3).fill(255);
	}

	fillRect(x: number, y: number, w: number, h: number, color: [number, number, number]): void {
		const x0 = Math.max(0, x);
		const y0 = Math.max(0, y);
		const x1 = Math.min(this.width, x + w);
		const y1 = Math.min(this.height, y + h);
		for (let yy = y0; yy < y1; yy++) {
			let off = (yy * this.width + x0) * 3;
			for (let xx = x0; xx < x1; xx++) {
				this.px[off] = color[0];
				this.px[off + 1] = color[1];
				this.px[off + 2] = color[2];
				off += 3;
			}
		}
	}

	/** Blend `color` over the pixel at (x, y) with coverage 0..255. */
	blend(x: number, y: number, coverage: number, color: [number, number, number]): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height || coverage <= 0) return;
		const off = (y * this.width + x) * 3;
		if (coverage >= 255) {
			this.px[off] = color[0];
			this.px[off + 1] = color[1];
			this.px[off + 2] = color[2];
			return;
		}
		const a = coverage / 255;
		this.px[off] = Math.round(this.px[off] * (1 - a) + color[0] * a);
		this.px[off + 1] = Math.round(this.px[off + 1] * (1 - a) + color[1] * a);
		this.px[off + 2] = Math.round(this.px[off + 2] * (1 - a) + color[2] * a);
	}
}

// ---------------------------------------------------------------------------
// Glyph drawing
// ---------------------------------------------------------------------------

/** Blit a bitmap glyph at natural size. `left`/`top` are pixel coords of the
 *  glyph bitmap's top-left corner. */
function blitBitmap(canvas: Canvas, glyph: BitmapGlyph, left: number, top: number, ink: [number, number, number]): void {
	for (let r = 0; r < glyph.rows.length && r < glyph.h; r++) {
		const bits = glyph.rows[r];
		if (bits === 0) continue;
		for (let c = 0; c < glyph.w; c++) {
			if (bits & (0x80 >> c)) {
				canvas.blend(left + c, top + r, 255, ink);
			}
		}
	}
}

/** Resample a bitmap glyph to (w × h) with bilinear interpolation and blend. */
function blitBitmapStretched(
	canvas: Canvas,
	glyph: BitmapGlyph,
	left: number,
	top: number,
	w: number,
	h: number,
	ink: [number, number, number],
): void {
	const srcW = Math.max(1, glyph.w);
	const srcH = Math.max(1, glyph.rows.length);
	const bit = (sx: number, sy: number): number => {
		if (sy < 0 || sy >= srcH || sx < 0 || sx >= srcW) return 0;
		return glyph.rows[sy] & (0x80 >> sx) ? 1 : 0;
	};
	for (let dy = 0; dy < h; dy++) {
		const fy = ((dy + 0.5) * srcH) / h - 0.5;
		const y0 = Math.floor(fy);
		const wy = fy - y0;
		for (let dx = 0; dx < w; dx++) {
			const fx = ((dx + 0.5) * srcW) / w - 0.5;
			const x0 = Math.floor(fx);
			const wx = fx - x0;
			const v =
				bit(x0, y0) * (1 - wx) * (1 - wy) +
				bit(x0 + 1, y0) * wx * (1 - wy) +
				bit(x0, y0 + 1) * (1 - wx) * wy +
				bit(x0 + 1, y0 + 1) * wx * wy;
			if (v > 0.02) canvas.blend(left + dx, top + dy, Math.round(v * 255), ink);
		}
	}
}

/** Blend one TrueType coverage glyph. */
function blitTtf(
	canvas: Canvas,
	glyph: { width: number; height: number; coverage: Uint8Array },
	left: number,
	top: number,
	ink: [number, number, number],
): void {
	for (let r = 0; r < glyph.height; r++) {
		for (let c = 0; c < glyph.width; c++) {
			const cov = glyph.coverage[r * glyph.width + c];
			if (cov > 0) canvas.blend(left + c, top + r, cov, ink);
		}
	}
}

// ---------------------------------------------------------------------------
// Rasterizer state
// ---------------------------------------------------------------------------

interface RasterState {
	canvas: Canvas;
	shape: Shape;
	font: BitmapFont | TtfFont;
	/** Silver fallback for glyphs the bitmap face lacks. */
	fallback: TtfFont;
	geo: { cols: number; rows: number; capacity: number };
	wideCells: boolean;
	sentence: number;
	dim: boolean;
	chars: number;
}

function inkFor(state: RasterState): [number, number, number] {
	if (state.dim) return INK_DIM;
	if (state.shape.ink === "bw") return INK_BLACK;
	return INK_HUES[state.sentence % INK_HUES.length];
}

/** Draw one character at grid position (col, row). Handles newline cells,
 *  bitmap glyphs, resampling, and the Silver fallback. */
function drawChar(state: RasterState, ch: string, col: number, row: number, span: number): void {
	const { shape, canvas } = state;
	const ink = ch === NEWLINE_CELL ? INK_BLACK : inkFor(state);
	const cellLeft = col * shape.cellW;

	for (let copy = 0; copy < shape.repeat; copy++) {
		const cellTop = (row * shape.repeat + copy) * shape.cellH;

		if (ch === NEWLINE_CELL) {
			canvas.fillRect(cellLeft, cellTop, shape.cellW, shape.cellH, INK_BLACK);
			continue;
		}
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;

		if (state.font.kind === "bitmap") {
			const font = state.font;
			const glyph = font.glyphs.get(cp);
			if (glyph && glyph.rows.length > 0) {
				const natural = shape.cellW === font.cellW && shape.cellH === font.cellH;
				if (natural || shape.stretch === false) {
					// Natural glyph on the cell pitch: baseline at cellTop + ascent.
					const left = cellLeft + glyph.xoff;
					const top = cellTop + font.ascent - glyph.h - glyph.yoff;
					blitBitmap(canvas, glyph, left, top, ink);
				} else {
					blitBitmapStretched(canvas, glyph, cellLeft, cellTop, shape.cellW, shape.cellH, ink);
				}
				continue;
			}
			// Silver fallback, one glyph at a time.
			drawTtfFallback(state, ch, span, cellLeft, cellTop, font.ascent, ink);
		} else {
			// Whole-frame TrueType shape (silver16).
			const px = Math.min(shape.cellH, span * shape.cellW);
			const glyph = state.font.rasterize(ch, px);
			if (!glyph) continue;
			const spanPx = span * shape.cellW;
			const left = cellLeft + Math.max(0, Math.round((spanPx - glyph.advance) / 2)) + glyph.bearingX;
			const top = cellTop + state.font.ascent - glyph.bearingY;
			blitTtf(canvas, glyph, left, top, ink);
		}
	}
}

function drawTtfFallback(
	state: RasterState,
	ch: string,
	span: number,
	cellLeft: number,
	cellTop: number,
	ascent: number,
	ink: [number, number, number],
): void {
	const { shape } = state;
	const spanPx = span * shape.cellW;
	const px = Math.min(shape.cellH, spanPx);
	const glyph = state.fallback.rasterize(ch, px);
	if (!glyph) return;
	const left = cellLeft + Math.max(0, Math.round((spanPx - glyph.advance) / 2)) + glyph.bearingX;
	const top = cellTop + ascent - glyph.bearingY;
	blitTtf(state.canvas, glyph, left, top, ink);
}

/** Pale band behind repeated line copies, painted before any glyphs. */
function paintRepeatBands(state: RasterState): void {
	const { shape, canvas, geo } = state;
	if (shape.repeat <= 1) return;
	for (let row = 0; row < geo.rows; row++) {
		for (let copy = 1; copy < shape.repeat; copy++) {
			const top = (row * shape.repeat + copy) * shape.cellH;
			canvas.fillRect(0, top, canvas.width, shape.cellH, BAND_COLOR);
		}
	}
}

/** Sentence boundary: `.`, `!`, `?` followed by a space or newline cell. */
function isSentenceEnd(ch: string, next: string | undefined): boolean {
	return (ch === "." || ch === "!" || ch === "?") && (next === " " || next === NEWLINE_CELL);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Rasterize normalized text onto one PNG frame. Grid shapes consume up to
 * `capacity` cells in reading order; doc shapes expect `\n`-joined pre-wrapped
 * lines (from `docPages`) and lay them out in two columns.
 */
export function rasterizeFrame(text: string, shape: Shape): RasterResult {
	const size = shape.frameSize;
	if (size <= 0 || size > MAX_FRAME_SIZE) throw new Error(`frame size out of range: ${size}`);
	const geo = gridGeometry(shape, size);
	const font = loadFont(shape.font);
	const fallback = loadFont("silver") as TtfFont;

	// Height hugs the rows actually used; compute usage first, then paint.
	const usage = measureRows(text, shape, geo);
	const height = Math.max(1, usage * shape.cellH * shape.repeat);
	const canvas = new Canvas(size, height);
	const state: RasterState = {
		canvas,
		shape,
		font,
		fallback,
		geo,
		wideCells: shape.font !== "silver",
		sentence: 0,
		dim: false,
		chars: 0,
	};
	paintRepeatBands(state);

	if (shape.columns === 2) {
		drawDocPage(state, text);
	} else {
		drawGridPage(state, text);
	}

	return { png: encodePngRgb(canvas.width, canvas.height, canvas.px), cols: geo.cols, rows: geo.rows, chars: state.chars };
}

/** How many text rows `text` will occupy (for frame height). */
function measureRows(text: string, shape: Shape, geo: { cols: number; rows: number; capacity: number }): number {
	if (shape.columns === 2) {
		const lines = text.split("\n").length;
		return Math.min(geo.rows, Math.ceil(lines / 2));
	}
	const wideCells = shape.font !== "silver";
	let cell = 0;
	let hasCell = false;
	for (const ch of text) {
		const w = charCells(ch, wideCells);
		if (w === 0) continue;
		let at = cell;
		if (w === 2 && geo.cols >= 2 && at % geo.cols === geo.cols - 1) at += 1;
		if (hasCell && at + w > geo.capacity) break;
		cell = at + w;
		hasCell = true;
	}
	return hasCell ? Math.floor(cell / geo.cols) + (cell % geo.cols > 0 ? 1 : 0) : 1;
}

function drawGridPage(state: RasterState, text: string): void {
	const { shape, geo } = state;
	const chars = [...text];
	let cursor = 0;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === DIM_ON) {
			state.dim = true;
			continue;
		}
		if (ch === DIM_OFF) {
			state.dim = false;
			continue;
		}
		if (shape.ink === "sent" && isSentenceEnd(ch, chars[i + 1])) state.sentence++;
		const w = charCells(ch, state.wideCells);
		if (w === 2 && geo.cols >= 2 && cursor % geo.cols === geo.cols - 1) cursor += 1;
		if (cursor + w > geo.capacity) break;
		const row = Math.floor(cursor / geo.cols);
		const col = cursor % geo.cols;
		cursor += w;
		state.chars++;
		drawChar(state, ch, col, row, w);
	}
}

function drawDocPage(state: RasterState, text: string): void {
	const { shape, geo } = state;
	const lines = text.split("\n");
	const colOffsetX = (geo.cols + DOC_GUTTER) * shape.cellW;
	for (let i = 0; i < lines.length; i++) {
		const column = i < geo.rows ? 0 : 1;
		const row = i % geo.rows;
		if (i >= 2 * geo.rows) break;
		let cursor = 0; // char-cell position within the column
		const chars = [...lines[i]];
		for (let j = 0; j < chars.length; j++) {
			const ch = chars[j];
			if (ch === DIM_ON) {
				state.dim = true;
				continue;
			}
			if (ch === DIM_OFF) {
				state.dim = false;
				continue;
			}
			if (shape.ink === "sent" && isSentenceEnd(ch, chars[j + 1] ?? (j === chars.length - 1 ? " " : undefined))) {
				state.sentence++;
			}
			const w = charCells(ch, state.wideCells);
			if (cursor + w > geo.cols) break; // clip line at column edge
			// Draw into a virtual grid position: shift x by column offset.
			drawDocChar(state, ch, cursor, row, column === 1 ? colOffsetX : 0, w);
			cursor += w;
			state.chars++;
		}
	}
}

function drawDocChar(state: RasterState, ch: string, colInColumn: number, row: number, offsetX: number, span: number): void {
	const { shape, canvas, font } = state;
	const ink = ch === NEWLINE_CELL ? INK_BLACK : inkFor(state);
	const cellLeft = offsetX + colInColumn * shape.cellW;
	for (let copy = 0; copy < shape.repeat; copy++) {
		const cellTop = (row * shape.repeat + copy) * shape.cellH;
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (font.kind === "bitmap") {
			const glyph = font.glyphs.get(cp);
			if (glyph && glyph.rows.length > 0) {
				const natural = shape.cellW === font.cellW && shape.cellH === font.cellH;
				if (natural || shape.stretch === false) {
					blitBitmap(canvas, glyph, cellLeft + glyph.xoff, cellTop + font.ascent - glyph.h - glyph.yoff, ink);
				} else {
					blitBitmapStretched(canvas, glyph, cellLeft, cellTop, shape.cellW, shape.cellH, ink);
				}
				continue;
			}
			drawTtfFallback(state, ch, span, cellLeft, cellTop, font.ascent, ink);
		} else {
			const px = Math.min(shape.cellH, span * shape.cellW);
			const glyph = font.rasterize(ch, px);
			if (!glyph) continue;
			const spanPx = span * shape.cellW;
			const left = cellLeft + Math.max(0, Math.round((spanPx - glyph.advance) / 2)) + glyph.bearingX;
			const top = cellTop + font.ascent - glyph.bearingY;
			blitTtf(canvas, glyph, left, top, ink);
		}
	}
}
