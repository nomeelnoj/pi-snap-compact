/**
 * Grid-cell accounting shared by pagination (plan.ts) and rasterization
 * (raster.ts). Wide East Asian code points occupy two cells in narrow bitmap
 * shapes (the square-celled Silver shape sizes each cell for a full-width
 * glyph already); the zero-width dim-ink toggles occupy none. Both sides MUST
 * agree on these counts or pages overflow their frames.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { DIM_OFF, DIM_ON } from "./normalize.ts";

/** East Asian Wide / Fullwidth ranges. */
export function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x2eff) ||
		(cp >= 0x2f00 && cp <= 0x2fdf) ||
		(cp >= 0x3000 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	);
}

/** Cells one character occupies: 0 for ink toggles, 2 for wide code points
 *  when the shape uses narrow cells, 1 otherwise. */
export function charCells(ch: string, wideCells: boolean): number {
	if (ch === DIM_ON || ch === DIM_OFF) return 0;
	const cp = ch.codePointAt(0);
	return wideCells && cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

/** Total grid cells a string occupies (ignoring row wrapping/pads). */
export function cellLength(text: string, wideCells: boolean): number {
	let cells = 0;
	for (const ch of text) cells += charCells(ch, wideCells);
	return cells;
}

/** Longest prefix of `text` that fits `width` cells (at least one char). */
export function sliceCells(text: string, width: number, wideCells: boolean): string {
	let cells = 0;
	let out = "";
	let placed = false;
	for (const ch of text) {
		const w = charCells(ch, wideCells);
		if (placed && cells + w > width) break;
		out += ch;
		cells += w;
		if (w > 0) placed = true;
	}
	return out;
}

/**
 * Split `text` into pages that each fill at most `capacity` grid cells,
 * inserting a one-cell pad before a wide glyph that would straddle the right
 * edge. Pages are contiguous substrings, so each renders independently
 * starting at cell 0. A single char wider than the whole budget still rides
 * its page; the rasterizer clips it.
 */
export function paginateCells(text: string, capacity: number, cols: number, wideCells: boolean): string[] {
	const chars = [...text];
	const pages: string[] = [];
	let start = 0;
	let cell = 0;
	let hasCell = false;
	for (let i = 0; i < chars.length; i++) {
		const w = charCells(chars[i], wideCells);
		if (w === 0) continue;
		let at = cell;
		if (w === 2 && cols >= 2 && at % cols === cols - 1) at += 1;
		if (hasCell && at + w > capacity) {
			pages.push(chars.slice(start, i).join(""));
			start = i;
			at = 0;
		}
		cell = at + w;
		hasCell = true;
	}
	if (hasCell) pages.push(chars.slice(start).join(""));
	return pages;
}

/**
 * Greedy word wrap for doc layouts — no mid-word breaks except for words
 * longer than a full line. Zero-width ink toggles count toward word length;
 * the serializer places them at word boundaries, so drift is at most one cell
 * per affected line.
 */
export function wrapText(text: string, width: number, wideCells = false): string[] {
	const lines: string[] = [];
	let cur = "";
	let curCells = 0;
	for (const token of text.split(/\s+/)) {
		if (token.length === 0) continue;
		let word = token;
		let wordCells = cellLength(word, wideCells);
		while (wordCells > width) {
			if (cur) {
				lines.push(cur);
				cur = "";
				curCells = 0;
			}
			const head = sliceCells(word, width, wideCells);
			lines.push(head);
			word = word.slice(head.length);
			wordCells = cellLength(word, wideCells);
		}
		if (!cur) {
			cur = word;
			curCells = wordCells;
		} else if (curCells + 1 + wordCells <= width) {
			cur += ` ${word}`;
			curCells += 1 + wordCells;
		} else {
			lines.push(cur);
			cur = word;
			curCells = wordCells;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}
