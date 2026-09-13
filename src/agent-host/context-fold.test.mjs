import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `context-fold-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/context-fold.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { FoldSession, dropFoldSession, getFoldSession, peekFoldSession } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);
process.once("exit", () => rmSync(output, { force: true }));

/**
 * Two turns, so the first turn's blocks sit outside the protected tail: a user
 * message, a tool call + its (large) result, then a later turn that owns the tail.
 */
function conversation() {
  return [
    { role: "user", content: "please read the config", timestamp: 1000 },
    {
      role: "assistant",
      responseId: "resp-1",
      timestamp: 1001,
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "config.json" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "config ".repeat(600) }],
    },
    {
      role: "user",
      content: "now change the port",
      timestamp: 1002,
    },
    {
      role: "assistant",
      responseId: "resp-2",
      timestamp: 1003,
      content: [{ type: "text", text: "later turn ".repeat(400) }],
    },
  ];
}

function freshSession(name) {
  const session = new FoldSession(name);
  session.observe(conversation(), { contextWindow: 200_000, protectTokens: 100 });
  return session;
}

test("folding is off by default and the wire passes through", () => {
  const session = freshSession("off");
  const snapshot = session.snapshot();

  assert.equal(snapshot.folding, false);
  assert.deepEqual(
    snapshot.blocks.map((block) => block.kind),
    ["user", "tool_call", "tool_result", "user", "text"],
  );
  assert.equal(session.serialize(conversation()), undefined);
});

test("a folded block reaches the wire as a tagged digest and unfolds again", () => {
  const session = freshSession("fold");
  session.folding = true;

  const resultBlock = session.snapshot().blocks.find((block) => block.kind === "tool_result");
  assert.ok(resultBlock);
  const folded = session.apply([{ kind: "fold", ids: [resultBlock.id] }]);

  assert.equal(folded.applied, 1);
  assert.deepEqual(folded.refused, []);
  const after = folded.snapshot.blocks.find((block) => block.id === resultBlock.id);
  assert.equal(after.folded, true);
  assert.match(after.digest, /^\{#[0-9a-z]+ FOLDED\}/);
  assert.ok(after.tokens < after.fullTokens);

  // The wire carries the digest, not the original 4000 characters.
  const wire = session.serialize(conversation());
  const wireResult = wire.find((message) => message.role === "toolResult");
  const wireText = wireResult.content.map((part) => part.text).join("");
  assert.match(wireText, /\{#([0-9a-z]+) FOLDED\}/);
  assert.ok(!wireText.includes("config ".repeat(50)));

  // The tag is the handle the agent uses to pull the content back.
  const code = /\{#([0-9a-z]+) FOLDED\}/.exec(wireText)[1];
  const recalled = session.recallCodes([code]);
  assert.equal(recalled.restored.length, 1);
  assert.ok(recalled.restored[0].text.includes("config ".repeat(50)));
  // recall reads without changing the standing view.
  assert.equal(session.snapshot().blocks.find((block) => block.id === resultBlock.id).folded, true);

  const restored = session.unfoldCodes([code]);
  assert.deepEqual(restored.missing, []);
  assert.equal(session.apply([{ kind: "unfold", ids: [resultBlock.id] }]).applied, 1);
  const openAgain = session.serialize(conversation());
  assert.ok(openAgain.find((message) => message.role === "toolResult").content[0].text.includes("config ".repeat(50)));
});

test("tool calls cannot be folded, and the protected tail refuses human folds", () => {
  const session = freshSession("rules");
  session.folding = true;
  const blocks = session.snapshot().blocks;
  const call = blocks.find((block) => block.kind === "tool_call");
  const assistantText = blocks.find((block) => block.kind === "text");

  // A tool_call is never foldable: folding it would orphan its result.
  assert.equal(call.foldable, false);
  assert.equal(session.apply([{ kind: "fold", ids: [call.id] }]).applied, 0);

  // The newest block sits inside the protected working tail (protectTokens: 100).
  assert.equal(assistantText.protectedBlock, true);
  assert.equal(session.apply([{ kind: "fold", ids: [assistantText.id] }]).applied, 0);
});

test("pins are reported and survive a rebuild", () => {
  const session = freshSession("pin");
  const target = session.snapshot().blocks.find((block) => block.kind === "tool_result");

  assert.equal(session.apply([{ kind: "pin", ids: [target.id] }]).applied, 1);
  assert.equal(session.snapshot().blocks.find((block) => block.id === target.id).pinned, true);

  // pi rewrites the context (compaction/fork): overlays are carried by block id.
  session.observe(conversation(), { contextWindow: 200_000, protectTokens: 100 });
  assert.equal(session.snapshot().blocks.find((block) => block.id === target.id).pinned, true);
});

test("the browser sandbox keeps one engine per session", () => {
  const first = getFoldSession("shared");
  const second = getFoldSession("shared");
  assert.equal(first, second);
  first.observe(conversation(), { contextWindow: 100_000 });
  assert.equal(peekFoldSession("shared").stats.blockCount, 5);
  dropFoldSession("shared");
  assert.equal(peekFoldSession("shared"), null);
  assert.equal(peekFoldSession("never-seen"), null);
});
