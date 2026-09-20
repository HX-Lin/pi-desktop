import assert from "node:assert/strict";
import test from "node:test";
import { isCredentialKey, normalizeCredentialKey } from "./credential-keys.ts";

test("accepts the channel and Jev namespaces", () => {
  // Messaging channel accounts.
  assert.equal(normalizeCredentialKey("channel:feishu:cli_abc123"), "channel:feishu:cli_abc123");
  assert.equal(normalizeCredentialKey("channel:telegram:bot-1"), "channel:telegram:bot-1");
  assert.equal(normalizeCredentialKey("  channel:weixin:acc.1  "), "channel:weixin:acc.1");

  // Every Jev channel in `agent-host/jev/channels.ts` — the vault used to reject
  // these, which made the API key impossible to save and left the gate with no
  // engine (and therefore blocking every judged call).
  for (const key of ["jev.typesafe", "jev.vercel", "jev.openrouter"]) {
    assert.equal(normalizeCredentialKey(key), key);
  }
  // A new gateway is a configuration entry, so the namespace must not be a list
  // of the three shipped channels.
  assert.equal(normalizeCredentialKey("jev.my-gateway"), "jev.my-gateway");
});

test("refuses everything else", () => {
  for (const key of [
    "",
    "jev",
    "jev.",
    "jev.vercel.extra",
    "channel:feishu",
    "channel:unknown:abc",
    "channel:feishu:has space",
    "channel:feishu:../escape",
    "channel:feishu:",
    `jev.${"a".repeat(33)}`,
    "other.vercel",
  ]) {
    assert.equal(isCredentialKey(key), false, `${JSON.stringify(key)} must be refused`);
    assert.throws(() => normalizeCredentialKey(key), /Invalid credential key/);
  }
});
