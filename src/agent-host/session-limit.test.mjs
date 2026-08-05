import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = "/home/lin/data/workspace/pi-desktop";
const isolated = mkdtempSync(path.join(tmpdir(), "pi-limit-"));
process.env.PI_CODING_AGENT_DIR = isolated;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolated, "sessions");
process.env.PI_OFFLINE = "1";

const out = path.join(root, ".artifacts", `session-limit-${process.pid}.mjs`);
mkdirSync(path.dirname(out), { recursive: true });
await build({
  stdin: {
    contents: 'export { buildSessionContext } from "./src/agent-host/session-reader.ts";',
    resolveDir: root,
    loader: "ts",
  },
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { buildSessionContext } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

const ts = "2026-08-05T12:00:00.000Z";
const entries = [];
for (let i = 0; i < 120; i++) {
  entries.push({
    type: "message",
    id: `m${i}`,
    parentId: i === 0 ? null : `m${i - 1}`,
    timestamp: ts,
    message: {
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `user msg ${i}` : [{ type: "text", text: `assistant msg ${i}` }],
    },
  });
}

const full = buildSessionContext(entries);
console.log("FULL:", full.messages.length, "total:", full.totalMessageCount, "truncated:", full.truncated);
assert.equal(full.messages.length, 120);
assert.equal(full.truncated, false);

const limited = buildSessionContext(entries, undefined, 50);
console.log("LIMIT50:", limited.messages.length, "total:", limited.totalMessageCount, "truncated:", limited.truncated);
assert.equal(limited.messages.length, 50);
assert.equal(limited.truncated, true);
assert.equal(limited.totalMessageCount, 120);
assert.equal(limited.messages[0].content, "user msg 70"); // 第 70 条是截断后第一条
console.log("PASS: limit truncation works end-to-end");
rmSync(isolated, { recursive: true, force: true });
