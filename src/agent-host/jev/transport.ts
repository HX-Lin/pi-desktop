/**
 * The Jev transport: one place that turns questions into answers.
 *
 * Three protocols, one result shape:
 *
 * - `decisions` — the native `{ model, state, questions } -> { answers }` call
 *   (TypeSafe System One, OpenRouter Decisions API).
 * - `chat` — an OpenAI-compatible `chat/completions` endpoint (Vercel AI
 *   Gateway). The same request travels as JSON inside one user message and the
 *   reply is parsed and validated exactly like the native one. A gateway answer
 *   is not trusted because it arrived with a 200: every question that was asked
 *   must come back with a usable value, or it is reported as missing.
 *
 * Failures never throw except for caller cancellation. A gate has to turn a
 * failure into a decision, and a compaction into a fallback, so the outcome is
 * data.
 */
import { buildJevRequest, parseJevResponse } from "../vendor/jev/request";
import type { JevUnavailableReason } from "./types";

export type { JevUnavailableReason };

/** One question as the transport must validate it. */
export interface JevQuestionShape {
  type: "noul" | "score" | "choice";
  instructions?: unknown;
  criteria?: unknown;
}

export interface JevAnswerValue {
  /** Probability for `noul` questions (and the gate's whole vocabulary). */
  noul?: number;
  /** Value for `score` questions (staleness, difficulty). */
  score?: number;
  /** Value for `choice` questions. */
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevJudgment {
  model: string;
  /** Validated answers, keyed by question name. */
  answers: Record<string, JevAnswerValue>;
  /** Questions that were asked but came back missing or unusable. */
  missing: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  requests: number;
}

export type JevOutcome =
  { ok: true; judgment: JevJudgment } | { ok: false; reason: JevUnavailableReason; status?: number; message?: string };

/** Thrown by the asker adapter, so callers that prefer exceptions can fall back. */
export class JevUnavailableError extends Error {
  readonly reason: JevUnavailableReason;
  readonly status?: number;

  constructor(reason: JevUnavailableReason, status?: number, message?: string) {
    super(message ?? `Jev unavailable (${reason})`);
    this.name = "JevUnavailableError";
    this.reason = reason;
    this.status = status;
  }
}

export interface JevClientOptions {
  /** `decisions` posts the native body; `chat` posts one chat completion. */
  protocol: "decisions" | "chat" | "evaluate";
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt, for transient failures only. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

export interface JevAskOptions {
  signal?: AbortSignal;
}

export interface JevClient {
  ask(state: unknown, questions: Record<string, JevQuestionShape>, options?: JevAskOptions): Promise<JevOutcome>;
  /** Same call, but throws on failure (the compaction path falls back on throw). */
  askOrThrow(
    state: unknown,
    questions: Record<string, JevQuestionShape>,
    options?: JevAskOptions,
  ): Promise<JevJudgment>;
}

const CHAT_SYSTEM_PROMPT = [
  "You are a typed decision service. You are given a `state` document and a set of `questions`.",
  "Answer every question independently and in parallel. Do not use the question keys as hints: read each",
  "question's own instructions and criteria.",
  "",
  "Reply with JSON only, exactly this shape:",
  '{"answers":{"<question key>":{"noul":0.0,"score":0.0,"choice":"<one of the criteria keys>"}}}',
  "",
  "Per question type:",
  '- "noul": set `noul` to the probability (0..1) that the condition holds, where the safe state is "yes".',
  '- "score": set `score` to the value (0..1) the instructions ask for.',
  '- "choice": set `choice` to one of its `criteria` keys.',
  "Omit the fields that do not apply to a question. Never invent or omit a question key.",
].join("\n");

export function createJevClient(options: JevClientOptions): JevClient {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;
  const maxRetries = Math.max(0, options.maxRetries ?? 0);

  const ask = async (
    state: unknown,
    questions: Record<string, JevQuestionShape>,
    askOptions: JevAskOptions = {},
  ): Promise<JevOutcome> => {
    if (!options.apiKey.trim()) return { ok: false, reason: "http", message: "Jev API key is not configured" };
    const started = Date.now();
    let lastFailure: Extract<JevOutcome, { ok: false }> = { ok: false, reason: "unknown" };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = askOptions.signal ? AbortSignal.any([askOptions.signal, timeout]) : timeout;
      try {
        const response =
          options.protocol === "chat"
            ? await requestChat(fetcher, options, state, questions, signal)
            : options.protocol === "evaluate"
              ? await requestEvaluate(fetcher, options, state, questions, signal)
              : await requestDecisions(fetcher, options, state, questions, signal);
        if (response.ok) {
          return {
            ok: true,
            judgment: { ...response.judgment, ms: Date.now() - started, requests: attempt + 1 },
          };
        }
        lastFailure = response;
        if (!isRetryable(response)) return response;
      } catch (error) {
        // Cancellation is control flow, not a verdict.
        if (askOptions.signal?.aborted) throw error;
        lastFailure = classifyThrown(error);
        if (lastFailure.reason !== "network" && lastFailure.reason !== "timeout") return lastFailure;
      }
      if (attempt < maxRetries) await delay(250 * (attempt + 1), askOptions.signal);
    }

    return lastFailure;
  };

