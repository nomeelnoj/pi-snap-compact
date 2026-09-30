/**
 * Font loading for the frame rasterizer.
 *
 * Bitmap faces (X.org misc-fixed BDF files, unscii `.hex`) are parsed at first
 * use into row-bitmask glyphs. The Silver TrueType face (CJK/Unicode fallback)
 * is parsed lazily through opentype.js and rasterized on demand with a small
 * scanline filler — per-glyph results are cached.
 *
 * Font data lives in `../fonts/` next to this module; see fonts/FONTS.md for
 * provenance and licenses.
 *
 * TypeScript port of the Rust renderer in @oh-my-pi/pi-natives
 * (crates/pi-natives/src/snapcompact.rs, MIT, Copyright (c) 2025-2026 Can Bölük,
 * (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import opentype from "opentype.js";

export type FontName = "5x8" | "8x8" | "6x12" | "8x13" | "silver";

/** One bitmap glyph: row bitmasks, MSB = leftmost pixel. */
export interface BitmapGlyph {
	/** Glyph ink width in pixels (<= 8 for the bundled bitmap faces). */
	w: number;
	/** Bitmap row count. */
	h: number;
	/** Horizontal offset of the glyph's left edge from the cell origin. */
	xoff: number;
	/** Vertical offset of the glyph's bottom edge from the baseline (descenders go negative). */
	yoff: number;
	rows: number[];
}

export interface BitmapFont {
	kind: "bitmap";
	name: FontName;
	glyphs: Map<number, BitmapGlyph>;
	/** Baseline distance from the top of the natural cell. */
	ascent: number;
	/** Natural cell advance (px). */
	cellW: number;
	/** Natural cell pitch (px). */
	cellH: number;
	supports(cp: number): boolean;
}

/** One anti-aliased TrueType glyph render: coverage values 0..255. */
export interface TtfGlyph {
	width: number;
	height: number;
	/** Left bearing from the layout origin (px, may be fractional -> floored). */
	bearingX: number;
	/** Distance from baseline to glyph top (px). */
	bearingY: number;
	advance: number;
	coverage: Uint8Array;
}

export interface TtfFont {
	kind: "ttf";
	name: FontName;
	/** Cell edge the face is rasterized for (px). */
	cellW: number;
	cellH: number;
	/** Baseline distance from the top of the cell (px). */
	ascent: number;
	supports(cp: number): boolean;
	/** Rasterize one character at `px` size, or undefined when unsupported. */
	rasterize(ch: string, px: number): TtfGlyph | undefined;
}

export type LoadedFont = BitmapFont | TtfFont;

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fonts");

// ---------------------------------------------------------------------------
// BDF parsing (X.org misc-fixed faces)
// ---------------------------------------------------------------------------

function parseBdf(name: FontName, text: string, cellW: number, cellH: number): BitmapFont {
	const glyphs = new Map<number, BitmapGlyph>();
	let ascent = 0;
	let encoding = -1;
	let bbx: [number, number, number, number] = [0, 0, 0, 0];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("FONT_ASCENT")) {
			ascent = Number.parseInt(line.slice("FONT_ASCENT".length).trim(), 10) || 0;
		} else if (line.startsWith("ENCODING")) {
			encoding = Number.parseInt(line.slice("ENCODING".length).trim(), 10);
		} else if (line.startsWith("BBX")) {
			const parts = line.slice(3).trim().split(/\s+/).map(Number);
			bbx = [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0];
		} else if (line === "BITMAP") {
			const rows: number[] = [];
			for (i++; i < lines.length && !lines[i].startsWith("ENDCHAR"); i++) {
				rows.push(Number.parseInt(lines[i].trim(), 16) || 0);
			}
			if (encoding >= 0) {
				glyphs.set(encoding, {
					w: Math.max(0, Math.min(8, bbx[0])),
					h: bbx[1],
					xoff: bbx[2],
					yoff: bbx[3],
					rows,
				});
			}
			encoding = -1;
		}
	}
	return makeBitmapFont(name, glyphs, ascent, cellW, cellH);
}

// ---------------------------------------------------------------------------
// unscii .hex parsing (`CODEPOINT:16 hex digits`, one byte per 8x8 row)
// ---------------------------------------------------------------------------

