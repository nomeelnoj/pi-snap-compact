import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { archiveBlocks, FRAME_BYTES_BUDGET, getArchive, type Archive } from "../src/archive.ts";
import { compact, resolveShapeForText } from "../src/compact.ts";
import { planArchive } from "../src/plan.ts";
import { rasterizeFrame } from "../src/raster.ts";
import { NEWLINE_CELL } from "../src/normalize.ts";
import { priceShape, resolveShape, SHAPE_VARIANTS, gridGeometry } from "../src/shapes.ts";
import type { Message } from "@earendil-works/pi-ai";

const anthropicOpus = { api: "anthropic-messages", id: "claude-opus-4-8" };

describe("raster", () => {
	const shape = priceShape(SHAPE_VARIANTS["11on16-bw"], "anthropic");

	it("renders a frame whose height hugs the printed rows", () => {
		const oneRow = rasterizeFrame("hello world", shape);
		const png = oneRow.png;
		assert.equal(png.readUInt32BE(16), 1568, "width fixed at frame edge");
		assert.equal(png.readUInt32BE(20), 16, "one row tall");
		assert.equal(oneRow.chars, 11);
	});

	it("renders a full page at capacity", () => {
		const geo = gridGeometry(shape);
		const text = "x".repeat(geo.capacity);
		const frame = rasterizeFrame(text, shape);
		assert.equal(frame.chars, geo.capacity);
		assert.equal(frame.png.readUInt32BE(20), geo.rows * shape.cellH);
	});

	it("clips beyond capacity", () => {
		const geo = gridGeometry(shape);
		const frame = rasterizeFrame("y".repeat(geo.capacity + 50), shape);
		assert.equal(frame.chars, geo.capacity);
	});

	it("newline cells fill a black block and dim spans print gray", () => {
		const text = `ab${NEWLINE_CELL}cd`;
		const frame = rasterizeFrame(text, shape);
		const raw = inflateSync(readIdat(frame.png));
		const stride = 1568 * 3 + 1;
		// NEWLINE_CELL sits at cell index 2 (third cell): fully black inside.
		const cellX = 2 * shape.cellW;
		const mid = 8 * stride + 1 + (cellX + 4) * 3; // row 8, filter byte, mid-cell
		assert.equal(raw[mid], 0, "black newline block");
		assert.ok(frame.png.length > 100, "non-trivial PNG");
	});

	it("renders CJK via the silver fallback spanning two cells", () => {
		const frame = rasterizeFrame("ab日本", shape);
		assert.equal(frame.chars, 4);
		assert.ok(frame.png.length > 0);
	});

	it("renders the whole-frame silver shape", () => {
		const silver = priceShape(SHAPE_VARIANTS["silver16-bw"], "anthropic");
		const frame = rasterizeFrame("日本語テスト hello", silver);
		assert.ok(frame.chars > 0);
	});

	it("renders doc shapes with two columns of wrapped lines", () => {
		const doc = priceShape(SHAPE_VARIANTS["doc-8on16-bw"], "anthropic");
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i} of the page`);
		const frame = rasterizeFrame(lines.join("\n"), doc);
		assert.equal(frame.chars > 0, true);
	});

	it("repeat shapes print bands and stay within geometry", () => {
		const rep = priceShape(SHAPE_VARIANTS["8x8r-bw"], "anthropic");
		const frame = rasterizeFrame("repeat me please", rep);
		assert.equal(frame.png.readUInt32BE(20), 16, "one logical row = 2 cell rows");
	});
});

function readIdat(png: Buffer): Buffer {
	let off = 8;
	const idat: Buffer[] = [];
	while (off < png.length) {
		const len = png.readUInt32BE(off);
		const type = png.subarray(off + 4, off + 8).toString("ascii");
		if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
		off += 12 + len;
	}
	return Buffer.concat(idat);
}

describe("planArchive", () => {
	const high = priceShape(SHAPE_VARIANTS["11on16-bw"], "anthropic");
	const low = priceShape({ ...SHAPE_VARIANTS["8on16-bw"], frameSize: high.frameSize }, "anthropic");
	const cap = gridGeometry(high).capacity;

	it("keeps short archives fully as text", () => {
		const layout = planArchive("small archive", high, low, 10);
		assert.equal(layout.frames.length, 0);
		assert.equal(layout.textHead, "small archive");
		assert.equal(layout.truncatedChars, 0);
	});

	it("images the middle and keeps text edges", () => {
		const text = "a".repeat(cap * 5);
		const layout = planArchive(text, high, low, 10);
		assert.equal(layout.textHead.length, cap);
		assert.equal(layout.textTail.length, cap);
		assert.equal(layout.frames.length, 3);
		assert.equal(layout.truncatedChars, 0);
		assert.equal(layout.keptText.length, text.length);
	});

	it("foveates when over budget: HQ edges, dense middle, oldest dropped", () => {
		const text = "b".repeat(cap * 40);
		const maxFrames = 11;
		const layout = planArchive(text, high, low, maxFrames);
		assert.equal(layout.frames.length, maxFrames);
		const tiers = layout.frames.map(f => (f.shape === high ? "HQ" : "LQ"));
		assert.deepEqual(tiers.slice(0, 3), ["HQ", "HQ", "HQ"]);
		assert.deepEqual(tiers.slice(-3), ["HQ", "HQ", "HQ"]);
		assert.ok(tiers.slice(3, -3).every(t => t === "LQ"));
		assert.ok(layout.truncatedChars > 0, "oldest dense slice dropped");
	});
});

describe("archive blocks", () => {
	it("rebuilds text head + frames + text tail in order", () => {
		const archive: Archive = {
			frames: [
				{ data: "AAA", mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
				{ data: "BBBB", mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
			],
			totalChars: 10,
			truncatedChars: 0,
			text: `head${NEWLINE_CELL}tail`,
			textHead: "head",
			textTail: "tail",
		};
		const blocks = archiveBlocks(archive);
		assert.deepEqual(blocks.map(b => b.type), ["text", "image", "image", "text"]);
	});

	it("drops oldest frames first over the byte budget and marks the gap", () => {
		const archive: Archive = {
			frames: [
				{ data: "A".repeat(100), mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
				{ data: "B".repeat(100), mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
				{ data: "C".repeat(100), mimeType: "image/png", cols: 1, rows: 1, chars: 1 },
			],
			totalChars: 3,
			truncatedChars: 0,
		};
		const blocks = archiveBlocks(archive, { maxFrameBytes: 150 });
		const images = blocks.filter(b => b.type === "image");
		assert.equal(images.length, 1, "only newest frame fits");
		assert.equal(images[0].data, "C".repeat(100));
		assert.ok(blocks.some(b => b.type === "text" && b.text?.includes("omitted")));
	});

	it("validates persisted archives and rejects empties", () => {
		assert.equal(getArchive(undefined), undefined);
		assert.equal(getArchive({ snapcompact: {} }), undefined);
		const good = getArchive({ snapcompact: { frames: [], totalChars: 5, truncatedChars: 0, text: "hello" } });
		assert.equal(good?.text, "hello");
	});

	it("respects the default frame byte budget constant", () => {
		assert.ok(FRAME_BYTES_BUDGET > 0);
	});
});

describe("compact (end to end, small)", () => {
	const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	const prep = (messages: Message[]) => ({
		firstKeptEntryId: "keep-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		tokensBefore: 12345,
		fileOps,
	});

	it("archives a small conversation as pure text (no frames needed)", () => {
		const messages = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		] as unknown as Message[];
		const result = compact(prep(messages), { model: anthropicOpus });
		assert.equal(result.firstKeptEntryId, "keep-1");
		const archive = getArchive(result.details);
		assert.ok(archive, "archive persisted under details");
		assert.equal(archive.frames.length, 0);
		assert.ok(archive.textHead?.includes("»user:hello"));
		assert.match(result.summary, /HISTORY/);
	});

	it("renders frames for large histories and persists re-render source", () => {
		const big = "lorem ipsum dolor sit amet ".repeat(2000);
		const messages = [
			{ role: "user", content: big, timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: big }], timestamp: 2 },
		] as unknown as Message[];
		const result = compact(prep(messages), { model: anthropicOpus });
		const archive = getArchive(result.details);
		assert.ok(archive && archive.frames.length > 0, "frames rendered");
		for (const frame of archive.frames) {
			const png = Buffer.from(frame.data, "base64");
			assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
		}
		assert.ok(archive.text, "source text persisted for re-render");
		assert.ok(archive.textTail, "newest edge kept as text");
	});

	it("folds a previous archive into the next compaction", () => {
		const first = compact(prep([{ role: "user", content: "first session chunk", timestamp: 1 }] as unknown as Message[]), {
			model: anthropicOpus,
		});
		const second = compact(
			{
				...prep([{ role: "user", content: "second chunk", timestamp: 2 }] as unknown as Message[]),
				previousDetails: first.details,
				previousSummary: first.summary,
			},
			{ model: anthropicOpus },
		);
		const archive = getArchive(second.details);
		assert.ok(archive?.text?.includes("first session chunk"), "prior source carried forward");
		assert.ok(archive?.text?.includes("second chunk"), "new history appended");
	});

	it("selects the silver shape for CJK-heavy text on auto", () => {
		const shape = resolveShapeForText("日本語のテキストがたくさんある場合のテストです。これはテスト。", anthropicOpus, "auto");
		assert.equal(shape.font, "silver");
	});
});