  return {
    ask,
    async askOrThrow(state, questions, askOptions) {
      const outcome = await ask(state, questions, askOptions);
      if (!outcome.ok) throw new JevUnavailableError(outcome.reason, outcome.status, outcome.message);
      return outcome.judgment;
    },
  };
}

// ---------------------------------------------------------------------------
// Native decisions protocol
// ---------------------------------------------------------------------------

async function requestDecisions(
  fetcher: typeof fetch,
  options: JevClientOptions,
  state: unknown,
  questions: Record<string, JevQuestionShape>,
  signal: AbortSignal,
): Promise<JevOutcome> {
  const request = buildJevRequest(
    { apiKey: options.apiKey, model: options.model, baseUrl: options.baseUrl },
    state as never,
    questions as never,
  );
  const response = await fetcher(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, reason: "http", status: response.status, message: describeHttpFailure(response.status, text) };
  }
  let parsed: unknown;
  try {
    parsed = parseJevResponse(response.status, response.ok, text);
  } catch (error) {
    return { ok: false, reason: "malformed_response", message: messageOf(error) };
  }
  return validateJudgment(parsed, Object.keys(questions));
}

// ---------------------------------------------------------------------------
// Evaluation route (Vercel AI Gateway → Jev)
// ---------------------------------------------------------------------------

/**
 * Vercel's `/v1/evaluate`.
 *
 * The gateway does not serve Jev on `chat/completions` — Jev is its only
 * `evaluation` model, and every spelling of the slug answers 404 there. It is
 * served here instead, in TypeSafe's System One shape.
 *
 * Only the question vocabulary differs from the native endpoint: what upstream
 * calls `noul` is `boolean`, and `criteria` is an array for `score` but a record
 * for `choice`. Instructions may stay structured objects, which is what the gate
 * sends (`{question, judge, reference, note}`).
 */
async function requestEvaluate(
  fetcher: typeof fetch,
  options: JevClientOptions,
  state: unknown,
  questions: Record<string, JevQuestionShape>,
  signal: AbortSignal,
): Promise<JevOutcome> {
  const response = await fetcher(options.baseUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, state: state ?? {}, questions: evaluateQuestions(questions) }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, reason: "http", status: response.status, message: describeHttpFailure(response.status, text) };
  }

  const payload = parseJson(text);
  if (!isRecord(payload)) {
    return unreadableReply("the evaluation reply was not JSON", text);
  }
  const judgment = validateJudgment(payload, Object.keys(questions));
  if (!judgment.ok) return judgment;
  if (Object.keys(judgment.judgment.answers).length === 0) {
    // Rather than "no answer", show what actually arrived: this is the one part
    // of the route that cannot be derived from the public schema.
    return unreadableReply("the reply held no answer in a recognised shape", text);
  }
  return { ok: true, judgment: judgment.judgment };
}

/** `malformed_response`, with the body, so a wrong guess is diagnosable. */
function unreadableReply(reason: string, text: string): JevOutcome {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: false, reason: "malformed_response", message: excerpt ? `${reason}: ${excerpt}` : reason };
}

/** Translate the shared question vocabulary into the evaluation route's. */
export function evaluateQuestions(
  questions: Record<string, JevQuestionShape>,
): Record<string, Record<string, unknown>> {
  const converted: Record<string, Record<string, unknown>> = {};
  for (const [key, question] of Object.entries(questions)) {
    converted[key] = evaluateQuestion(question);
  }
  return converted;
}

