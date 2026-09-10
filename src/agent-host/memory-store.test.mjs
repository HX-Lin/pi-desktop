import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-store-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-store-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-store.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const {
  PRIMARY_MEMORY_MAX_BYTES,
  SECONDARY_MEMORY_MAX_BYTES,
  readPrimaryMemory,
  readSecondaryMemory,
  syncSessionMemory,
} = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function section(label, bytes) {
  return `## ${label}\n${"x".repeat(bytes)}\n\n`;
}

test("memory within the primary cap stays whole in the primary file", () => {
  const memory = "## Goal\nShip the memory tiers.\n\n## Next Steps\n1. Keep going.\n";
  const result = syncSessionMemory("session-small", memory);

  assert.equal(result.spilled, false);
  assert.equal(result.primary, memory);
  assert.equal(readPrimaryMemory("session-small"), memory);
  assert.equal(readSecondaryMemory("session-small"), "");
  assert.equal(result.primaryBytes, Buffer.byteLength(memory, "utf8"));
});

test("memory beyond the primary cap retires the oldest sections into the archive", () => {
  const oldest = section("Oldest", 1024 * 1024);
  const middle = section("Middle", 1024 * 1024);
  const newest = section("Newest", 1024 * 1024);
  const memory = `${oldest}${middle}${newest}`;

  const result = syncSessionMemory("session-large", memory);

  assert.equal(result.spilled, true);
  assert.ok(result.primaryBytes <= PRIMARY_MEMORY_MAX_BYTES);
  assert.ok(result.primary.includes("## Newest"));
  assert.equal(readPrimaryMemory("session-large"), result.primary);

  const archive = readSecondaryMemory("session-large");
  assert.ok(archive.includes("## Oldest"));
  assert.ok(Buffer.byteLength(archive, "utf8") <= SECONDARY_MEMORY_MAX_BYTES);
});

test("the secondary archive drops its oldest content beyond its own cap", () => {
  const chunk = section("Batch", 8 * 1024 * 1024);
  const marker = "## Recent\nlatest retired memory\n\n";
  for (let index = 0; index < 7; index += 1) {
    syncSessionMemory("session-archive", `${marker}${chunk}`);
  }

  const archive = readSecondaryMemory("session-archive");
  assert.ok(Buffer.byteLength(archive, "utf8") <= SECONDARY_MEMORY_MAX_BYTES);
  // The archive keeps the most recent retired memory, not the first batch.
  assert.ok(archive.includes("## Recent"));
});
