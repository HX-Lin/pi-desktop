import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPACT_HINT_TURNS,
  AUTO_COMPACT_TURNS_MAX,
  AUTO_COMPACT_TURNS_MIN,
  AUTO_COMPACT_TURN_THRESHOLD,
  countBranchConversationMessages,
  clampAutoCompactTurns,
  countBranchConversationTurns,
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
  assert.ok(AUTO_COMPACT_HINT_TURNS > 0);
  assert.ok(AUTO_COMPACT_HINT_TURNS < AUTO_COMPACT_TURN_THRESHOLD);
});

test("a turn counts the user message, not the assistant steps it produced", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "toolResult" } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
  ];

  assert.equal(countBranchConversationTurns(entries), 2);
  assert.equal(countBranchConversationMessages(entries), 6);
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
  assert.equal(countBranchConversationTurns(entries), 1);
});

test("branch counting without compaction counts every conversation message", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant" } },
  ];
  assert.equal(countBranchConversationMessages(entries), 3);
  assert.equal(countBranchConversationTurns(entries), 1);
});

test("user supplied thresholds are clamped into the supported range", () => {
  assert.equal(clampAutoCompactTurns(AUTO_COMPACT_TURNS_MIN - 1), AUTO_COMPACT_TURNS_MIN);
  assert.equal(clampAutoCompactTurns(AUTO_COMPACT_TURNS_MAX + 1), AUTO_COMPACT_TURNS_MAX);
  assert.equal(clampAutoCompactTurns("12"), 12);
  assert.equal(clampAutoCompactTurns(12.4), 12);
  assert.equal(clampAutoCompactTurns(undefined), AUTO_COMPACT_TURN_THRESHOLD);
  assert.equal(clampAutoCompactTurns(Number.NaN), AUTO_COMPACT_TURN_THRESHOLD);
});
