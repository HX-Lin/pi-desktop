import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AUTO_COMPACT_MESSAGE_THRESHOLD, countConversationMessages } from "../shared/auto-compact.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
let modulePromise;

async function loadRpcManager() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const outDir = path.join(root, ".artifacts", "test-modules");
    mkdirSync(outDir, { recursive: true });
    const outfile = path.join(outDir, `rpc-manager-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/agent-host/rpc-manager.ts"],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  })();
  return modulePromise;
}

function message(role) {
  return { type: "message", message: { role } };
}

function conversationPair(count) {
  return Array.from({ length: count }, (_, index) => message(index % 2 === 0 ? "user" : "assistant"));
}

function createFakeSession({ branch, autoCompactionEnabled = true }) {
  const state = { branch: [...branch], compactCalls: 0, compactInstructions: [] };
  const sessionManager = {
    getBranch: () => state.branch,
    getHeader: () => ({ cwd: "/tmp/pi-auto-compact" }),
    appendCustomEntry: () => "entry",
    getSessionId: () => "session-auto-compact",
    getSessionFile: () => "/tmp/pi-auto-compact.jsonl",
  };
  const base = {
    sessionId: "session-auto-compact",
    sessionFile: "/tmp/pi-auto-compact.jsonl",
    agent: { state: { messages: [] } },
    sessionManager,
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled,
    prompt: async () => {},
    sendCustomMessage: async () => {},
    getLastAssistantText: () => "done",
    subscribe: () => () => {},
    compact: async (instructions) => {
      state.compactCalls += 1;
      state.compactInstructions.push(instructions ?? null);
      state.branch = state.branch.slice(-10);
      return { summary: "compacted" };
    },
  };
  const inner = new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property];
      return () => undefined;
    },
  });
  return { inner, state };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for auto-compaction");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("countBranchConversationMessages counts only user/assistant branch entries", async () => {
  const { countBranchConversationMessages } = await loadRpcManager();
  assert.equal(
    countBranchConversationMessages([
      message("user"),
      { type: "compaction", summary: "old" },
      message("user"),
      message("assistant"),
      { type: "message", message: { role: "toolResult" } },
      { type: "model_change", provider: "p", modelId: "m" },
      "not-an-entry",
      null,
    ]),
    2,
  );
});

test("a turn past the message threshold triggers automatic compaction", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({ branch: conversationPair(AUTO_COMPACT_MESSAGE_THRESHOLD) });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-auto", message: "hello", channel: "telegram" });
    await waitFor(() => state.compactCalls === 1);
    assert.equal(state.compactCalls, 1);
    assert.match(
      String(state.compactInstructions[0]),
      new RegExp(`Automatically compacted after ${AUTO_COMPACT_MESSAGE_THRESHOLD} conversation messages`),
    );
    assert.ok(countConversationMessages(state.branch) < AUTO_COMPACT_MESSAGE_THRESHOLD);
  } finally {
    wrapper.destroy();
  }
});

test("a short session never auto-compacts", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({ branch: conversationPair(AUTO_COMPACT_MESSAGE_THRESHOLD - 2) });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-short", message: "hello", channel: "telegram" });
    await settle();
    assert.equal(state.compactCalls, 0);
  } finally {
    wrapper.destroy();
  }
});

test("the pi auto-compaction switch disables message-count compaction", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({
    branch: conversationPair(AUTO_COMPACT_MESSAGE_THRESHOLD),
    autoCompactionEnabled: false,
  });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-off", message: "hello", channel: "telegram" });
    await settle();
    assert.equal(state.compactCalls, 0);
  } finally {
    wrapper.destroy();
  }
});
