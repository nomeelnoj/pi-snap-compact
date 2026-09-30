/**
 * Archive layout planning.
 *
 * The accumulated archive text (oldest → newest) is laid out as:
 *
 *   [ verbatim text head ]  [ imaged middle: frames ]  [ verbatim text tail ]
 *
 * One HQ-frame capacity stays plain text at each chronological edge (the
 * session head and the slice just before the kept live messages). When the
 * imaged middle overflows the frame budget it foveates internally: HQ frames
 * at both of ITS edges, a denser (same-pixels, tighter-cell) tier filling the
 * center, and the oldest slice of the dense center dropped.
 *
 * Adapted from @oh-my-pi/snapcompact (packages/snapcompact/src/snapcompact.ts,
 * MIT, Copyright (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc.). See NOTICE.md.
 */

import { paginateCells, wrapText } from "./cells.ts";
import { gridGeometry, type Shape } from "./shapes.ts";

/** Plain-text pages kept at each chronological edge, in HQ-capacity units. */
export const TEXT_EDGE_PAGES = 1;
/** HQ frames rendered at each chronological edge of a foveated imaged middle. */
export const HQ_EDGE_FRAMES = 3;
/** Default upper bound on frames carried per compaction. An upper limit, not
 *  a promised count — budgets may cap it lower. */
export const MAX_FRAMES_DEFAULT = 80;

export interface PlanFrame {
	text: string;
	shape: Shape;
}

export interface ArchiveLayout {
	frames: PlanFrame[];
	textHead: string;
	textTail: string;
	/** Flat kept source (head + imaged middle + tail) to persist as the
	 *  re-render source for the next compaction. */
	keptText: string;
	/** Characters dropped this round to fit the budget. */
	truncatedChars: number;
}

function usesWideCells(shape: Shape): boolean {
	return shape.font !== "silver";
}

/** Paginate already-normalized text for a doc shape: wrap once at the column
 *  width, then slice into pages of `2 * rows` lines, `\n`-joined. */
export function docPages(normalized: string, shape: Shape): string[] {
	const geo = gridGeometry(shape);
	const lines = wrapText(normalized, geo.cols, usesWideCells(shape));
	const perPage = 2 * geo.rows;
	const pages: string[] = [];
	for (let offset = 0; offset < lines.length; offset += perPage) {
		pages.push(lines.slice(offset, offset + perPage).join("\n"));
	}
	return pages;
}

function planFrames(pages: readonly string[], shape: Shape): PlanFrame[] {
	return pages.map(text => ({ text, shape }));
}

/** Lay out the archive text. See module doc for the layout. */
export function planArchive(text: string, high: Shape, low: Shape, maxFrames: number): ArchiveLayout {
	const geoHigh = gridGeometry(high);
	const edgeCap = TEXT_EDGE_PAGES * geoHigh.capacity;

	if (text.length <= 2 * edgeCap) {
		return { frames: [], textHead: text, textTail: "", keptText: text, truncatedChars: 0 };
	}
	if (maxFrames < 1) {
		const textHead = text.slice(0, edgeCap);
		const textTail = text.slice(text.length - edgeCap);
		return {
			frames: [],
			textHead,
			textTail,
			keptText: textHead + textTail,
			truncatedChars: text.length - textHead.length - textTail.length,
		};
	}

	const textHead = text.slice(0, edgeCap);
	const textTail = text.slice(text.length - edgeCap);
	const imageText = text.slice(edgeCap, text.length - edgeCap);
	if (imageText.length === 0) {
		return { frames: [], textHead, textTail: "", keptText: text, truncatedChars: 0 };
	}

	// Doc layouts wrap (no char-slicing) and do not foveate: single tier, pin
	// the first page, keep the newest pages, drop the oldest middle pages.
	if (high.columns === 2) {
		const pages = docPages(imageText, high);
		let kept = pages;
		let truncatedChars = 0;
		if (pages.length > maxFrames) {
			const dropped = pages.slice(1, pages.length - (maxFrames - 1));
			truncatedChars = dropped.reduce((sum, page) => sum + page.length, 0);
			kept = [...pages.slice(0, 1), ...pages.slice(pages.length - (maxFrames - 1))];
		}
		const flat = kept.map(page => page.replaceAll("\n", " ")).join(" ");
		return {
			frames: planFrames(kept, high),
			textHead,
			textTail,
			keptText: textHead + flat + textTail,
			truncatedChars,
		};
	}

	// Grid: paginate the imaged region at HQ capacity first.
	const hiPages = paginateCells(imageText, geoHigh.capacity, geoHigh.cols, usesWideCells(high));
	if (hiPages.length <= maxFrames) {
		return {
			frames: planFrames(hiPages, high),
			textHead,
			textTail,
			keptText: textHead + imageText + textTail,
			truncatedChars: 0,
		};
	}

	// Foveate: HQ at both imaged-middle edges, dense tier in the center, and
	// drop the oldest dense-center pages once over budget.
	const geoLow = gridGeometry(low);
	const imageEdgeFrames = Math.min(HQ_EDGE_FRAMES, Math.floor((maxFrames - 1) / 2));
	const headPages = hiPages.slice(0, imageEdgeFrames);
	const tailPages = imageEdgeFrames > 0 ? hiPages.slice(hiPages.length - imageEdgeFrames) : [];
	const imageHead = headPages.join("");
	const imageTail = tailPages.join("");
	const middleSource = imageText.slice(imageHead.length, imageText.length - imageTail.length);
	let middlePages = paginateCells(middleSource, geoLow.capacity, geoLow.cols, usesWideCells(low));
	const middleBudget = maxFrames - 2 * imageEdgeFrames;
	let truncatedChars = 0;
	let middleText = middleSource;
	if (middlePages.length > middleBudget) {
		const dropped = middlePages.slice(0, middlePages.length - middleBudget).join("");
		truncatedChars = dropped.length;
		middleText = middleSource.slice(dropped.length);
		middlePages = middlePages.slice(middlePages.length - middleBudget);
	}
	return {
		frames: [...planFrames(headPages, high), ...planFrames(middlePages, low), ...planFrames(tailPages, high)],
		textHead,
		textTail,
		keptText: textHead + imageHead + middleText + imageTail + textTail,
		truncatedChars,
	};
}