function parseHexFont(text: string): BitmapFont {
	const glyphs = new Map<number, BitmapGlyph>();
	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const cp = Number.parseInt(line.slice(0, colon).trim(), 16);
		const bits = line.slice(colon + 1).trim();
		if (!Number.isFinite(cp) || bits.length !== 16) continue;
		const rows: number[] = [];
		for (let r = 0; r < 8; r++) {
			rows.push(Number.parseInt(bits.slice(r * 2, r * 2 + 2), 16) || 0);
		}
		glyphs.set(cp, { w: 8, h: 8, xoff: 0, yoff: -1, rows });
	}
	// Baseline at row 7 (one descender row), matching the face's design.
	return makeBitmapFont("8x8", glyphs, 7, 8, 8);
}

function makeBitmapFont(
	name: FontName,
	glyphs: Map<number, BitmapGlyph>,
	ascent: number,
	cellW: number,
	cellH: number,
): BitmapFont {
	return {
		kind: "bitmap",
		name,
		glyphs,
		ascent,
		cellW,
		cellH,
		supports: cp => glyphs.has(cp),
	};
}

// ---------------------------------------------------------------------------
// Silver TrueType (lazy opentype.js wrapper)
// ---------------------------------------------------------------------------

/**
 * Rasterize an opentype.js path to an 8-bit coverage bitmap via polygon
 * flattening + even-odd scanline fill. Supersampled 4x4 per pixel for
 * anti-aliasing.
 */
