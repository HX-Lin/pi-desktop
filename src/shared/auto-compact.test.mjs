import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPACT_HINT_THRESHOLD,
  AUTO_COMPACT_MESSAGE_THRESHOLD,
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
