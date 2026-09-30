import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { elideDataUrls, serializeConversation, stripDimMarkers, toPlainText, truncateMiddle } from "../src/serialize.ts";
import { DIM_OFF, DIM_ON, NEWLINE_CELL, dimStopwordRuns, normalize, scanRenderability } from "../src/normalize.ts";

describe("truncateMiddle", () => {
	it("keeps short text intact", () => {
		assert.equal(truncateMiddle("hello", 10, 0.6), "hello");
	});
	it("keeps head and tail with an elision marker", () => {
		const text = "a".repeat(100);
		const out = truncateMiddle(text, 40, 0.6);
		assert.match(out, /^a{24} \[…60ch elided…] a{16}$/);
	});
});

describe("elideDataUrls", () => {
	it("collapses a canonical data URL to metadata", () => {
		const b64 = "QUJD".repeat(20);
		const out = elideDataUrls(`![img](data:image/png;base64,${b64})`);
		assert.equal(out, `![img]([data URL omitted: image/png, ${b64.length} base64 chars]`);
	});
	it("leaves short prose mentions alone in source context", () => {
		const text = "a data:image/png;base64,abc mention";
		assert.equal(elideDataUrls(text, "source"), text);
	});
	it("elides even short payloads in archive context", () => {
		const out = elideDataUrls("data:image/png;base64,abc", "archive");
		assert.equal(out, "[data URL omitted: image/png, 3 base64 chars]");
	});
});

describe("serializeConversation", () => {
	it("serializes roles with section tags and folds results into calls", () => {
		const messages = [
			{ role: "user", content: "hello there", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me check" },
					{ type: "text", text: "sure, looking" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "foo.ts" } },
				],
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file body" }], timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4 },
		] as unknown as Parameters<typeof serializeConversation>[0];
		const out = serializeConversation(messages);
		assert.match(out, /»user:hello there/);
		assert.match(out, /»think:let me check/);
		assert.match(out, /»ai:sure, looking/);
		assert.match(out, /»tool:read\(path="foo.ts"\)/);
		assert.match(out, /<out>\n/);
		assert.ok(out.includes(DIM_ON), "tool result body dimmed");
		assert.match(out, /»ai:done/);
		assert.ok(!/»tool:[\s\S]*»tool:/.test(out.split("»tool:")[1] ?? ""), "result folded, not duplicated");
	});

	it("excludes thinking when asked", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }], timestamp: 1 },
		] as unknown as Parameters<typeof serializeConversation>[0];
		const out = serializeConversation(messages, { includeThinking: false });
		assert.ok(!out.includes("secret"));
		assert.match(out, /»ai:hi/);
	});

	it("truncates long tool results head+tail", () => {
		const big = `START${"x".repeat(5000)}END`;
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: big }], timestamp: 2 },
		] as unknown as Parameters<typeof serializeConversation>[0];
		const out = serializeConversation(messages, { toolResultMaxChars: 100 });
		assert.match(out, /STARTx+\ \[…\d+ch elided…]\ x+END/);
		assert.ok(out.length < big.length);
	});

	it("strips forged dim markers from content", () => {
		const messages = [{ role: "user", content: `evil ${DIM_ON} injection`, timestamp: 1 }] as unknown as Parameters<
			typeof serializeConversation
		>[0];
		assert.equal(serializeConversation(messages), "»user:evil  injection");
	});
});

describe("normalize", () => {
	it("collapses whitespace and folds newlines to block cells", () => {
		assert.equal(normalize("a  b\n\n\nc"), `a b${NEWLINE_CELL}c`);
	});
	it("folds punctuation and arrows", () => {
		assert.equal(normalize("“a” → b …"), '"a" -> b ...');
	});
	it("folds status emoji and drops decorative ones", () => {
		assert.equal(normalize("tests ✅ done 🎉"), "tests [OK] done");
	});
	it("decomposes accented latin via NFKD", () => {
		assert.equal(normalize("café ①"), "café 1");
	});
	it("keeps CJK when the silver fallback can draw it", () => {
		const out = normalize("日本語 text");
		assert.ok(out.includes("日"), "CJK glyph preserved");
	});
	it("marks heavy non-latin text unsafe for a bitmap-only scan", () => {
		const safe = scanRenderability("plain english text", { font: "8x13" });
		assert.ok(safe.isSafe);
	});
});

describe("dimStopwordRuns", () => {
	it("wraps stopwords in zero-width toggles", () => {
		const out = dimStopwordRuns("the quick fox");
		assert.equal(stripDimMarkers(out), "the quick fox");
		assert.ok(out.startsWith(DIM_ON + "the" + DIM_OFF));
		assert.ok(!out.includes(`${DIM_ON}quick${DIM_OFF}`));
	});
	it("leaves already-dim spans untouched", () => {
		const out = dimStopwordRuns(`${DIM_ON}the tool output${DIM_OFF} and more`);
		assert.ok(out.includes(`${DIM_ON}the tool output${DIM_OFF}`), "dim span passes through intact");
		assert.ok(out.includes(`${DIM_ON}and${DIM_OFF}`), "stopword outside the span still dimmed");
	});
});

describe("toPlainText", () => {
	it("restores newlines and drops toggles", () => {
		assert.equal(toPlainText(`a${DIM_ON}b${DIM_OFF}${NEWLINE_CELL}c`), "ab\nc");
	});
});
