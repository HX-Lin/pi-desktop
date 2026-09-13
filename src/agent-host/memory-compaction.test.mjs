import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-compaction-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-compaction-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-compaction.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { MEMORY_PRUNE_MIN_BYTES, MEMORY_PRUNE_MIN_TEXT_CHARS, planMemoryCompaction } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

const memory = `## Goal\nShip the memory pipeline.\n${"detail line\n".repeat(30)}`;
const toolCall = (name, args) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});
/** A span worth removing: `MEMORY_PRUNE_MIN_BYTES` of JSON. */
const bigSpan = () =>
  Array.from({ length: 8 }, (_, index) => toolCall("bash", { command: `step-${index} ${"y".repeat(9000)}` }));
const smallSpan = () => [toolCall("bash", { command: "npm test" })];

test("a worthwhile span is enriched, archived and cleared for deletion", () => {
  const plan = planMemoryCompaction({
    sessionId: "session-plan",
    memory,
    dropped: bigSpan(),
    reason: "memory-compaction",
    now: Date.UTC(2026, 8, 12, 12, 0, 0),
  });

  assert.equal(plan.prune, true);
  assert.equal(plan.skipReason, undefined);
  assert.equal(plan.spanBytes > MEMORY_PRUNE_MIN_BYTES, true);

  // Ground truth from the span is part of the memory...
  assert.ok(plan.memory.includes("## 已沉淀区间的事实（自动抽取）"));
  assert.ok(plan.memory.includes("- 执行命令（共 8 条"));
  // ...and the raw span is on disk, not gone.
  assert.ok(plan.archived);
  const lines = readFileSync(plan.archived.path, "utf8").trim().split("\n");
  assert.equal(lines.length, bigSpan().length + 1);
  assert.equal(plan.archived.entries, bigSpan().length);
});

test("script fences in the summary become executables and a record", () => {
  const plan = planMemoryCompaction({
    sessionId: "session-scripts",
    memory: `${memory}\n\`\`\`script:deploy.sh\n#!/usr/bin/env bash\n# description: 部署到 staging\nnpm run dist\n\`\`\`\n`,
    dropped: bigSpan(),
    reason: "memory-compaction",
  });

  assert.ok(plan.memory.includes("## 已沉淀的记忆脚本"));
  assert.ok(plan.memory.includes("- `deploy.sh` — 部署到 staging"));
  assert.ok(!plan.memory.includes("script:deploy.sh"));
  const script = readFileSync(path.join(fixtureRoot, "memory", "session-scripts", "scripts", "deploy.sh"), "utf8");
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
});

test("a span too small to matter is not deleted", () => {
  const plan = planMemoryCompaction({
    sessionId: "session-small",
    memory,
    dropped: smallSpan(),
    reason: "memory-compaction",
  });

  assert.equal(plan.prune, false);
  assert.equal(plan.skipReason, "span-too-small");
  // The memory file is still brought up to date.
  assert.ok(readFileSync(path.join(fixtureRoot, "memory", "session-small", "primary.md"), "utf8").length > 0);
  // ...but nothing was archived, because nothing was removed.
  assert.throws(() => readdirSync(path.join(fixtureRoot, "memory", "session-small", "archive")));
});

test("a degenerate summary never authorizes deletion", () => {
  const plan = planMemoryCompaction({
    sessionId: "session-empty-memory",
    memory: "ok",
    dropped: bigSpan(),
    reason: "memory-compaction",
  });

  assert.equal(plan.prune, false);
  assert.equal(plan.skipReason, "memory-too-short");
  assert.ok(MEMORY_PRUNE_MIN_TEXT_CHARS > 2);
});

test("memory is capped into the primary file and the plan returns what fits", () => {
  const huge = `## Old\n${"z".repeat(4 * 1024 * 1024)}\n\n## New\nkeep me\n`;
  const plan = planMemoryCompaction({
    sessionId: "session-cap",
    memory: huge,
    dropped: bigSpan(),
    reason: "memory-compaction",
  });

  assert.ok(plan.memory.includes("keep me"));
  assert.ok(!plan.memory.includes("## Old"));
  assert.equal(readFileSync(path.join(fixtureRoot, "memory", "session-cap", "primary.md"), "utf8"), plan.memory);
});

test("an unwritable archive directory blocks deletion instead of losing history", () => {
  const sessionId = "session-readonly";
  const archiveDir = path.join(fixtureRoot, "memory", sessionId, "archive");
  // A file where the directory should be makes archiving fail.
  mkdirSync(path.dirname(archiveDir), { recursive: true });
  writeFileSync(archiveDir, "not a directory", "utf8");

  const plan = planMemoryCompaction({ sessionId, memory, dropped: bigSpan(), reason: "memory-compaction" });

  assert.equal(plan.prune, false);
  assert.equal(plan.skipReason, "archive-failed");
  rmSync(archiveDir, { force: true });
});

test("a large memory alone does not authorize deleting history", () => {
  // Only bookkeeping entries would be dropped: the memory is big, the span is not.
  const plan = planMemoryCompaction({
    sessionId: "session-bookkeeping",
    memory: "# memory line\n".repeat(2000),
    dropped: [{ type: "compaction", id: "c1", summary: "x".repeat(200000) }],
    reason: "memory-compaction",
  });

  assert.equal(plan.prune, false);
  assert.equal(plan.skipReason, "span-too-small");
});
