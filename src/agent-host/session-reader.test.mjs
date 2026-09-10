import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../.artifacts/test-modules", `session-reader-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: 'export { buildSessionContext } from "./session-reader.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "session-reader-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { buildSessionContext } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const timestamp = "2026-07-15T12:00:00.000Z";

test("hidden channel markers annotate UI user messages without entering displayed history", () => {
  const entries = [
    {
      type: "custom",
      id: "source",
      parentId: null,
      timestamp,
      customType: "pi-desktop-channel-source",
      data: { channel: "telegram", runId: "run-one" },
    },
    {
      type: "message",
      id: "user",
      parentId: "source",
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, "telegram");
  assert.deepEqual(context.messages[0].content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(context.entryIds, ["user"]);
});

test("cancelled channel markers do not color a later local message", () => {
  const entries = [
    {
      type: "custom",
      id: "source",
      parentId: null,
      timestamp,
      customType: "pi-desktop-channel-source",
      data: { channel: "weixin", runId: "run-one" },
    },
    {
      type: "custom",
      id: "cancel",
      parentId: "source",
      timestamp,
      customType: "pi-desktop-channel-source-cancelled",
      data: { runId: "run-one" },
    },
    {
      type: "message",
      id: "user",
      parentId: "cancel",
      timestamp,
      message: { role: "user", content: "local" },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, undefined);
});

test("legacy external prompt wrappers are hidden in UI and still recover the source", () => {
  const entries = [
    {
      type: "message",
      id: "legacy",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "[外部消息来源：飞书 / Lark]\n发送者标识：123\n---\n用户实际输入",
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].channelSource, "feishu");
  assert.equal(context.messages[0].content[0].text, "用户实际输入");
  assert.equal(context.messages[0].content[1].type, "image");
});

test("internal attachment context is omitted from UI history", () => {
  const entries = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp,
      message: { role: "user", content: "inspect this file" },
    },
    {
      type: "custom_message",
      id: "attachment",
      parentId: "user",
      timestamp,
      customType: "pi-desktop-channel-attachment-context",
      content: "Attachment at /private/path",
      display: false,
    },
  ];

  const context = buildSessionContext(entries);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
});

test("limit truncates to the most recent messages and reports totals", () => {
  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "one" },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "two" }] },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp,
      message: { role: "user", content: "three" },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "four" }] },
    },
  ];

  const full = buildSessionContext(entries);
  assert.equal(full.messages.length, 4);
  assert.equal(full.totalMessageCount, 4);
  assert.equal(full.truncated, false);

  const limited = buildSessionContext(entries, undefined, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.totalMessageCount, 4);
  assert.equal(limited.messages.length, 2);
  assert.equal(limited.messages[0].content, "three");
  assert.equal(limited.messages[1].content[0].text, "four");
  assert.equal(limited.entryIds.length, 2);
  assert.equal(limited.entryIds[1], "m4");

  const bigEnough = buildSessionContext(entries, undefined, 10);
  assert.equal(bigEnough.truncated, false);
  assert.equal(bigEnough.messages.length, 4);
});

test("history before the latest compaction is replaced by the memory summary", () => {
  const compactionEntry = {
    type: "compaction",
    id: "c1",
    parentId: "a2",
    timestamp,
    summary: "memory of the old turns",
    firstKeptEntryId: "u2",
  };
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "old question" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    },
    { type: "message", id: "u2", parentId: "a1", timestamp, message: { role: "user", content: "kept question" } },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "kept answer" }] },
    },
    compactionEntry,
    { type: "message", id: "u3", parentId: "c1", timestamp, message: { role: "user", content: "new question" } },
    {
      type: "message",
      id: "a3",
      parentId: "u3",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "new answer" }] },
    },
  ];

  const context = buildSessionContext(entries);
  // Older turns are gone; the summary is returned separately so the UI can pin it.
  assert.deepEqual(context.entryIds, ["u2", "a2", "u3", "a3"]);
  assert.equal(context.totalMessageCount, 4);
  assert.equal(context.truncated, false);
  assert.equal(context.memory.length, 1);
  assert.equal(context.memory[0].customType, "compaction");
  assert.equal(context.memory[0].content, "memory of the old turns");

  // Pagination never reaches behind the compaction boundary either.
  const limited = buildSessionContext(entries, undefined, 2);
  assert.equal(limited.totalMessageCount, 4);
  assert.deepEqual(limited.entryIds, ["u3", "a3"]);
  assert.equal(limited.truncated, true);
  assert.equal(limited.memory.length, 1);
});

test("a session without compaction still renders its full history", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "one" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "two" }] },
    },
  ];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["u1", "a1"]);
  assert.equal(context.totalMessageCount, 2);
  assert.equal(context.memory.length, 0);
});
