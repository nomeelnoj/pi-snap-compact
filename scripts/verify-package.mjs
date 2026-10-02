// Verify the published tarball contains exactly the declared files, carries
// only the single declared runtime dependency, and runs no install lifecycle
// scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

// Identity must agree between the manifest and its lockfile.
assert.equal(lock.name, pkg.name, "package-lock.json name must match package.json");
assert.equal(lock.version, pkg.version, "package-lock.json version must match package.json");

// The only runtime dependency is opentype.js, used to rasterize TrueType
// fallback glyphs (CJK etc.) that the bundled bitmap fonts do not cover.
assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["opentype.js"], "unexpected runtime dependencies");
assert.equal(pkg.optionalDependencies, undefined, "the package must not declare optional dependencies");
for (const hook of ["preinstall", "install", "postinstall"]) {
  assert.equal(pkg.scripts?.[hook], undefined, `the package must not define a ${hook} script`);
}

// Resolve npm portably: Windows cannot spawn the npm shim directly, so route
// through Node with the invoking npm_execpath when one is present.
const npmExec = process.env.npm_execpath;
const [cmd, prefix] = npmExec ? [process.execPath, [npmExec]] : ["npm", []];
const packed = JSON.parse(execFileSync(cmd, [...prefix, "pack", "--dry-run", "--json"], { encoding: "utf8" }));

// npm always ships README.md and LICENSE alongside the declared files list.
const shipped = packed[0].files.map((entry) => entry.path).sort();
const shippedTop = new Set(shipped.map((p) => p.split("/")[0]));
for (const entry of pkg.files) {
  assert.ok(shippedTop.has(entry.replace(/\/$/, "")), `declared files entry missing from tarball: ${entry}`);
}
for (const top of ["package.json", "README.md", "LICENSE"]) {
  assert.ok(shipped.includes(top), `tarball is missing ${top}`);
}
assert.ok(shipped.some((p) => p.startsWith("fonts/") && p.endsWith(".bdf")), "bundled bitmap fonts must ship");
assert.ok(shipped.some((p) => p.endsWith("Silver.ttf")), "Silver TTF fallback must ship");
assert.deepEqual(packed[0].bundled ?? [], [], "the package must not bundle dependencies");

console.log(`verify-package: ${pkg.name}@${pkg.version} ships ${shipped.length} files`);