function evaluateQuestion(question: JevQuestionShape): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: question.type === "noul" ? "boolean" : question.type };
  if (question.instructions !== undefined) entry.instructions = question.instructions;
  const criteria = question.criteria;
  if (criteria !== undefined && criteria !== null) {
    // `score` takes an array of levels; `choice` and `boolean` take a record.
    if (question.type === "score") entry.criteria = Array.isArray(criteria) ? criteria : Object.values(criteria);
    else if (Array.isArray(criteria)) {
      entry.criteria = Object.fromEntries(criteria.map((item) => [String(item), String(item)]));
    } else entry.criteria = criteria;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Chat-completions adapter (Vercel AI Gateway)
// ---------------------------------------------------------------------------

async function requestChat(
  fetcher: typeof fetch,
  options: JevClientOptions,
  state: unknown,
  questions: Record<string, JevQuestionShape>,
  signal: AbortSignal,
): Promise<JevOutcome> {
  const body = (withResponseFormat: boolean) =>
    JSON.stringify({
      model: options.model,
      temperature: 0,
      ...(withResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ state, questions }) },
      ],
    });
  const post = async (withResponseFormat: boolean) => {
    const response = await fetcher(options.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: body(withResponseFormat),
      signal,
    });
    return { response, text: await response.text() };
  };

  let { response, text } = await post(true);
  if (!response.ok && rejectsResponseFormat(response.status, text)) {
    // Evaluation-style endpoints sometimes reject the whole request over an
    // OpenAI parameter they do not implement. The system prompt already demands
    // JSON and the reply is parsed defensively, so the retry is safe.
    ({ response, text } = await post(false));
  }
  if (!response.ok) {
    return { ok: false, reason: "http", status: response.status, message: describeHttpFailure(response.status, text) };
  }
  const envelope = parseJson(text);
  if (!isRecord(envelope)) return { ok: false, reason: "malformed_response", message: "chat reply was not JSON" };

  const content = firstChoiceContent(envelope);
  if (content === null) return { ok: false, reason: "malformed_response", message: "chat reply had no content" };
  const answers = parseJson(stripFences(content));
  if (!answers) return { ok: false, reason: "malformed_response", message: "answers were not JSON" };

  const judgment = validateJudgment(answers, Object.keys(questions));
  if (!judgment.ok) return judgment;
  const usage = isRecord(envelope.usage) ? envelope.usage : {};
  return {
    ok: true,
    judgment: {
      ...judgment.judgment,
      model: typeof envelope.model === "string" ? envelope.model : options.model,
      inputTokens: readCount(usage.prompt_tokens),
      outputTokens: readCount(usage.completion_tokens),
    },
  };
}

/** `{"answers":{…}}`, or the answer map itself if the model flattened it. */
function validateJudgment(payload: unknown, keys: string[]): JevOutcome {
  if (!isRecord(payload)) return { ok: false, reason: "malformed_response", message: "payload was not an object" };
  const source = answerContainer(payload);
  const answers: Record<string, JevAnswerValue> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const value = source[key];
    const normalized = normalizeAnswer(value);
    if (normalized) answers[key] = normalized;
    else missing.push(key);
  }

  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    ok: true,
    judgment: {
      model: typeof payload.model === "string" && payload.model ? payload.model : "unknown",
      answers,
      missing,
      inputTokens: readCount(usage.input_tokens),
      outputTokens: readCount(usage.output_tokens),
      ms: 0,
      requests: 1,
    },
  };
}

/**
 * Where a verdict set may sit in a reply.
 *
 * The native endpoint answers `{"answers":{…}}`; the evaluation route may wrap
 * it (`results`, `evaluations`) or return entries as a list. All of them are
 * accepted, because a wrapper we do not recognise is indistinguishable from "no
 * answer" and would silently drop a decision.
 */
function answerContainer(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["answers", "results", "evaluations", "output"]) {
    const value = payload[key];
    if (isRecord(value)) return value;
    if (Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const item of value) {
        if (!isRecord(item)) continue;
        const id = item.id ?? item.key ?? item.question;
        if (typeof id === "string" && id) mapped[id] = item;
      }
      if (Object.keys(mapped).length > 0) return mapped;
    }
  }
  return payload;
}

