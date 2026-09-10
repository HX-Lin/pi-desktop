import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-store-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-store-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-store.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const {
  PRIMARY_MEMORY_MAX_BYTES,
  SECONDARY_MEMORY_MAX_BYTES,
  listMemoryScripts,
  memoryScriptIndex,
  memoryScriptsDir,
  readPrimaryMemory,
  readSecondaryMemory,
  syncSessionMemory,
} = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function writeScript(sessionId, name, content) {
  mkdirSync(memoryScriptsDir(sessionId), { recursive: true });
  writeFileSync(`${memoryScriptsDir(sessionId)}/${name}`, content, "utf8");
}

function section(label, bytes) {
  return `## ${label}\n${"x".repeat(bytes)}\n\n`;
}

test("memory within the primary cap stays whole in the primary file", () => {
  const memory = "## Goal\nShip the memory tiers.\n\n## Next Steps\n1. Keep going.\n";
  const result = syncSessionMemory("session-small", memory);

  assert.equal(result.spilled, false);
  assert.equal(result.primary, memory);
  assert.equal(readPrimaryMemory("session-small"), memory);
  assert.equal(readSecondaryMemory("session-small"), "");
  assert.equal(result.primaryBytes, Buffer.byteLength(result.primary, "utf8"));
});

test("memory beyond the primary cap retires the oldest sections into the archive", () => {
  const oldest = section("Oldest", 1024 * 1024);
  const middle = section("Middle", 1024 * 1024);
  const newest = section("Newest", 1024 * 1024);
  const memory = `${oldest}${middle}${newest}`;

  const result = syncSessionMemory("session-large", memory);

  assert.equal(result.spilled, true);
  assert.ok(result.primaryBytes <= PRIMARY_MEMORY_MAX_BYTES);
  assert.ok(result.primary.includes("## Newest"));
  assert.equal(readPrimaryMemory("session-large"), result.primary);

  const archive = readSecondaryMemory("session-large");
  assert.ok(archive.includes("## Oldest"));
  assert.ok(Buffer.byteLength(archive, "utf8") <= SECONDARY_MEMORY_MAX_BYTES);
});

test("the secondary archive drops its oldest content beyond its own cap", () => {
  const chunk = section("Batch", 8 * 1024 * 1024);
  const marker = "## Recent\nlatest retired memory\n\n";
  for (let index = 0; index < 7; index += 1) {
    syncSessionMemory("session-archive", `${marker}${chunk}`);
  }

  const archive = readSecondaryMemory("session-archive");
  assert.ok(Buffer.byteLength(archive, "utf8") <= SECONDARY_MEMORY_MAX_BYTES);
  // The archive keeps the most recent retired memory, not the first batch.
  assert.ok(archive.includes("## Recent"));
});

test("the script index describes every script", () => {
  const sessionId = "session-scripts";

  writeScript(sessionId, "deploy.sh", "#!/usr/bin/env bash\n# description: 构建并部署到 staging\necho deploy\n");
  writeScript(sessionId, "fix-perms.sh", "#!/usr/bin/env bash\n# 修复 niri 下 socket 权限\necho fix\n");

  const scripts = listMemoryScripts(sessionId);
  assert.deepEqual(
    scripts.map((script) => script.name),
    ["deploy.sh", "fix-perms.sh"],
  );
  assert.equal(scripts[0].description, "构建并部署到 staging");
  assert.equal(scripts[1].description, "修复 niri 下 socket 权限");
  assert.ok(scripts[0].bytes > 0);

  const index = memoryScriptIndex(sessionId);
  assert.ok(index.includes("`deploy.sh` — 构建并部署到 staging"));
  assert.ok(index.includes("`fix-perms.sh` — 修复 niri 下 socket 权限"));
  assert.ok(index.includes(memoryScriptsDir(sessionId)));

  // Removing a script drops it from a freshly rendered index.
  rmSync(`${memoryScriptsDir(sessionId)}/deploy.sh`, { force: true });
  const refreshed = memoryScriptIndex(sessionId);
  assert.ok(!refreshed.includes("deploy.sh"));
  assert.ok(refreshed.includes("fix-perms.sh"));
});

test("scripts are executed by path and never enter the memory text", () => {
  const sessionId = "session-exec";
  writeScript(sessionId, "run-tests.sh", "#!/usr/bin/env bash\n# description: 跑完整测试\nnpm test\n");

  const result = syncSessionMemory(sessionId, "## Goal\nKeep the memory small.\n");

  assert.equal(result.primary, "## Goal\nKeep the memory small.\n");
  assert.ok(!result.primary.includes("run-tests.sh"));
  assert.ok(memoryScriptIndex(sessionId).includes("run-tests.sh"));
});

test("scripts have no size limit and never count against the memory cap", () => {
  const sessionId = "session-big-script";
  writeScript(sessionId, "huge.sh", `#!/usr/bin/env bash\n# description: 很大的脚本\n${"x".repeat(6 * 1024 * 1024)}\n`);

  const memory = "## Goal\nSmall memory.\n";
  const result = syncSessionMemory(sessionId, memory);

  assert.equal(result.spilled, false);
  assert.ok(result.primary.startsWith(memory));
  assert.ok(result.primaryBytes < 4096);
  assert.ok(listMemoryScripts(sessionId)[0].bytes > 6 * 1024 * 1024);
});

test("the index ignores dotfiles and directories", () => {
  const sessionId = "session-hidden";
  writeScript(sessionId, ".hidden.sh", "#!/usr/bin/env bash\n# description: hidden\n");
  mkdirSync(`${memoryScriptsDir(sessionId)}/subdir`, { recursive: true });

  assert.deepEqual(listMemoryScripts(sessionId), []);

  const index = memoryScriptIndex(sessionId);
  assert.ok(index.includes("（暂无脚本）"));
  assert.ok(index.includes(memoryScriptsDir(sessionId)));
});
