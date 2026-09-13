import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `context-fold-extension-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

// One bundle for the adapter and the extension, so they share the same session
// registry (two bundles would each hold their own Map).
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'export { CONTEXT_FOLD_EXTENSION } from "./src/agent-host/context-fold-extension";',
      'export { applyFoldCommand, dropFoldSession, getFoldSession } from "./src/agent-host/context-fold";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "context-fold-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { CONTEXT_FOLD_EXTENSION, applyFoldCommand, dropFoldSession, getFoldSession } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);
process.once("exit", () => rmSync(output, { force: true }));

const SESSION_ID = "fold-ext-session";

/** Wire the extension the way pi does and capture what it registers. */
function mount() {
  const handlers = new Map();
  const tools = new Map();
  CONTEXT_FOLD_EXTENSION.factory({
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
  });
  return { handlers, tools };
}

const ctx = {
  sessionManager: { getSessionId: () => SESSION_ID },
  model: { contextWindow: 200_000 },
  getSystemPrompt: () => "system prompt",
};

function messages() {
  return [
    { role: "user", content: "read the config", timestamp: 1000 },
    {
      role: "assistant",
      responseId: "r1",
      timestamp: 1001,
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "big ".repeat(600) }],
    },
    { role: "user", content: "next", timestamp: 1002 },
    { role: "assistant", responseId: "r2", timestamp: 1003, content: [{ type: "text", text: "tail ".repeat(400) }] },
  ];
}

test("the extension registers a context hook and both agent tools", () => {
  const { handlers, tools } = mount();
  assert.deepEqual([...handlers.keys()], ["context"]);
  assert.deepEqual([...tools.keys()], ["unfold", "recall"]);
  assert.equal(typeof tools.get("unfold").execute, "function");
});

test("messages pass through untouched until folding is armed", () => {
  const { handlers } = mount();
  dropFoldSession(SESSION_ID);
  assert.equal(handlers.get("context")({ messages: messages() }, ctx), undefined);
});

test("folding is armed per session and the wire carries a recoverable digest", async () => {
  const { handlers, tools } = mount();
  dropFoldSession(SESSION_ID);
  // The hook itself populates the map (this is what runs on every model call).
  handlers.get("context")({ messages: messages() }, ctx);
  getFoldSession(SESSION_ID).observe(messages(), { contextWindow: 200_000, protectTokens: 100 });

  const target = getFoldSession(SESSION_ID)
    .snapshot()
    .blocks.find((block) => block.kind === "tool_result");
  const armed = applyFoldCommand(SESSION_ID, { action: "folding", enabled: true });
  assert.equal(armed.snapshot.folding, true);
  const folded = applyFoldCommand(SESSION_ID, { action: "fold", ids: [target.id] });
  assert.equal(folded.applied, 1);

  const wire = handlers.get("context")({ messages: messages() }, ctx);
  assert.ok(wire?.messages, "expected a folded wire");
  const wireResult = wire.messages.find((message) => message.role === "toolResult");
  const wireText = wireResult.content.map((part) => part.text).join("");
  const code = /\{#([0-9a-z]+) FOLDED\}/.exec(wireText)?.[1];
  assert.ok(code, `no fold tag in ${wireText.slice(0, 80)}`);
  // The digest keeps a peek at the content but not the body: the wire is smaller.
  assert.ok(!wireText.includes("big ".repeat(50)), "original content should be replaced on the wire");
  assert.ok(wireText.length < "big ".repeat(600).length / 4);

  const recalled = await tools.get("recall").execute("call-1", { codes: [code] }, undefined, undefined, ctx);
  assert.match(recalled.content[0].text, /big big big/);

  const unfolded = await tools.get("unfold").execute("call-2", { codes: [code] }, undefined, undefined, ctx);
  assert.match(unfolded.content[0].text, /Unfolded 1 block/);

  const noCodes = await tools.get("unfold").execute("call-3", { codes: [] }, undefined, undefined, ctx);
  assert.match(noCodes.content[0].text, /No fold codes/);
});
