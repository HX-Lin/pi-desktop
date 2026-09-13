import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-facts-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-facts-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-facts.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { FACTS_HEADING, FACTS_MAX_BYTES, applyFactAppendix, extractConversationFacts, renderFactAppendix } =
  await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function toolCall(name, args) {
  return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } };
}
function toolResult(toolName, text, isError = false) {
  return {
    type: "message",
    message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] },
  };
}

test("commands and failures are extracted; file bookkeeping is left to pi", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "please fix the build" } },
    // pi records the files a span touched by itself, so these are not repeated.
    toolCall("read", { path: "src/main.ts" }),
    toolCall("edit", { file_path: "src/main.ts", oldText: "a", newText: "b" }),
    toolCall("bash", { command: "npm test\n  --watch" }),
    toolCall("bash", { command: "npm test" }),
    toolCall("bash", { command: "npm run dist" }),
    toolResult("bash", "everything is fine"),
    toolResult("bash", "Error: cannot find module 'x'\n  at foo", true),
    toolResult("bash", "Error: cannot find module 'x'\n  at bar", true),
  ];

  const facts = extractConversationFacts(entries);

  // Duplicate commands collapse and the most recent ones are kept.
  assert.deepEqual(facts.commands, ["npm test", "npm run dist"]);
  assert.deepEqual(facts.errors, ["bash: Error: cannot find module 'x'"]);
  assert.deepEqual(facts.totals, { commands: 2, errors: 1 });
});

test("the rendered appendix is bounded and reports what was left out", () => {
  const entries = [];
  for (let index = 0; index < 40; index += 1) entries.push(toolCall("bash", { command: `run-${index}` }));
  for (let index = 0; index < 20; index += 1) entries.push(toolResult("bash", `failure ${index}`, true));

  const block = renderFactAppendix(extractConversationFacts(entries));

  assert.ok(block.startsWith(FACTS_HEADING));
  assert.ok(block.includes("共 40 条，列最近 20 条"));
  assert.ok(block.includes("共 20 条，列最近 12 条"));
  assert.ok(block.includes("run-39"));
  assert.ok(!block.includes("run-19"));
  assert.ok(Buffer.byteLength(block, "utf8") <= FACTS_MAX_BYTES);
});

test("an empty span produces no section", () => {
  const facts = extractConversationFacts([{ type: "message", message: { role: "assistant", content: [] } }]);
  assert.equal(renderFactAppendix(facts), null);
  assert.equal(applyFactAppendix("## Goal\nkeep me\n", facts), "## Goal\nkeep me");
});

test("the appendix replaces the previous one instead of stacking up", () => {
  const first = applyFactAppendix("## Goal\nship it\n", extractConversationFacts([toolCall("bash", { command: "a" })]));
  const second = applyFactAppendix(first, extractConversationFacts([toolCall("bash", { command: "b" })]));

  assert.equal(second.split(FACTS_HEADING).length - 1, 1);
  assert.ok(second.includes("`b`"));
  assert.ok(!second.includes("`a`"));
  assert.ok(second.startsWith("## Goal\nship it"));
});

test("a long span is clipped on line boundaries, never mid-entry", () => {
  const entries = [];
  for (let index = 0; index < 20; index += 1) {
    entries.push(toolCall("bash", { command: `run-${index} ${"z".repeat(200)}` }));
  }

  const block = renderFactAppendix(extractConversationFacts(entries));

  assert.ok(block.includes("（事实过多，已截断）"));
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- `")) continue;
    assert.ok(trimmed.endsWith("`"), `truncated entry: ${line}`);
  }
});
