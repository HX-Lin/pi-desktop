import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-scripts-extension-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-scripts-extension-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-scripts-extension.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { MEMORY_SCRIPTS_EXTENSION } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

/** Same layout `memory-store.ts` uses: <agentDir>/memory/<sessionId>/scripts. */
function memoryScriptsDir(sessionId) {
  return path.join(fixtureRoot, "memory", sessionId, "scripts");
}

/** Wire the extension the way pi does and return its before_agent_start handler. */
function captureHandlers() {
  const handlers = {};
  MEMORY_SCRIPTS_EXTENSION.factory({ on: (event, handler) => (handlers[event] = handler) });
  return handlers;
}

const SESSION_ID = "session-extension";

test("the script index is appended to the system prompt for every turn", async () => {
  const handlers = captureHandlers();
  mkdirSync(memoryScriptsDir(SESSION_ID), { recursive: true });
  writeFileSync(
    `${memoryScriptsDir(SESSION_ID)}/deploy.sh`,
    "#!/usr/bin/env bash\n# description: 部署到 staging\n",
    "utf8",
  );

  const result = await handlers.before_agent_start(
    { prompt: "ship it", systemPrompt: "BASE PROMPT" },
    { sessionManager: { getSessionId: () => SESSION_ID } },
  );

  assert.ok(result.systemPrompt.startsWith("BASE PROMPT"));
  assert.ok(result.systemPrompt.includes("`deploy.sh` — 部署到 staging"));
  assert.ok(result.systemPrompt.includes(memoryScriptsDir(SESSION_ID)));
  assert.ok(result.systemPrompt.includes("bash <脚本目录>/<脚本名>"));

  // Each turn appends exactly one fresh index — never a duplicated one.
  const again = await handlers.before_agent_start(
    { prompt: "again", systemPrompt: "BASE PROMPT" },
    { sessionManager: { getSessionId: () => SESSION_ID } },
  );
  assert.equal(again.systemPrompt.match(/deploy\.sh/g).length, 1);
  assert.equal(again.systemPrompt.split("## 可执行记忆脚本").length - 1, 1);
});

test("the index reports an empty directory instead of failing", async () => {
  const handlers = captureHandlers();
  const result = await handlers.before_agent_start(
    { prompt: "hi", systemPrompt: "BASE" },
    { sessionManager: { getSessionId: () => "session-empty" } },
  );

  assert.ok(result.systemPrompt.includes("（暂无脚本）"));
  assert.ok(result.systemPrompt.includes(memoryScriptsDir("session-empty")));
});

test("sessions without an id are left untouched", async () => {
  const handlers = captureHandlers();
  const result = await handlers.before_agent_start(
    { prompt: "hi", systemPrompt: "BASE" },
    { sessionManager: { getSessionId: () => "" } },
  );

  assert.equal(result, undefined);
});

test("the archived memory is pointed at once it exists", async () => {
  const handlers = captureHandlers();
  const sessionId = "session-archived";
  mkdirSync(path.join(fixtureRoot, "memory", sessionId), { recursive: true });
  writeFileSync(path.join(fixtureRoot, "memory", sessionId, "secondary.md"), "## Old memory\nretired\n", "utf8");

  const result = await handlers.before_agent_start(
    { prompt: "hi", systemPrompt: "BASE" },
    { sessionManager: { getSessionId: () => sessionId } },
  );

  assert.ok(result.systemPrompt.includes("记忆归档"));
  assert.ok(result.systemPrompt.includes(path.join(fixtureRoot, "memory", sessionId, "secondary.md")));
});
