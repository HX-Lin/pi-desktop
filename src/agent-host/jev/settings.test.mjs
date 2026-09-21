import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const agentDir = mkdtempSync(path.join(tmpdir(), "pi-jev-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `jev-settings-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/jev/settings.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const {
  defaultJevSettings,
  jevFeatureEnabled,
  normalizeJevSettings,
  readJevSettings,
  resolveJevEndpoint,
  writeJevSettings,
} = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const settingsFile = path.join(agentDir, "pi-desktop-jev.json");

test("defaults are inert: nothing calls Jev until it is switched on", () => {
  const defaults = readJevSettings();
  assert.deepEqual(defaults, defaultJevSettings());
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.gate.enabled, false);
  assert.equal(defaults.compaction.enabled, false);
  assert.equal(defaults.routing.mode, "off");
  assert.equal(jevFeatureEnabled(defaults), false);
});

test("the gate thresholds keep a middle band and the gate stays fail-closed", () => {
  const settings = normalizeJevSettings({
    enabled: true,
    gate: {
      enabled: true,
      uncertain: "whatever",
      timeoutMs: 10,
      maxRetries: 99,
      // 0.5 closes the band, > 1 is impossible: both are dropped.
      thresholds: { intent_coverage: 0.7, broken: 0.5, tooBig: 1.4, nan: "x" },
    },
  });

  assert.equal(settings.gate.uncertain, "deny");
  assert.equal(settings.gate.timeoutMs, 500);
  assert.equal(settings.gate.maxRetries, 5);
  assert.deepEqual(settings.gate.thresholds, { intent_coverage: 0.7 });
  assert.equal(jevFeatureEnabled(settings), true);
});

test("unknown channels fall back to the default and a bad file is survivable", () => {
  assert.equal(normalizeJevSettings({ channel: "nope" }).channel, "typesafe");
  assert.equal(normalizeJevSettings({ channel: "vercel" }).channel, "vercel");

  writeFileSync(settingsFile, "{ not json", "utf8");
  assert.deepEqual(readJevSettings(), defaultJevSettings());
});

test("writes persist, merge and resolve to an endpoint", () => {
  const written = writeJevSettings({ channel: "vercel", enabled: true });
  assert.equal(written.channel, "vercel");
  assert.equal(written.enabled, true);

  const roundTripped = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(roundTripped.channel, "vercel");
  // Untouched sections survive a partial write.
  assert.equal(roundTripped.gate.uncertain, "deny");

  const partial = writeJevSettings({ gate: { enabled: true, scope: "matched", uncertain: "ask", timeoutMs: 8000 } });
  assert.equal(partial.channel, "vercel");
  assert.equal(partial.gate.scope, "matched");
  assert.equal(partial.gate.uncertain, "ask");

  const endpoint = resolveJevEndpoint(partial);
  assert.equal(endpoint.channel.id, "vercel");
  assert.equal(endpoint.channel.protocol, "chat");
  assert.equal(endpoint.baseUrl, "https://ai-gateway.vercel.sh/v1/chat/completions");
  // The effective model comes from the channel definition; the value itself is
  // checked against the live catalog by `check-jev-slugs.sh`, because a wrong
  // slug is not caught until the user runs Test.
  assert.equal(endpoint.model, endpoint.channel.model);
  assert.match(endpoint.channel.model, /^[a-z0-9-]+\/[a-z0-9.-]+$/);

  // An explicit override wins over the channel default.
  const overridden = resolveJevEndpoint(writeJevSettings({ model: "custom/jev", baseUrl: "https://x/y" }));
  assert.equal(overridden.model, "custom/jev");
  assert.equal(overridden.baseUrl, "https://x/y");

  // Clearing the override must give the channel default back: without this the
  // only way out of a hand-typed slug was to edit the settings file.
  const cleared = resolveJevEndpoint(writeJevSettings({ model: null, baseUrl: null }));
  assert.equal(cleared.model, cleared.channel.model);
  assert.equal(cleared.baseUrl, cleared.channel.baseUrl);
});
