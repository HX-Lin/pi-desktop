import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-archive-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

async function bundle(name) {
  const output = path.join(root, ".artifacts", "test-modules", `${name}-${process.pid}.mjs`);
  mkdirSync(path.dirname(output), { recursive: true });
  await build({
    entryPoints: [path.join(import.meta.dirname, `${name}.ts`)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  return import(`${pathToFileURL(output).href}?v=${Date.now()}`);
}

const { MEMORY_ARCHIVE_MAX_BYTES, listMemoryArchives, memoryArchiveDir } = await bundle("memory-store");
const { archiveSessionEntries, sweepArchives } = await bundle("memory-archive");

const entry = (index, size = 16) => ({ type: "message", id: `m${index}`, text: "x".repeat(size) });

test("archived history round-trips as JSONL with a self-describing header", () => {
  const sessionId = "session-archive";
  const entries = [entry(1), entry(2)];

  const archived = archiveSessionEntries(entries, {
    sessionId,
    reason: "memory-compaction",
    memoryChars: 1234,
    now: Date.UTC(2026, 8, 12, 10, 30, 0),
  });

  assert.ok(archived);
  assert.equal(archived.entries, 2);
  assert.equal(archived.bytes > 0, true);
  assert.equal(archived.path.endsWith("2026-09-12T10-30-00-000Z.jsonl"), true);

  const lines = readFileSync(archived.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "pi-desktop-archive");
  assert.equal(header.sessionId, sessionId);
  assert.equal(header.memoryChars, 1234);
  assert.deepEqual(
    lines.slice(1).map((line) => JSON.parse(line)),
    entries,
  );

  const summary = listMemoryArchives(sessionId);
  assert.equal(summary.files, 1);
  assert.equal(summary.bytes, archived.bytes);
  assert.equal(summary.oldest, "2026-09-12");
  assert.equal(summary.newest, "2026-09-12");
});

test("two archives in the same millisecond never collide", () => {
  const sessionId = "session-collide";
  const now = Date.UTC(2026, 8, 12, 11, 0, 0);
  const first = archiveSessionEntries([entry(1)], { sessionId, reason: "a", memoryChars: 1, now });
  const second = archiveSessionEntries([entry(2)], { sessionId, reason: "b", memoryChars: 1, now });

  assert.ok(first && second);
  assert.notEqual(first.path, second.path);
  assert.equal(listMemoryArchives(sessionId).files, 2);
});

test("nothing to archive returns null instead of an empty file", () => {
  assert.equal(archiveSessionEntries([], { sessionId: "session-empty", reason: "x", memoryChars: 0 }), null);
  assert.equal(listMemoryArchives("session-empty").files, 0);
});

test("the retention sweep drops the oldest files once over budget", () => {
  const sessionId = "session-sweep";
  const dir = memoryArchiveDir(sessionId);
  mkdirSync(dir, { recursive: true });
  // Two files that together exceed the budget, plus an older one to lose first.
  const big = Math.ceil(MEMORY_ARCHIVE_MAX_BYTES / 2) + 1024;
  for (const [name, size] of [
    ["2026-01-01T00-00-00-000Z.jsonl", big],
    ["2026-02-01T00-00-00-000Z.jsonl", big],
  ]) {
    writeFileSync(path.join(dir, name), "x".repeat(size), "utf8");
  }

  const dropped = sweepArchives(dir);

  assert.equal(dropped, 1);
  const remaining = readdirSync(dir);
  assert.deepEqual(remaining, ["2026-02-01T00-00-00-000Z.jsonl"]);
});
