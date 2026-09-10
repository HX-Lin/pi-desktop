import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPACT_HINT_THRESHOLD,
  AUTO_COMPACT_MESSAGE_THRESHOLD,
  countBranchConversationMessages,
  countConversationMessages,
} from "./auto-compact.ts";

test("conversation counting ignores non user/assistant entries", () => {
  assert.equal(
    countConversationMessages([
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
      { role: "custom" },
      {},
      { role: "user" },
    ]),
    3,
  );
});

test("auto-compaction hint fires before the automatic threshold", () => {
  assert.ok(AUTO_COMPACT_HINT_THRESHOLD > 0);
  assert.ok(AUTO_COMPACT_HINT_THRESHOLD < AUTO_COMPACT_MESSAGE_THRESHOLD);
});

test("branch counting starts after the latest compaction entry", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "compaction", summary: "older turns" },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "assistant" } },
  ];
  assert.equal(countBranchConversationMessages(entries), 2);
});

test("branch counting without compaction counts every conversation message", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant" } },
  ];
  assert.equal(countBranchConversationMessages(entries), 3);
});
