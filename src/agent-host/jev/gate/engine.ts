/**
 * The Jev decision engine behind the gate.
 *
 * Ported from pi-jev-auto-mode's `src/jev/engine.ts`: one tool call in, one
 * request out, every condition carried in the same request. Everything that can
 * go wrong resolves to `unavailable`, which the gate turns into a block — the
 * engine never invents an approval.
 *
 * The transport is this app's Jev client (channels, vault keys, chat/decisions
 * protocols), so the gate shares one configuration with the compaction and the
 * routing instead of carrying its own SDK and key handling.
 */
import type { CandidateInput, DecisionEngine, EngineVerdict } from "./decide";
import { toJevState, NO_POLICY_PLACEHOLDER } from "./call";
import { combine, observe, type Observation } from "./verdict";
import { applyThresholdOverrides, buildQuestions, rulesForTool, DEFAULT_RULES, type JevRule } from "./questions";
import type { JevRuntime } from "../service";

export interface ObservationMeta {
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevGateEngineOptions {
  runtime: JevRuntime;
  rules?: readonly JevRule[];
  /** Per-rule threshold overrides from settings. */
  thresholds?: Readonly<Record<string, number>>;
  /** Shared state + questions budget, in characters. */
  maxStateCharacters?: number;
  /** Called for every condition of every judgment, including the ones that passed. */
  onObservation?: (observations: readonly Observation[], meta: ObservationMeta) => void;
}

export const DEFAULT_MAX_STATE_CHARACTERS = 120_000;

const UNAVAILABLE_TEXT: Record<string, string> = {
  timeout: "the Jev request timed out",
  network: "the Jev request could not reach the API",
  http: "the Jev API returned an error status",
  malformed_response: "the Jev response did not match the questions that were asked",
  state_too_large: "the call description exceeded the request budget",
  cancelled: "the Jev request was cancelled",
  unknown: "the Jev request failed for an unknown reason",
};

function unavailable(reason: string, rationale?: string): EngineVerdict {
  return {
    verdict: "unavailable",
    reason,
    rationale: rationale ?? UNAVAILABLE_TEXT[reason] ?? UNAVAILABLE_TEXT.unknown,
  };
}

export function createJevGateEngine(options: JevGateEngineOptions): DecisionEngine {
  const baseRules = options.rules ?? DEFAULT_RULES;
  const maxStateCharacters = options.maxStateCharacters ?? DEFAULT_MAX_STATE_CHARACTERS;

  return {
    id: "jev",
    async judge(input: CandidateInput, judgeOptions: { signal?: AbortSignal }): Promise<EngineVerdict> {
      const rules = applyThresholdOverrides(
        rulesForTool(input.call.tool, baseRules, {
          hasPolicy: input.policy.trim().length > 0 && input.policy !== NO_POLICY_PLACEHOLDER,
          hasProtectedTarget: Boolean(input.call.protectedReason),
          reasons: input.reasons,
          flagged: input.flagged,
        }),
        options.thresholds ?? {},
      );
      if (rules.length === 0) {
        return { verdict: "uncertain", rationale: "No condition applied to this call." };
      }

      const state = toJevState({
        call: input.call,
        reasons: input.reasons,
        intent: input.intent,
        policy: input.policy,
        repo: input.repo,
      });
      const encodedState = JSON.stringify(state);
      if (encodedState.length > maxStateCharacters) {
        return unavailable("state_too_large", `The call description was ${encodedState.length} characters.`);
      }

      const questions = buildQuestions(rules);
      const started = Date.now();
      const outcome = await options.runtime.client.ask(state, questions as never, judgeOptions);
      const latencyMs = Date.now() - started;

      if (!outcome.ok) {
        return unavailable(outcome.reason, outcome.message);
      }
      if (outcome.judgment.missing.length > 0) {
        // A condition that was asked and not answered cannot be treated as
        // satisfied: that is the difference between "no answer" and "yes".
        return unavailable("malformed_response", `No usable answer for: ${outcome.judgment.missing.join(", ")}.`);
      }

      const probabilities: Record<string, number> = {};
      for (const [key, answer] of Object.entries(outcome.judgment.answers)) {
        if (typeof answer.noul === "number") probabilities[key] = answer.noul;
      }

      const observations = observe(rules, probabilities);
      options.onObservation?.(observations, {
        model: outcome.judgment.model,
        latencyMs,
        inputTokens: outcome.judgment.inputTokens,
        outputTokens: outcome.judgment.outputTokens,
      });

      const decision = combine(rules, observations);
      return { ...decision, model: outcome.judgment.model, latencyMs };
    },
  };
}
