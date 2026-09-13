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
  memoryArchiveNotice,
  memoryDir,
  memoryScriptIndex,
  readMemoryOverview,
  secondaryMemoryPath,
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

test("the archived memory is announced to the model only once it exists", () => {
  assert.equal(memoryArchiveNotice("session-no-archive"), null);

  // Force a spill: one memory text larger than the primary cap can hold.
  const sessionId = "session-archive-notice";
  const oversized = Array.from({ length: 5 }, (_, index) => section(`Batch ${index}`, 1024 * 1024)).join("");
  syncSessionMemory(sessionId, oversized);

  const notice = memoryArchiveNotice(sessionId);
  assert.ok(notice, "expected an archive notice");
  assert.ok(notice.includes(secondaryMemoryPath(sessionId)));
  assert.ok(notice.includes("记忆归档"));
});

test("the overview summarizes every tier without loading whole files", () => {
  const sessionId = "session-overview";

  assert.deepEqual(readMemoryOverview(sessionId), {
    sessionId,
    dir: memoryDir(sessionId),
    exists: false,
    primary: null,
    secondary: null,
    scripts: [],
    archives: [],
    archivesBytes: 0,
  });

  syncSessionMemory(sessionId, "## Goal\nship it\n\n## Next Steps\n1. done\n");
  writeScript(sessionId, "deploy.sh", "#!/usr/bin/env bash\n# description: 部署\n");
  mkdirSync(path.join(memoryDir(sessionId), "archive"), { recursive: true });
  writeFileSync(path.join(memoryDir(sessionId), "archive", "2026-09-13T00-00-00-000Z.jsonl"), "{}\n");

  const overview = readMemoryOverview(sessionId);

  assert.equal(overview.exists, true);
  assert.deepEqual(
    overview.primary.sections.map((section) => section.title),
    ["Goal", "Next Steps"],
  );
  assert.ok(overview.primary.sections[0].bytes > 0);
  assert.ok(overview.primary.sections[0].preview.includes("ship it"));
  assert.equal(overview.primary.tailOnly, false);
  assert.equal(overview.secondary, null);
  assert.deepEqual(overview.scripts, [
    { name: "deploy.sh", description: "部署", bytes: Buffer.byteLength("#!/usr/bin/env bash\n# description: 部署\n") },
  ]);
  assert.equal(overview.archives.length, 1);
  assert.equal(overview.archives[0].name, "2026-09-13T00-00-00-000Z.jsonl");
  assert.equal(overview.archivesBytes > 0, true);
});

test("the overview reports the newest part of a sunk memory, newest archive first", () => {
  const sessionId = "session-overview-tail";
  // One memory text bigger than the primary cap, so the oldest part sinks.
  const oversized = `## Old\n${"x".repeat(4 * 1024 * 1024)}\n\n## Newest\nmost recent\n`;
  syncSessionMemory(sessionId, oversized);

  mkdirSync(path.join(memoryDir(sessionId), "archive"), { recursive: true });
  for (const name of ["2026-08-01T00-00-00-000Z.jsonl", "2026-09-01T00-00-00-000Z.jsonl"]) {
    writeFileSync(path.join(memoryDir(sessionId), "archive", name), "{}\n");
  }

  const overview = readMemoryOverview(sessionId);

  assert.ok(overview.secondary);
  assert.equal(overview.secondary.tailOnly, true);
  assert.equal(overview.secondary.bytes > 1024 * 1024, true);
  // The sunk file is scanned from the tail only, and a slice that lands inside a
  // body simply reports no sections; the newest section stayed in the primary.
  assert.equal(overview.secondary.sections.length <= 30, true);
  assert.ok(overview.primary.sections.some((section) => section.title === "Newest"));
  assert.deepEqual(
    overview.archives.map((file) => file.name),
    ["2026-09-01T00-00-00-000Z.jsonl", "2026-08-01T00-00-00-000Z.jsonl"],
  );
});
