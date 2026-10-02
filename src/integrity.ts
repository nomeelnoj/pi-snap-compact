/**
 * Per-machine archive signing key.
 *
 * Persisted archives (`CompactionEntry.details.snapcompact`) are replayed
 * verbatim to the model on every request, and the session file they live in
 * is plain JSON anyone with write access can edit — or hand you. The archive
 * carries an HMAC under a key that lives in pi's agent directory (default
 * `~/.pi/agent/snapcompact.key`, honouring `PI_CODING_AGENT_DIR`), not in the
 * session directory. An archive that does not verify is not replayed; the
 * model sees only pi's own compaction summary string for that entry.
 *
 * The key is 32 random bytes, hex-encoded, created with mode 0600 on first
 * use. Syncing the whole agent directory between machines carries the key
 * along; syncing only `sessions/` does not, and those archives will fail
 * verification until the next compaction re-signs them on the new machine.
 * `PI_SNAPCOMPACT_VERIFY=off` skips verification for users who accept that
 * risk; signing still happens so re-enabling later works without churn.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEY_FILE = "snapcompact.key";
const KEY_BYTES = 32;
const KEY_HEX_RE = /^[0-9a-f]{64}$/;

/** pi's agent config directory. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

/** True when the user has opted out of archive verification. */
export function verificationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_SNAPCOMPACT_VERIFY;
	return v !== undefined && /^(0|false|off|no)$/i.test(v);
}

/**
 * Load the signing key from `dir`, creating it (0600) when absent. Returns
 * undefined when the key can neither be read nor created — callers must then
 * fail closed (sign nothing, verify nothing, replay nothing).
 */
export function loadOrCreateKey(dir: string = agentDir()): Uint8Array | undefined {
	const path = join(dir, KEY_FILE);
	try {
		const hex = readFileSync(path, "utf8").trim();
		if (KEY_HEX_RE.test(hex)) return Buffer.from(hex, "hex");
	} catch {
		// fall through to create
	}
	try {
		mkdirSync(dir, { recursive: true });
		const key = randomBytes(KEY_BYTES);
		writeFileSync(path, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
		return key;
	} catch {
		// Lost a creation race or the directory is read-only: re-read once.
		try {
			const hex = readFileSync(path, "utf8").trim();
			if (KEY_HEX_RE.test(hex)) return Buffer.from(hex, "hex");
		} catch {
			// unreadable
		}
		return undefined;
	}
}
