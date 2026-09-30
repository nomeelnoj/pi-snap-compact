/**
 * Extension settings, read from pi's settings.json files under the
 * `snapcompact` key (project `.pi/settings.json` overrides global
 * `~/.pi/agent/settings.json`), with `PI_SNAPCOMPACT_*` env overrides.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FRAME_BYTES_BUDGET } from "./archive.ts";
import { MAX_FRAMES_DEFAULT } from "./plan.ts";
import { isShapeVariantName, type ShapeVariantName } from "./shapes.ts";

export interface SnapcompactSettings {
	/** Master switch. Default true. */
	enabled: boolean;
	/** Forced research variant, or "auto" for model-aware selection. */
	shape: ShapeVariantName | "auto";
	/** Upper limit on archive frames per compaction (clamped to {@link MAX_FRAMES_DEFAULT}). */
	maxFrames?: number;
	/** Per-request cap on image base64 bytes when rebuilding context (clamped to
	 *  {@link FRAME_BYTES_BUDGET}; settings may only lower the budget, never raise it). */
	maxFrameBytes?: number;
	/** Serialize reasoning sections into the archive. Default true. */
	includeThinking: boolean;
	/** Print tool results in dim ink. Default true. */
	dimToolResults: boolean;
}

const DEFAULTS: SnapcompactSettings = {
	enabled: true,
	shape: "auto",
	includeThinking: true,
	dimToolResults: true,
};

function readSettingsFile(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** A positive integer budget from untrusted config, clamped to `ceiling`. */
function boundedPositive(value: unknown, ceiling: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(Math.floor(value), ceiling);
}

/**
 * Resolve settings from an already-merged raw `snapcompact` object plus
 * environment overrides. Pure: no filesystem access. Project settings files
 * are untrusted input (a cloned repository ships them), so every budget is
 * clamped to the engine ceiling — config can lower a budget, never raise it.
 */
export function resolveSettings(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): SnapcompactSettings {
	const settings: SnapcompactSettings = { ...DEFAULTS };
	if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
	if (raw.shape === "auto" || isShapeVariantName(raw.shape)) settings.shape = raw.shape;
	const maxFrames = boundedPositive(raw.maxFrames, MAX_FRAMES_DEFAULT);
	if (maxFrames !== undefined) settings.maxFrames = maxFrames;
	const maxFrameBytes = boundedPositive(raw.maxFrameBytes, FRAME_BYTES_BUDGET);
	if (maxFrameBytes !== undefined) settings.maxFrameBytes = maxFrameBytes;
	if (typeof raw.includeThinking === "boolean") settings.includeThinking = raw.includeThinking;
	if (typeof raw.dimToolResults === "boolean") settings.dimToolResults = raw.dimToolResults;

	// Env overrides win last.
	if (env.PI_SNAPCOMPACT_ENABLED !== undefined) {
		settings.enabled = !/^(0|false|off)$/i.test(env.PI_SNAPCOMPACT_ENABLED);
	}
	const envShape = env.PI_SNAPCOMPACT_SHAPE;
	if (envShape === "auto" || isShapeVariantName(envShape)) settings.shape = envShape;
	if (env.PI_SNAPCOMPACT_MAX_FRAMES) {
		const n = boundedPositive(Number.parseInt(env.PI_SNAPCOMPACT_MAX_FRAMES, 10), MAX_FRAMES_DEFAULT);
		if (n !== undefined) settings.maxFrames = n;
	}
	return settings;
}

export function loadSettings(cwd: string): SnapcompactSettings {
	const global = readSettingsFile(join(homedir(), ".pi", "agent", "settings.json"));
	const project = readSettingsFile(join(cwd, ".pi", "settings.json"));
	const raw = {
		...(typeof global.snapcompact === "object" && global.snapcompact !== null ? global.snapcompact : {}),
		...(typeof project.snapcompact === "object" && project.snapcompact !== null ? project.snapcompact : {}),
	} as Record<string, unknown>;
	return resolveSettings(raw);
}
