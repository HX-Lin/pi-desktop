import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-session-prune-"));
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `session-prune-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "session-prune.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { pruneSummarizedEntries, readSessionFileEntries, writeSessionFileEntries } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

function message(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-15T12:00:00.000Z",
    message: { role: "user", content: text },
  };
}

test("pruning keeps the memory plus the turns it still covers", () => {
  const entries = [
    message("u1", null, "summarized question"),
    message("a1", "u1", "summarized answer"),
    message("u2", "a1", "kept question"),
    message("a2", "u2", "kept answer"),
    {
      type: "compaction",
      id: "c1",
      parentId: "a2",
      timestamp: "2026-07-15T12:00:01.000Z",
      summary: "## Goal\nMemory of the summarized turns",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    message("u3", "c1", "new question"),
  ];

  const { entries: kept, removed } = pruneSummarizedEntries(entries);

  assert.equal(removed, 2);
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["c1", "u2", "a2", "u3"],
  );
  // The retained path is re-rooted at the memory entry so it stays a valid tree.
  assert.equal(kept[0].parentId, null);
  assert.equal(kept[1].parentId, "c1");
  assert.equal(kept[2].parentId, "u2");
  assert.equal(kept[3].parentId, "a2");
  assert.equal(kept[0].summary, "## Goal\nMemory of the summarized turns");
});

test("pruning rewrites the memory through the supplied transform", () => {
  const entries = [
    message("u1", null, "old"),
    {
      type: "compaction",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-07-15T12:00:01.000Z",
      summary: "full memory",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const { entries: kept } = pruneSummarizedEntries(entries, (memory) => `${memory} (capped)`);

  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["c1", "u1"],
  );
  assert.equal(kept[0].summary, "full memory (capped)");
  assert.equal(kept[0].firstKeptEntryId, "u1");
});

test("a session without compaction is left untouched", () => {
  const entries = [message("u1", null, "one"), message("a1", "u1", "two")];
  const { entries: kept, removed } = pruneSummarizedEntries(entries);

  assert.equal(removed, 0);
  assert.equal(kept, entries);
});

test("old memory entries are dropped when a newer summary exists", () => {
  const entries = [
    message("u1", null, "first"),
    {
      type: "compaction",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-07-15T12:00:01.000Z",
      summary: "first memory",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
    message("u2", "c1", "second"),
    {
      type: "compaction",
      id: "c2",
      parentId: "u2",
      timestamp: "2026-07-15T12:00:02.000Z",
      summary: "second memory",
      firstKeptEntryId: "u2",
      tokensBefore: 20,
    },
    message("u3", "c2", "third"),
  ];

  const { entries: kept } = pruneSummarizedEntries(entries);

  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["c2", "u2", "u3"],
  );
  assert.equal(kept[0].summary, "second memory");
});

test("a pruned session file round-trips through disk", () => {
  const filePath = path.join(fixtureRoot, "session.jsonl");
  const header = { type: "session", version: 3, id: "session-1", timestamp: "2026-07-15T12:00:00.000Z", cwd: "/tmp" };
  const entries = [
    message("u1", null, "old"),
    message("a1", "u1", "old answer"),
    {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-07-15T12:00:01.000Z",
      summary: "memory",
      firstKeptEntryId: "a1",
      tokensBefore: 5,
    },
    message("u2", "c1", "new"),
  ];
  writeFileSync(filePath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const read = readSessionFileEntries(filePath);
  assert.equal(read.header?.id, "session-1");
  assert.equal(read.entries.length, 4);

  const { entries: kept } = pruneSummarizedEntries(read.entries);
  writeSessionFileEntries(filePath, read.header, kept);

  const reread = readSessionFileEntries(filePath);
  assert.deepEqual(
    reread.entries.map((entry) => entry.id),
    ["c1", "a1", "u2"],
  );
  assert.equal(reread.header?.id, "session-1");
  assert.equal(readFileSync(filePath, "utf8").trim().split("\n").length, 4);
});
