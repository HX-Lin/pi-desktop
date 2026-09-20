import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const output = path.join(root, ".artifacts", "test-modules", `jev-transport-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/agent-host/jev/transport.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { JevUnavailableError, createJevClient } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

const questions = {
  "t1.keep": { type: "noul", instructions: "does call t1 still matter?" },
  "t1.stale": { type: "score", instructions: "how stale is t1?" },
  "t1.mode": { type: "choice", instructions: "pick one", criteria: { a: "keep", b: "drop" } },
};

function jsonResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(overrides = {}) {
  return createJevClient({
    protocol: "decisions",
    baseUrl: "https://api.example/v1/systemone",
    model: "jev-latest",
    apiKey: "test-key",
    timeoutMs: 500,
    maxRetries: 0,
    ...overrides,
  });
}

test("the native decisions protocol sends the documented body", async () => {
  const seen = [];
  const c = client({
    fetch: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({
        answers: { "t1.keep": { noul: 0.91 }, "t1.stale": { score: 0.2 } },
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    },
  });

  const outcome = await c.ask("the state", questions);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.judgment.answers["t1.keep"], { noul: 0.91 });
  assert.deepEqual(outcome.judgment.answers["t1.stale"], { score: 0.2 });
  // The question key that got no answer is reported, not invented.
  assert.deepEqual(outcome.judgment.missing, ["t1.mode"]);
  assert.deepEqual(outcome.judgment.inputTokens, 12);

  const body = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url, "https://api.example/v1/systemone");
  assert.equal(seen[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(body.questions, questions);
  assert.equal(body.state, "the state");
});

test("the chat protocol works for an OpenAI-compatible gateway", async () => {
  const seen = [];
  const c = client({
    protocol: "chat",
    baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
    model: "typesafe/jev-1.13",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({
        model: "typesafe/jev-1.13",
        choices: [
          {
            message: {
              content: '```json\n{"answers":{"t1.keep":{"noul":0.4},"t1.stale":{"score":0.8}}}\n```',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    },
  });

  const outcome = await c.ask({ context: "x" }, questions);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.judgment.answers["t1.keep"].noul, 0.4);
  assert.equal(outcome.judgment.answers["t1.stale"].score, 0.8);
  assert.equal(outcome.judgment.inputTokens, 100);

  const body = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.equal(body.response_format.type, "json_object");
  assert.match(body.messages[0].content, /answers/);
  // The state and questions travel as JSON in one user message.
  assert.deepEqual(JSON.parse(body.messages[1].content).questions, questions);
});

test("a 200 with unusable answers yields no value, only a reported gap", async () => {
  // An unusable answer is never a number the caller could mistake for approval:
  // it lands in `missing`, and the consumer decides (the gate blocks, the
  // compaction retains that call conservatively).
  const unusable = [
    '{"answers":{"t1.keep":{"noul":"yes"}}}',
    '{"answers":{"t1.keep":{"noul":1.4}}}',
    '{"answers":{"t1.keep":{}}}',
    "not json at all",
  ];
  for (const body of unusable) {
    const c = client({ fetch: async () => jsonResponse(body) });
    const outcome = await c.ask("state", { "t1.keep": questions["t1.keep"] });
    if (outcome.ok) {
      assert.deepEqual(outcome.judgment.answers, {}, `expected no answer for ${body}`);
      assert.deepEqual(outcome.judgment.missing, ["t1.keep"], `expected a gap for ${body}`);
    } else {
      assert.equal(outcome.reason, "malformed_response");
    }
  }

  // A bare probability is accepted: some gateways drop the wrapper object.
  const bare = await client({ fetch: async () => jsonResponse({ answers: { "t1.keep": 0.77 } }) }).ask("state", {
    "t1.keep": questions["t1.keep"],
  });
  assert.equal(bare.ok, true);
  assert.equal(bare.judgment.answers["t1.keep"].noul, 0.77);

  // A question that simply was not answered is a gap, not a zero.
  const missing = await client({ fetch: async () => jsonResponse({ answers: {} }) }).ask("state", {
    "t1.keep": questions["t1.keep"],
  });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.judgment.missing, ["t1.keep"]);
  assert.deepEqual(missing.judgment.answers, {});
});

test("http and network failures are classified, and only transient ones retry", async () => {
  let attempts = 0;
  const retrying = client({
    maxRetries: 2,
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse("busy", 503);
      return jsonResponse({ answers: { "t1.keep": { noul: 0.7 } } });
    },
  });
  const recovered = await retrying.ask("state", { "t1.keep": questions["t1.keep"] });
  assert.equal(recovered.ok, true);
  assert.equal(attempts, 3);
  assert.equal(recovered.judgment.requests, 3);

  let client4xx = 0;
  const refused = client({
    maxRetries: 3,
    fetch: async () => {
      client4xx += 1;
      return jsonResponse("nope", 401);
    },
  });
  const outcome = await refused.ask("state", { "t1.keep": questions["t1.keep"] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "http");
  assert.equal(outcome.status, 401);
  // A 4xx is final: retrying a bad key only wastes time.
  assert.equal(client4xx, 1);

  const offline = client({
    fetch: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    },
  });
  assert.equal((await offline.ask("state", {})).reason, "network");

  const timedOut = client({
    fetch: async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  });
  assert.equal((await timedOut.ask("state", {})).reason, "timeout");
});

test("a missing key fails before any request, and askOrThrow throws", async () => {
  let called = 0;
  const c = client({
    apiKey: "  ",
    fetch: async () => {
      called += 1;
      return jsonResponse({ answers: {} });
    },
  });
  const outcome = await c.ask("state", {});
  assert.equal(outcome.ok, false);
  assert.equal(called, 0, "no request should be made without a key");

  const failing = client({ fetch: async () => jsonResponse("boom", 500) });
  await assert.rejects(
    () => failing.askOrThrow("state", {}),
    (error) => error instanceof JevUnavailableError && error.reason === "http",
  );
});

test("caller cancellation is not turned into a verdict", async () => {
  const controller = new AbortController();
  const c = client({
    fetch: async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await assert.rejects(() => c.ask("state", {}, { signal: controller.signal }));
});
