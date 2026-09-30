import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { cellLength, paginateCells, sliceCells, wrapText } from "../src/cells.ts";
import { DIM_ON, DIM_OFF, NEWLINE_CELL } from "../src/normalize.ts";
import { encodePngIndexed, encodePngRgb } from "../src/png.ts";
import { gridGeometry, resolveShape, billingFamily, priceShape, SHAPE_VARIANTS, idealShapeForModel, denseCompanion } from "../src/shapes.ts";

describe("cells", () => {
	it("counts dim toggles as zero width", () => {
		assert.equal(cellLength(`a${DIM_ON}bc${DIM_OFF}d`, false), 4);
	});
	it("counts CJK as two cells in narrow grids", () => {
		assert.equal(cellLength("ab日c", true), 5);
		assert.equal(cellLength("ab日c", false), 4);
	});
	it("paginates within capacity, padding wide straddlers", () => {
		const pages = paginateCells("abcdef", 3, 3, false);
		assert.deepEqual(pages, ["abc", "def"]);
		const wide = paginateCells("ab日cd", 4, 2, true);
		assert.deepEqual(wide, ["ab日", "cd"]);
	});
	it("wraps words without mid-word breaks", () => {
		assert.deepEqual(wrapText("one two three four", 8), ["one two", "three", "four"]);
	});
	it("hard-splits pathological long words", () => {
		assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
	});
	it("sliceCells always takes at least one char", () => {
		assert.equal(sliceCells("日", 1, true), "日");
	});
});

describe("png", () => {
	const decode = (png: Buffer) => {
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "signature");
		// Walk chunks.
		let off = 8;
		const chunks: Record<string, Buffer> = {};
		while (off < png.length) {
			const len = png.readUInt32BE(off);
			const type = png.subarray(off + 4, off + 8).toString("ascii");
			chunks[type] = png.subarray(off + 8, off + 8 + len);
			off += 12 + len;
		}
		assert.ok(chunks.IHDR && chunks.IDAT && chunks.IEND);
		const width = chunks.IHDR.readUInt32BE(0);
		const height = chunks.IHDR.readUInt32BE(4);
		const colorType = chunks.IHDR[9];
		return { width, height, colorType, raw: inflateSync(chunks.IDAT) };
	};

	it("encodes indexed PNGs that round-trip", () => {
		const pixels = new Uint8Array(16).fill(0);
		pixels[5] = 7;
		const png = encodePngIndexed(4, 4, [[255, 255, 255], [0, 0, 0], [0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0, 0, 0]], pixels);
		const { width, height, colorType, raw } = decode(png);
		assert.equal(width, 4);
		assert.equal(height, 4);
		assert.equal(colorType, 3);
		assert.equal(raw.length, 4 * 5);
		assert.equal(raw[1 * 5 + 1 + 1], 7, "pixel preserved");
	});

	it("encodes RGB PNGs that round-trip", () => {
		const rgb = new Uint8Array(2 * 2 * 3).fill(255);
		rgb[0] = 12;
		const png = encodePngRgb(2, 2, rgb);
		const { colorType, raw } = decode(png);
		assert.equal(colorType, 2);
		assert.equal(raw[1], 12);
	});
});

describe("shapes", () => {
	it("maps wire APIs to billing families", () => {
		assert.equal(billingFamily("anthropic-messages"), "anthropic");
		assert.equal(billingFamily("bedrock-converse-stream"), "anthropic");
		assert.equal(billingFamily("google-vertex"), "google");
		assert.equal(billingFamily("openai-responses"), "openai");
		assert.equal(billingFamily("mystery-api"), "unknown");
	});

	it("resolves model lines to eval winners", () => {
		assert.equal(resolveShape({ api: "anthropic-messages", id: "claude-opus-4-8" }).frameSize, 1932);
		assert.equal(resolveShape({ api: "anthropic-messages", id: "claude-sonnet-4-5" }).frameSize, 1568);
		assert.equal(resolveShape({ api: "google-generative-ai", id: "gemini-3-flash" }).frameSize, 2048);
		assert.equal(resolveShape({ api: "openai-responses", id: "gpt-5.5" }).ink, "bw");
		assert.equal(resolveShape({ api: "anthropic-messages", id: "kimi-k3" }).font, "8x13");
	});

	it("a Claude through a gateway keeps the Claude geometry, gateway billing", () => {
		const viaVertex = resolveShape({ api: "google-vertex", id: "claude-opus-4-8" });
		assert.equal(viaVertex.frameSize, 1932, "Claude shape kept");
		assert.equal(viaVertex.frameTokens, 1120, "billed as google");
	});

	it("forced variants keep geometry and get re-priced", () => {
		const forced = resolveShape({ api: "openai-responses", id: "gpt-5.5" }, "6x6u-bw");
		assert.equal(forced.cellW, 6);
		assert.equal(forced.frameTokens, priceShape(SHAPE_VARIANTS["6x6u-bw"], "openai").frameTokens);
	});

	it("grid geometry accounts for repeat copies and doc gutter", () => {
		const g = gridGeometry(SHAPE_VARIANTS["11on16-bw"]);
		assert.equal(g.cols, Math.floor(1568 / 11));
		assert.equal(g.rows, Math.floor(1568 / 16));
		const doc = gridGeometry(SHAPE_VARIANTS["doc-8on16-bw"]);
		assert.equal(doc.cols, Math.floor((Math.floor(1568 / 8) - 3) / 2));
		const rep = gridGeometry(SHAPE_VARIANTS["8x8r-bw"]);
		assert.equal(rep.rows, Math.floor(1568 / 8 / 2));
	});

	it("dense companion packs more chars at identical frame size", () => {
		const high = resolveShape({ api: "anthropic-messages", id: "claude-opus-4-8" });
		const low = denseCompanion(high, "anthropic-messages");
		assert.ok(gridGeometry(low).capacity > gridGeometry(high).capacity);
		assert.equal(low.frameSize, high.frameSize);
	});

	it("idealShapeForModel is regex-driven and version-aware", () => {
		assert.equal(idealShapeForModel("claude-fable-latest")?.frameSize, 1932);
		assert.equal(idealShapeForModel("claude-opus-4-5")?.frameSize, undefined);
		assert.equal(idealShapeForModel("unknown-model-9000"), undefined);
	});
});
