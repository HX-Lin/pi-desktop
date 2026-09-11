import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-memory-prompt-"));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const output = path.join(root, ".artifacts", "test-modules", `memory-prompt-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, "memory-prompt.ts")],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { MEMORY_DISTILLATION_PROMPT, sedimentMemoryScripts } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

const scriptsDir = (sessionId) => path.join(fixtureRoot, "memory", sessionId, "scripts");

test("the distillation prompt asks for durable memory and returns scripts", () => {
  // The prompt is the contract for the fences the parser reads back.
  assert.ok(MEMORY_DISTILLATION_PROMPT.includes("```script:"));
  assert.ok(MEMORY_DISTILLATION_PROMPT.includes("# description:"));
  for (const requirement of ["约束与偏好", "环境事实", "关键决策", "踩过的坑", "可复用脚本"]) {
    assert.ok(MEMORY_DISTILLATION_PROMPT.includes(requirement), `missing ${requirement}`);
  }
});

test("script fences become executable files and leave a readable record", () => {
  const sessionId = "session-sediment";
  const memory = [
    "## Goal",
    "支持压缩为记忆。",
    "",
    "## Critical Context",
    "构建用 npm run dist。",
    "",
    "```script:build-appimage.sh",
    "#!/usr/bin/env bash",
    "# description: 构建并产出 Linux AppImage",
    "set -euo pipefail",
    "npm run dist",
    "```",
    "",
    "```script:reset-niri.sh",
    "#!/usr/bin/env bash",
    "# description: 重启 niri 下卡死的 pi-desktop",
    "pkill -f pi-agent-desktop || true",
    "```",
    "",
  ].join("\n");

  const result = sedimentMemoryScripts(sessionId, memory);

  // The bodies are gone from the memory, replaced by a one-line record.
  assert.ok(!result.includes("```"));
  assert.ok(!result.includes("set -euo pipefail"));
  assert.ok(result.includes("## 已沉淀的记忆脚本"));
  assert.ok(result.includes("- `build-appimage.sh` — 构建并产出 Linux AppImage"));
  assert.ok(result.includes("- `reset-niri.sh` — 重启 niri 下卡死的 pi-desktop"));
  assert.ok(result.includes("## Critical Context"));

  const written = readFileSync(path.join(scriptsDir(sessionId), "build-appimage.sh"), "utf8");
  assert.ok(written.startsWith("#!/usr/bin/env bash"));
  assert.ok(written.includes("npm run dist"));
  assert.ok((statSync(path.join(scriptsDir(sessionId), "build-appimage.sh")).mode & 0o111) !== 0, "not executable");
});

test("re-sedimenting replaces the record instead of stacking it up", () => {
  const sessionId = "session-repeat";
  const memory = "## Goal\nShip it.\n\n```script:once.sh\n#!/bin/sh\n# description: 只做一件事\n ```\n";
  const first = sedimentMemoryScripts(sessionId, memory);
  const second = sedimentMemoryScripts(sessionId, first);

  assert.equal(second.split("## 已沉淀的记忆脚本").length - 1, 1);
  assert.equal(second.split("once.sh").length - 1, 1); // exactly one record line
});

test("memory without script fences is returned untouched", () => {
  const memory = "## Goal\nNothing to sediment here.\n";
  assert.equal(sedimentMemoryScripts("session-plain", memory), memory);
});

test("unsafe script names are never written outside the session directory", () => {
  const sessionId = "session-unsafe";
  const memory = [
    "## Goal",
    "",
    "```script:../../escape.sh",
    "#!/bin/sh",
    "# description: escape attempt",
    "echo pwned",
    "```",
    "",
    "```script:.hidden.sh",
    "#!/bin/sh",
    "# description: hidden",
    "echo hidden",
    "```",
    "",
  ].join("\n");

  const result = sedimentMemoryScripts(sessionId, memory);

  assert.ok(!result.includes("已沉淀"));
  assert.throws(() => readFileSync(path.join(fixtureRoot, "escape.sh"), "utf8"));
  assert.throws(() => readFileSync(path.join(scriptsDir(sessionId), ".hidden.sh"), "utf8"));
});
