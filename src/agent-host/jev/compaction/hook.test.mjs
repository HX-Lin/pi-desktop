import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `jev-compaction-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/jev/compaction/hook.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { isMemoryCompaction, runJevCompaction } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
process.once("exit", () => rmSync(output, { force: true }));

const config = {
  enabled: true,
  keepThreshold: 0.5,
  borderline: 0.1,
  truncateHeadChars: 60,
  minReduction: 0.15,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
};

/** A span with three tool calls; the last one is the split-turn boundary. */
function span() {
  return [
    { role: "user", content: "please inspect the repo" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "running checks" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", content: "file listing ".repeat(40) },
    { role: "user", content: "now the tests" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }],
    },
    { role: "toolResult", toolCallId: "c2", content: "test output ".repeat(40) },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c3", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "toolResult", toolCallId: "c3", content: "source ".repeat(60) },
  ];
}

function input(overrides = {}) {
  return {
    messagesToSummarize: span(),
    turnPrefixMessages: [],
    firstKeptEntryId: "entry-1",
    tokensBefore: 5000,
    ...overrides,
  };
}

/**
 * Answers positionally: question keys carry the short ids the vendored collector
 * assigns (`t1`, `t2`, …) in span order, so index 0 is the first tool call.
 */
function asker(policies, record = []) {
  return {
    async ask(state, questions) {
      record.push({ state, questions });
      const out = {};
      for (const key of Object.keys(questions)) {
        const [kind, id] = key.split("_");
        const policy = policies[Number(id.slice(1)) - 1] ?? {};
        if (kind === "call") out[key] = { noul: policy.keepCall ?? 0.9 };
        else if (kind === "result") out[key] = { noul: policy.keepResult ?? 0.9 };
        else out[key] = { score: policy.staleness ?? 0.1, confidence: 0.9 };
      }
      return { answers: out, model: "fake", usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

test("retained text stays verbatim while obsolete calls and results go", async () => {
  const asked = [];
  const run = await runJevCompaction(
    input(),
    asker(
      [
        { keepCall: 0.1, keepResult: 0.1 },
        { keepCall: 0.9, keepResult: 0.9 },
        { keepCall: 0.2, keepResult: 0.2 },
      ],
      asked,
    ),
    config,
  );

  assert.equal(run.ok, true);
  const summary = run.compaction.summary;
  // User/assistant text is kept verbatim, in pi's transcript style.
  assert.match(summary, /please inspect the repo/);
  assert.match(summary, /running checks/);
  // c1 is dropped entirely; c2 is kept; c3 sits at the boundary, so its call
  // stays and only its result is bounded.
  assert.ok(!summary.includes("ls -la"), "a dropped call should not appear");
  assert.match(summary, /npm test/);
  assert.match(summary, /read/);
  assert.match(summary, /jev-compaction truncated/);
  assert.ok(run.compaction.details.stats.callsDropped >= 1);
  assert.equal(run.compaction.details.engine, "jev");
  // The audit trail is on the compaction entry, and firstKeptEntryId is pi's.
  assert.equal(run.compaction.firstKeptEntryId, "entry-1");
  assert.ok(run.compaction.details.decisions.length >= 3);
  assert.ok(asked.length >= 1, "Jev should have been asked");
});

test("missing answers keep the call instead of dropping it", async () => {
  const silent = {
    async ask() {
      return { answers: {}, model: "fake" };
    },
  };
  const run = await runJevCompaction(input(), silent, config);
  // Nothing was dropped, so the reduction gate rejects it and pi keeps its summary.
  assert.equal(run.ok, false);
  assert.equal(run.reason, "low-reduction");
});

test("an empty span and an insufficient reduction both fall back", async () => {
  const empty = await runJevCompaction(input({ messagesToSummarize: [] }), asker({}), config);
  assert.deepEqual(empty, { ok: false, reason: "empty-span", reduction: 0 });

  // Everything kept: no reduction worth replacing pi's summary with.
  const keepAll = await runJevCompaction(input(), asker({}), config);
  assert.equal(keepAll.ok, false);
  assert.equal(keepAll.reason, "low-reduction");
  assert.ok(keepAll.reduction < config.minReduction);
});

test("a Jev failure surfaces as a throw so the caller falls back", async () => {
  const failing = {
    async ask() {
      throw new Error("Jev unavailable (timeout)");
    },
  };
  await assert.rejects(() => runJevCompaction(input(), failing, config), /Jev unavailable/);
});

test("the memory path is recognised so Jev never takes it over", () => {
  // Our "压缩为记忆" always passes the distillation prompt...
  assert.equal(isMemoryCompaction("这是一次「压缩为记忆」"), true);
  // ...while pi's own context compaction has no instructions.
  assert.equal(isMemoryCompaction(undefined), false);
  assert.equal(isMemoryCompaction(""), false);
  assert.equal(isMemoryCompaction("   "), false);
});