function rasterizePath(path: opentype.Path): TtfGlyph | undefined {
	const cmds = path.commands;
	if (cmds.length === 0) return undefined;

	// Flatten contours (curves sampled) into point lists. opentype.js y grows
	// DOWNWARD already when drawing (it flips internally for getPath output),
	// so the path coordinate space is screen-space at the requested size.
	const SS = 4; // supersample factor
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	const contours: { x: number; y: number }[][] = [];
	let current: { x: number; y: number }[] = [];
	let cx = 0;
	let cy = 0;
	let startX = 0;
	let startY = 0;

	const pushPoint = (x: number, y: number) => {
		current.push({ x, y });
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	};
	const sampleQuadratic = (x1: number, y1: number, x: number, y: number) => {
		const steps = 8;
		for (let t = 1; t <= steps; t++) {
			const s = t / steps;
			const mt = 1 - s;
			pushPoint(mt * mt * cx + 2 * mt * s * x1 + s * s * x, mt * mt * cy + 2 * mt * s * y1 + s * s * y);
		}
	};
	const sampleCubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
		const steps = 12;
		for (let t = 1; t <= steps; t++) {
			const s = t / steps;
			const mt = 1 - s;
			pushPoint(
				mt * mt * mt * cx + 3 * mt * mt * s * x1 + 3 * mt * s * s * x2 + s * s * s * x,
				mt * mt * mt * cy + 3 * mt * mt * s * y1 + 3 * mt * s * s * y2 + s * s * s * y,
			);
		}
	};

	for (const cmd of cmds) {
		switch (cmd.type) {
			case "M":
				if (current.length > 0) contours.push(current);
				current = [];
				cx = cmd.x;
				cy = cmd.y;
				startX = cx;
				startY = cy;
				pushPoint(cx, cy);
				break;
			case "L":
				cx = cmd.x;
				cy = cmd.y;
				pushPoint(cx, cy);
				break;
			case "Q":
				sampleQuadratic(cmd.x1, cmd.y1, cmd.x, cmd.y);
				cx = cmd.x;
				cy = cmd.y;
				break;
			case "C":
				sampleCubic(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
				cx = cmd.x;
				cy = cmd.y;
				break;
			case "Z":
				pushPoint(startX, startY);
				if (current.length > 0) contours.push(current);
				current = [];
				break;
		}
	}
	if (current.length > 0) contours.push(current);
	if (contours.length === 0 || !Number.isFinite(minX)) return undefined;

	// Pad by one output pixel on each side.
	const outW = Math.max(1, Math.ceil(maxX) - Math.floor(minX) + 2);
	const outH = Math.max(1, Math.ceil(maxY) - Math.floor(minY) + 2);
	const originX = Math.floor(minX) - 1;
	const originY = Math.floor(minY) - 1;
	const cov = new Uint8Array(outW * outH);

	// Supersampled even-odd fill: for each subpixel row, collect contour edge
	// crossings, sort, and fill between pairs.
	for (let sy = 0; sy < outH * SS; sy++) {
		const y = originY + (sy + 0.5) / SS;
		const crossings: number[] = [];
		for (const contour of contours) {
			for (let i = 0; i < contour.length - 1; i++) {
				const a = contour[i];
				const b = contour[i + 1];
				if (a.y === b.y) continue;
				if (y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
				crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
			}
		}
		if (crossings.length < 2) continue;
		crossings.sort((p, q) => p - q);
		for (let i = 0; i + 1 < crossings.length; i += 2) {
			const x0 = crossings[i];
			const x1 = crossings[i + 1];
			// Subpixel column span covered by [x0, x1)
			const sx0 = Math.max(0, Math.floor((x0 - originX) * SS));
			const sx1 = Math.min(outW * SS, Math.ceil((x1 - originX) * SS));
			for (let sx = sx0; sx < sx1; sx++) {
				const px = Math.floor(sx / SS);
				cov[Math.floor(sy / SS) * outW + px] += 1; // accumulate subpixel hits
			}
		}
	}
	// Each pixel accumulated up to SS*SS subpixel hits; scale to 0..255.
	const scale = 255 / (SS * SS);
	for (let i = 0; i < cov.length; i++) {
		cov[i] = Math.min(255, Math.round(cov[i] * scale));
	}

	return {
		width: outW,
		height: outH,
		bearingX: originX,
		bearingY: -originY, // distance from baseline up to glyph top (y flipped)
		advance: 0, // filled in by caller from font metrics
		coverage: cov,
	};
}

function loadSilver(): TtfFont {
	const data = readFileSync(join(FONTS_DIR, "Silver.ttf"));
	const face = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
	const px = 16;
	const unitsPerEm = face.unitsPerEm || 2048;
	const scale = px / unitsPerEm;
	const ascentPx = Math.round((face.ascender || unitsPerEm * 0.8) * scale);
	const cache = new Map<string, TtfGlyph | undefined>();

	return {
		kind: "ttf",
		name: "silver",
		cellW: px,
		cellH: px,
		ascent: ascentPx,
		supports(cp) {
			const ch = String.fromCodePoint(cp);
			const glyph = face.charToGlyph(ch);
			return glyph.index !== 0 || ch === " ";
		},
		rasterize(ch, size) {
			const key = `${ch}@${size}`;
			if (cache.has(key)) return cache.get(key);
			let result: TtfGlyph | undefined;
			const glyph = face.charToGlyph(ch);
			if (glyph.index !== 0) {
				const path = glyph.getPath(0, 0, size);
				const rendered = rasterizePath(path);
				if (rendered) {
					rendered.advance = glyph.advanceWidth ? (glyph.advanceWidth * size) / unitsPerEm : size / 2;
					result = rendered;
				}
			}
			cache.set(key, result);
			return result;
		},
	};
}

// ---------------------------------------------------------------------------
// Lazy registry
// ---------------------------------------------------------------------------

const registry = new Map<FontName, LoadedFont>();

export function loadFont(name: FontName): LoadedFont {
	let font = registry.get(name);
	if (font) return font;
	switch (name) {
		case "5x8":
			font = parseBdf("5x8", readFileSync(join(FONTS_DIR, "5x8.bdf"), "utf8"), 5, 8);
			break;
		case "6x12":
			font = parseBdf("6x12", readFileSync(join(FONTS_DIR, "6x12.bdf"), "utf8"), 6, 12);
			break;
		case "8x13":
			font = parseBdf("8x13", readFileSync(join(FONTS_DIR, "8x13.bdf"), "utf8"), 8, 13);
			break;
		case "8x8":
			font = parseHexFont(readFileSync(join(FONTS_DIR, "unscii-8.hex"), "utf8"));
			break;
		case "silver":
			font = loadSilver();
			break;
	}
	registry.set(name, font);
	return font;
}

/**
 * Which of the given characters a font can draw. Used by the normalizer to
 * decide which non-Latin glyphs may pass through to the frame.
 */
export function supportedChars(fontName: FontName, chars: readonly string[]): Set<string> {
	const font = loadFont(fontName);
	const out = new Set<string>();
	for (const ch of chars) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && font.supports(cp)) out.add(ch);
	}
	return out;
}
