import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AUTO_COMPACT_TURN_THRESHOLD } from "../shared/auto-compact.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const agentDir = mkdtempSync(path.join(tmpdir(), "pi-host-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `host-settings-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "host-settings.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { readHostSettings, writeHostSettings } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const settingsFile = path.join(agentDir, "pi-desktop-settings.json");

test.afterEach(() => rmSync(settingsFile, { force: true }));

test("defaults to the built-in threshold when no settings file exists", () => {
  assert.deepEqual(readHostSettings(), { autoCompactTurns: AUTO_COMPACT_TURN_THRESHOLD });
});

test("persists the threshold so it survives a Host restart", () => {
  assert.deepEqual(writeHostSettings({ autoCompactTurns: 20 }), { autoCompactTurns: 20 });
  assert.deepEqual(readHostSettings(), { autoCompactTurns: 20 });
});

test("clamps out-of-range and invalid values", () => {
  assert.equal(writeHostSettings({ autoCompactTurns: 0 }).autoCompactTurns, 5);
  assert.equal(writeHostSettings({ autoCompactTurns: 100_000 }).autoCompactTurns, 200);
  assert.equal(writeHostSettings({ autoCompactTurns: 12.6 }).autoCompactTurns, 13);

  writeFileSync(settingsFile, JSON.stringify({ autoCompactTurns: "nonsense" }), "utf8");
  assert.deepEqual(readHostSettings(), { autoCompactTurns: AUTO_COMPACT_TURN_THRESHOLD });

  writeFileSync(settingsFile, "{ not json", "utf8");
  assert.deepEqual(readHostSettings(), { autoCompactTurns: AUTO_COMPACT_TURN_THRESHOLD });
});

test("a partial update keeps the stored threshold", () => {
  writeHostSettings({ autoCompactTurns: 33 });
  assert.deepEqual(writeHostSettings({}), { autoCompactTurns: 33 });
});
