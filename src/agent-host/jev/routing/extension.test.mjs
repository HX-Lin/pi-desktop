import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `jev-routing-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/jev/routing/extension.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { jevRoutingActive, parseModelRef, runRouting } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
process.once("exit", () => rmSync(output, { force: true }));

const routing = (overrides = {}) => ({
  mode: "jev",
  cheap: "openrouter/deepseek-flash:low",
  strong: "openrouter/claude-opus:high",
  cheapThinking: null,
  strongThinking: null,
  easyMax: 0.5,
  hardMin: 1.5,
  minConfidence: 0.6,
  ...overrides,
});

test("a model reference parses provider, model and thinking level", () => {
  assert.deepEqual(parseModelRef("openrouter/deepseek/flash:high"), {
    provider: "openrouter",
    id: "deepseek/flash",
    thinking: "high",
  });
  assert.deepEqual(parseModelRef("anthropic/claude-opus"), { provider: "anthropic", id: "claude-opus" });
  // A colon inside the model id but no thinking suffix is kept as part of the id.
  assert.deepEqual(parseModelRef("ollama/llama3:8b-instruct"), {
    provider: "ollama",
    id: "llama3",
    thinking: "8b-instruct",
  });
  assert.equal(parseModelRef("noslash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
});

test("routing needs the mode, a target and the master switch", () => {
  const settings = (overrides) => ({
    enabled: true,
    routing: routing(overrides),
  });
  assert.equal(jevRoutingActive(settings({})), true);
  assert.equal(jevRoutingActive(settings({ mode: "off" })), false);
  assert.equal(jevRoutingActive(settings({ cheap: null, strong: null })), false);
  assert.equal(jevRoutingActive(settings({ cheap: null })), true);
  assert.equal(jevRoutingActive({ enabled: false, routing: routing() }), false);
});

test("a missing Jev runtime keeps the current model instead of guessing", async () => {
  // No Jev settings file and no key in this environment: routing must stay out
  // of the way rather than switching on an invented difficulty.
  const decision = await runRouting("hello", { enabled: false, routing: routing() });
  assert.equal(decision, null);
});
