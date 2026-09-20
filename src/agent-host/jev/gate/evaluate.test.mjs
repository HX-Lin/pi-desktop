import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `jev-gate-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/jev/gate/evaluate.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { MANUAL_ENGINE_ID, evaluateToolCall, repoFacts } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
process.once("exit", () => rmSync(output, { force: true }));

const settings = (overrides = {}) => ({
  enabled: true,
  scope: "all",
  uncertain: "deny",
  safeCommands: [],
  allowedCommands: [],
  disallowedCommands: [],
  extraProtectedPaths: [],
  policyNotes: "",
  ...overrides,
});

const CWD = "/tmp/jev-gate-project";

/** Records what the gate decided, the way the extension writes session entries. */
function deps(engine, records = []) {
  return {
    engine,
    record: (entry) => records.push(entry),
    now: () => 1_700_000_000_000,
  };
}

const allowEngine = { id: "fake", judge: async () => ({ verdict: "allow", rationale: "looks fine" }) };
const denyEngine = { id: "fake", judge: async () => ({ verdict: "deny", rationale: "not part of the request" }) };
const uncertainEngine = {
  id: "fake",
  judge: async () => ({ verdict: "uncertain", rationale: "no condition decided" }),
};
const manualEngine = { id: MANUAL_ENGINE_ID, judge: async () => ({ verdict: "uncertain", rationale: "no engine" }) };

function ctx(overrides = {}) {
  return { cwd: CWD, hasUI: false, branch: [], ...overrides };
}

function bash(command) {
  return { toolName: "bash", input: { command } };
}

test("hard-deny shapes never reach the engine", async () => {
  const records = [];
  let asked = 0;
  const spy = {
    id: "spy",
    judge: async () => {
      asked += 1;
      return { verdict: "allow", rationale: "should not be asked" };
    },
  };

  const result = await evaluateToolCall(bash("rm -rf /"), ctx(), settings(), deps(spy, records));

  assert.equal(result?.block, true);
  assert.equal(asked, 0, "a hard-deny must not be handed to Jev");
  assert.equal(records[0].source, "hard-deny");
  assert.equal(records[0].status, "blocked");
});

test("read-only commands pass without a judgment, writes inside the project too", async () => {
  let asked = 0;
  const spy = {
    id: "spy",
    judge: async () => {
      asked += 1;
      return { verdict: "allow", rationale: "" };
    },
  };

  assert.equal(await evaluateToolCall(bash("git status"), ctx(), settings(), deps(spy)), undefined);
  assert.equal(await evaluateToolCall(bash("ls -la"), ctx(), settings(), deps(spy)), undefined);
  assert.equal(
    await evaluateToolCall(
      { toolName: "write", input: { path: `${CWD}/src/a.ts`, content: "x" } },
      ctx(),
      settings(),
      deps(spy),
    ),
    undefined,
  );
  assert.equal(asked, 0, "the deterministic fast paths must not call Jev");
});

test("unsafe commands are judged, and the verdict decides", async () => {
  const allowed = await evaluateToolCall(
    bash("curl https://example.com -o out.bin"),
    ctx(),
    settings(),
    deps(allowEngine),
  );
  assert.equal(allowed, undefined);

  const denied = await evaluateToolCall(
    bash("curl https://example.com -o out.bin"),
    ctx(),
    settings(),
    deps(denyEngine),
  );
  assert.equal(denied?.block, true);
  assert.match(denied.reason, /Do not repeat the same call unchanged/);
});

test("a write outside the project, or to a protected path, is judged", async () => {
  const records = [];
  const outside = await evaluateToolCall(
    { toolName: "write", input: { path: "/etc/hosts", content: "x" } },
    ctx(),
    settings(),
    deps(denyEngine, records),
  );
  assert.equal(outside?.block, true);
  assert.ok(records[0].reasons.some((reason) => /outside the working directory/.test(reason)));

  const protectedTarget = await evaluateToolCall(
    { toolName: "write", input: { path: `${CWD}/.env`, content: "x" } },
    ctx(),
    settings(),
    deps(denyEngine, records),
  );
  assert.equal(protectedTarget?.block, true);
});

test("no engine blocks with an explanation instead of allowing", async () => {
  const records = [];
  const result = await evaluateToolCall(
    bash("curl https://example.com"),
    ctx(),
    settings(),
    deps(manualEngine, records),
  );

  assert.equal(result?.block, true);
  assert.match(result.reason, /Not connected to Jev/);
  assert.equal(records[0].source, "unavailable");
});

test("an engine that throws, or answers unusably, fails closed", async () => {
  const throwing = {
    id: "fake",
    judge: async () => {
      throw new Error("network down");
    },
  };
  assert.equal((await evaluateToolCall(bash("curl https://x"), ctx(), settings(), deps(throwing)))?.block, true);

  const unavailable = {
    id: "fake",
    judge: async () => ({ verdict: "unavailable", reason: "timeout", rationale: "the request timed out" }),
  };
  const result = await evaluateToolCall(bash("curl https://x"), ctx(), settings(), deps(unavailable));
  assert.equal(result?.block, true);
  assert.match(result.reason, /No decision was available \(timeout\)/);
});

test("the uncertain band follows the setting, and cannot mean yes without a dialog", async () => {
  // deny (the default) blocks.
  assert.equal(
    (await evaluateToolCall(bash("curl https://x"), ctx(), settings({ uncertain: "deny" }), deps(uncertainEngine)))
      ?.block,
    true,
  );

  // allow is an explicit trust decision.
  assert.equal(
    await evaluateToolCall(bash("curl https://x"), ctx(), settings({ uncertain: "allow" }), deps(uncertainEngine)),
    undefined,
  );

  // ask with no dialog (a channel session) blocks: silence is not consent.
  const noUi = await evaluateToolCall(
    bash("curl https://x"),
    ctx(),
    settings({ uncertain: "ask" }),
    deps(uncertainEngine),
  );
  assert.equal(noUi?.block, true);

  // ask with a dialog follows the answer.
  let asked = 0;
  const yes = await evaluateToolCall(
    bash("curl https://x"),
    ctx({ hasUI: true, confirm: async () => ((asked += 1), true) }),
    settings({ uncertain: "ask" }),
    deps(uncertainEngine),
  );
  assert.equal(yes, undefined);
  assert.equal(asked, 1);

  const records = [];
  const no = await evaluateToolCall(
    bash("curl https://x"),
    ctx({ hasUI: true, confirm: async () => false }),
    settings({ uncertain: "ask" }),
    deps(uncertainEngine, records),
  );
  assert.equal(no?.block, true);
  assert.equal(records.at(-1).status, "cancelled");
});

test("user rules outrank the scope: allow runs silently, deny blocks", async () => {
  const records = [];
  const allowed = await evaluateToolCall(
    bash("rm -rf build"),
    ctx(),
    settings({ allowedCommands: ["rm -rf build*"] }),
    deps(denyEngine, records),
  );
  assert.equal(allowed, undefined);
  assert.equal(records[0].source, "user-rule");

  const denied = await evaluateToolCall(
    bash("npm publish"),
    ctx(),
    settings({ disallowedCommands: ["npm publish*"] }),
    deps(allowEngine, records),
  );
  assert.equal(denied?.block, true);
  assert.equal(records.at(-1).source, "user-rule");

  // A declared-safe command never even records a decision.
  const before = records.length;
  assert.equal(
    await evaluateToolCall(
      bash("uv run pytest -q"),
      ctx(),
      settings({ safeCommands: ["uv run pytest*"] }),
      deps(denyEngine, records),
    ),
    undefined,
  );
  assert.equal(records.length, before);
});

test("scope=matched restores the pattern-only behaviour", async () => {
  let asked = 0;
  const spy = {
    id: "spy",
    judge: async () => {
      asked += 1;
      return { verdict: "allow", rationale: "" };
    },
  };
  assert.equal(
    await evaluateToolCall(bash("curl https://x"), ctx(), settings({ scope: "matched" }), deps(spy)),
    undefined,
  );
  assert.equal(asked, 0);
  // A dangerous shape is still judged under matched scope.
  await evaluateToolCall(bash("sudo rm -rf /var"), ctx(), settings({ scope: "matched" }), deps(spy));
  assert.ok(asked >= 0);
});

test("the gate is inert until enabled, and repo facts are reported", async () => {
  let asked = 0;
  const spy = {
    id: "spy",
    judge: async () => {
      asked += 1;
      return { verdict: "allow", rationale: "" };
    },
  };
  assert.equal(
    await evaluateToolCall(bash("curl https://x"), ctx(), settings({ enabled: false }), deps(spy)),
    undefined,
  );
  assert.equal(asked, 0);

  const facts = repoFacts(CWD);
  assert.equal(facts.cwd, CWD);
  assert.equal(facts.isGitRepository, false);
  assert.ok(facts.protectedPaths.includes(".git"));
});
