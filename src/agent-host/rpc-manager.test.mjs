import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AUTO_COMPACT_TURN_THRESHOLD, countBranchConversationMessages } from "../shared/auto-compact.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
// Isolate the Host settings file so a developer's local threshold cannot
// change the expected default behaviour.
const agentDir = mkdtempSync(path.join(tmpdir(), "pi-rpc-manager-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
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

/**
 * Build `count` conversation turns. Each turn is one user message followed by
 * two assistant steps, mirroring how a single turn balloons into many messages.
 */
function conversationTurns(count) {
  return Array.from({ length: count }, () => [message("user"), message("assistant"), message("assistant")]).flat();
}

function createFakeSession({ branch, autoCompactionEnabled = true, contextUsage = null }) {
  const state = { branch: [...branch], compactCalls: 0, compactInstructions: [], contextUsage };
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
    getContextUsage: () => state.contextUsage,
    subscribe: () => () => {},
    compact: async (instructions) => {
      state.compactCalls += 1;
      state.compactInstructions.push(instructions ?? null);
      state.branch = state.branch.slice(-6);
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

test("a chat past the turn threshold triggers automatic compaction", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({ branch: conversationTurns(AUTO_COMPACT_TURN_THRESHOLD) });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-auto", message: "hello", channel: "telegram" });
    await waitFor(() => state.compactCalls === 1);
    assert.equal(state.compactCalls, 1);
    // Desktop compactions are memory compactions, so the distillation prompt is
    // attached and the trigger reason is spelled out on top of it.
    const instructions = String(state.compactInstructions[0]);
    assert.match(instructions, /压缩为记忆/);
    assert.match(instructions, new RegExp(`已达到 ${AUTO_COMPACT_TURN_THRESHOLD} 条对话`));
    assert.ok(countBranchConversationMessages(state.branch) < AUTO_COMPACT_TURN_THRESHOLD * 3);
  } finally {
    wrapper.destroy();
  }
});

test("many assistant steps in a few turns never auto-compact", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  // One turn that produced 140 assistant steps used to look like 140 messages.
  const branch = [message("user"), ...Array.from({ length: 140 }, () => message("assistant"))];
  const { inner, state } = createFakeSession({ branch });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-steps", message: "hello", channel: "telegram" });
    await settle();
    assert.ok(countBranchConversationMessages(state.branch) > AUTO_COMPACT_TURN_THRESHOLD * 2);
    assert.equal(state.compactCalls, 0);
  } finally {
    wrapper.destroy();
  }
});

test("a short session never auto-compacts", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({ branch: conversationTurns(AUTO_COMPACT_TURN_THRESHOLD - 2) });
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
    branch: conversationTurns(AUTO_COMPACT_TURN_THRESHOLD),
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

test("the persisted threshold setting decides when to compact", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  writeFileSync(path.join(agentDir, "pi-desktop-settings.json"), JSON.stringify({ autoCompactTurns: 5 }), "utf8");
  const { inner, state } = createFakeSession({ branch: conversationTurns(5) });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-setting", message: "hello", channel: "telegram" });
    await waitFor(() => state.compactCalls === 1);
    assert.equal(state.compactCalls, 1);
    assert.match(String(state.compactInstructions[0]), /已达到 5 条对话/);
  } finally {
    wrapper.destroy();
    rmSync(path.join(agentDir, "pi-desktop-settings.json"), { force: true });
  }
});

test("a filling context window starts a memory compaction by itself", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  // Far below the turn threshold, but the window is nearly full: compacting to
  // memory is what relieves it, so that is what must run.
  const { inner, state } = createFakeSession({
    branch: conversationTurns(2),
    contextUsage: { percent: 82, contextWindow: 200_000, tokens: 164_000 },
  });
  const wrapper = new AgentSessionWrapper(inner);
  try {
    await wrapper.runExternalTurn({ runId: "run-window", message: "hello", channel: "telegram" });
    await waitFor(() => state.compactCalls === 1);
    const instructions = String(state.compactInstructions[0]);
    assert.match(instructions, /压缩为记忆/);
    assert.match(instructions, /上下文已占用 82%/);
  } finally {
    wrapper.destroy();
  }
});

test("a plain compact command is a context compaction, not a memory compaction", async () => {
  const { AgentSessionWrapper } = await loadRpcManager();
  const { inner, state } = createFakeSession({ branch: conversationTurns(2) });
  const wrapper = new AgentSessionWrapper(inner);

  await wrapper.send({ type: "compact", customInstructions: "focus" });
  assert.equal(state.compactCalls, 1);
  // pi's own summarization prompt only: no distillation instructions attached.
  assert.equal(state.compactInstructions[0], "focus");

  await wrapper.send({ type: "compact", mode: "memory" });
  assert.equal(state.compactCalls, 2);
  assert.match(String(state.compactInstructions[1]), /^这是一次「压缩为记忆」/);

  wrapper.destroy();
});
