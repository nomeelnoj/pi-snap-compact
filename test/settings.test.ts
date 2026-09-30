import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FRAME_BYTES_BUDGET } from "../src/archive.ts";
import { MAX_FRAMES_DEFAULT } from "../src/plan.ts";
import { resolveSettings } from "../src/settings.ts";

const NO_ENV: NodeJS.ProcessEnv = {};

describe("resolveSettings", () => {
	it("returns defaults for an empty object", () => {
		const s = resolveSettings({}, NO_ENV);
		assert.equal(s.enabled, true);
		assert.equal(s.shape, "auto");
		assert.equal(s.maxFrames, undefined);
		assert.equal(s.maxFrameBytes, undefined);
		assert.equal(s.includeThinking, true);
		assert.equal(s.dimToolResults, true);
	});

	it("accepts budgets at or below the engine ceilings", () => {
		const s = resolveSettings({ maxFrames: 12, maxFrameBytes: 1_000_000 }, NO_ENV);
		assert.equal(s.maxFrames, 12);
		assert.equal(s.maxFrameBytes, 1_000_000);
	});

	it("clamps budgets above the engine ceilings", () => {
		const s = resolveSettings({ maxFrames: 10_000, maxFrameBytes: 500_000_000 }, NO_ENV);
		assert.equal(s.maxFrames, MAX_FRAMES_DEFAULT);
		assert.equal(s.maxFrameBytes, FRAME_BYTES_BUDGET);
	});

	it("ignores non-positive, non-finite, and non-numeric budgets", () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "80", null, true]) {
			const s = resolveSettings({ maxFrames: bad, maxFrameBytes: bad }, NO_ENV);
			assert.equal(s.maxFrames, undefined, `maxFrames rejects ${String(bad)}`);
			assert.equal(s.maxFrameBytes, undefined, `maxFrameBytes rejects ${String(bad)}`);
		}
	});

	it("rejects unknown shape names", () => {
		assert.equal(resolveSettings({ shape: "not-a-shape" }, NO_ENV).shape, "auto");
		assert.equal(resolveSettings({ shape: "8on22-bw" }, NO_ENV).shape, "8on22-bw");
	});

	it("applies env overrides last, with the same frame clamp", () => {
		const s = resolveSettings(
			{ enabled: true, shape: "8on22-bw", maxFrames: 10 },
			{ PI_SNAPCOMPACT_ENABLED: "off", PI_SNAPCOMPACT_SHAPE: "silver16-bw", PI_SNAPCOMPACT_MAX_FRAMES: "999" },
		);
		assert.equal(s.enabled, false);
		assert.equal(s.shape, "silver16-bw");
		assert.equal(s.maxFrames, MAX_FRAMES_DEFAULT);
	});
});
