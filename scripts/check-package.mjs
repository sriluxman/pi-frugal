import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const lockUrl = new URL("../package-lock.json", import.meta.url);
const lockedPackages = existsSync(lockUrl)
  ? JSON.parse(readFileSync(lockUrl)).packages ?? {}
  : {};

for (const name of hostPackages) {
  assert.equal(manifest.peerDependencies?.[name], "*", `${name} must be a wildcard peer dependency`);
  assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a dependency`);
  assert.equal(manifest.devDependencies?.[name], undefined, `${name} must not be a dev dependency`);
  assert.equal(lockedPackages[`node_modules/${name}`], undefined, `${name} must not be locked locally`);
}

console.log("Package metadata correctly uses host-provided pi dependencies");