function normalizeAnswer(value: unknown): JevAnswerValue | null {
  // A bare probability is accepted: some gateways drop the wrapper.
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return { noul: value };
  if (!isRecord(value)) return null;

  const answer: JevAnswerValue = {};
  // `noul` is this codebase's name for the native endpoint's probability; the
  // evaluation route answers a `boolean` question with `probability` or a plain
  // boolean, and all three mean the same thing here.
  const noul = probability(value.noul) ?? probability(value.probability);
  if (noul !== undefined) answer.noul = noul;
  else if (typeof value.boolean === "boolean") answer.noul = value.boolean ? 1 : 0;
  const score = probability(value.score);
  if (score !== undefined) answer.score = score;
  if (typeof value.choice === "string" && value.choice.trim()) answer.choice = value.choice.trim();
  const confidence = probability(value.confidence);
  if (confidence !== undefined) answer.confidence = confidence;
  if (isRecord(value.probabilities)) {
    const probabilities: Record<string, number> = {};
    for (const [name, raw] of Object.entries(value.probabilities)) {
      const parsed = probability(raw);
      if (parsed !== undefined) probabilities[name] = parsed;
    }
    answer.probabilities = probabilities;
  }

  return Object.keys(answer).length > 0 ? answer : null;
}

function probability(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function firstChoiceContent(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.choices) || envelope.choices.length === 0) return null;
  const choice = envelope.choices[0];
  if (!isRecord(choice)) return null;
  const message = isRecord(choice.message) ? choice.message : null;
  if (message && typeof message.content === "string") return message.content;
  if (typeof choice.text === "string") return choice.text;
  return null;
}

/** Models like to wrap JSON in a fenced block even when asked not to. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a status code usually means, so the fix is obvious from the message. */ const STATUS_HINTS: Record<
  number,
  string
> = {
  400: "the endpoint rejected the request",
  401: "the API key was rejected",
  402: "this endpoint requires billing or credits",
  403: "the key is not allowed to use this endpoint or model",
  404: "the endpoint URL or the model name is wrong",
  429: "rate limited",
};

/**
 * Turn a failed response into something a user can act on.
 *
 * Gateways answer with an envelope (`{"error":{"message":"…"}}` and friends),
 * so a raw `JSON.stringify` — or worse, a 200-character slice of one — hides the
 * only useful part. The provider's own message is kept (it names the missing
 * card, the wrong model, the expired key) and the status adds the direction.
 */
export function describeHttpFailure(status: number, body: string): string {
  const parts = [`HTTP ${status}`];
  const hint = STATUS_HINTS[status];
  if (hint) parts.push(hint);
  const detail = providerMessage(body);
  if (detail) parts.push(detail);
  return parts.join(" · ");
}

/** True when a failure looks like a rejected `response_format` parameter. */
function rejectsResponseFormat(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /response_format|json_object|unsupported parameter|not supported/i.test(body);
}

/** The human-readable message inside a provider error envelope. */
function providerMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  let text = trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const envelope = parsed as Record<string, unknown>;
      const error = envelope.error;
      const candidate =
        (error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined) ??
        (typeof error === "string" ? error : undefined) ??
        envelope.message ??
        envelope.detail;
      if (typeof candidate === "string" && candidate.trim()) text = candidate;
    }
  } catch {
    // Not JSON: the body itself is the message (a proxy's HTML error page, say).
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

/** A 5xx or a rate limit may pass on the next attempt; a 4xx will not. */
function isRetryable(failure: Extract<JevOutcome, { ok: false }>): boolean {
  if (failure.reason === "network" || failure.reason === "timeout") return true;
  if (failure.reason !== "http") return false;
  return failure.status === undefined || failure.status === 429 || failure.status >= 500;
}

function classifyThrown(error: unknown): Extract<JevOutcome, { ok: false }> {
  const name = (error as { name?: unknown } | null)?.name;
  const message = messageOf(error);
  if (name === "TimeoutError" || /timed out|timeout/i.test(message)) return { ok: false, reason: "timeout", message };
  if (name === "AbortError") return { ok: false, reason: "timeout", message };
  return { ok: false, reason: "network", message };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
