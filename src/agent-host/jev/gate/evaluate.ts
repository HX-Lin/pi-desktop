/**
 * The gate's orchestration: decide one tool call.
 *
 * Ported from pi-jev-auto-mode's `src/extension.ts` (`evaluateToolCall` and its
 * helpers), with pi's runtime replaced by an injected context so the whole path
 * is testable without a session. The layer order is the upstream one and is the
 * safety contract:
 *
 *   1. a hard-deny shape is blocked and never handed to Jev;
 *   2. user allow/deny patterns;
 *   3. user-declared safe commands;
 *   4. dangerous shapes, then read-only, then `scope: all` for the rest;
 *   5. only what survives that is judged semantically, and anything that cannot
 *      be judged is blocked.
 *
 * The scope here is deliberately app-wide: the gate guards every session this
 * app runs, including channel-driven ones. A channel session has no dialog, so
 * `uncertain: ask` degrades to a block there (see `hasUI`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildGatedCall, type GatedCall, type RepoFacts, type ToolCallEventLike } from "./call";
import type { CandidateInput, ConditionReport, DecisionEngine, EngineEvidence, EngineVerdict } from "./decide";
import {
  PROTECTED_DIRECTORY_SEGMENTS,
  dangerousReasons,
  evaluateUserCommandRules,
  hardDenyReasons,
  isReadOnlyCommandChain,
  isUserDeclaredSafeCommand,
  unique,
} from "./policy";
import { extractRecentIntent } from "./intent";
import type { DecisionRecord } from "./record";

/** The scope's own label for "nothing vouches for this call". */
export const NOT_KNOWN_SAFE_REASON = "not on the known-safe list";

/** The engine used when no semantic layer is available. */
export const MANUAL_ENGINE_ID = "manual";

/** Shown (and used as the block reason) when the gate has no Jev connection. */
export const NO_ENGINE_MESSAGE =
  "Not connected to Jev (no key configured for the selected channel). Set a key in Settings → Jev, or switch the gate off.";

export interface GateSettings {
  enabled: boolean;
  scope: "all" | "matched";
  uncertain: "deny" | "ask" | "allow";
  safeCommands: readonly string[];
  allowedCommands: readonly string[];
  disallowedCommands: readonly string[];
  extraProtectedPaths: readonly string[];
  policyNotes: string;
}

/** What this orchestration needs from its host, and nothing more. */
export interface GateContext {
  cwd: string;
  /** False in a channel/background session: no dialog can be raised there. */
  hasUI: boolean;
  signal?: AbortSignal;
  /** Session branch entries, for the intent question. */
  branch: readonly unknown[];
  confirm?: (dialog: { title: string; message: string }) => Promise<boolean>;
}

export interface DecisionDeps {
  engine: DecisionEngine;
  record: (record: DecisionRecord) => void;
  now: () => number;
}

export interface BlockResult {
  block: true;
  reason: string;
}

interface RecordInput {
  call: GatedCall;
  reasons: readonly string[];
  status: DecisionRecord["status"];
  source: DecisionRecord["source"];
  rationale: string;
  evidence?: EngineEvidence;
}

function writeRecord(deps: DecisionDeps, input: RecordInput): void {
  const record: DecisionRecord = {
    tool: input.call.tool,
    summary: input.call.summary,
    reasons: [...input.reasons],
    status: input.status,
    source: input.source,
    rationale: input.rationale,
    ...(input.evidence?.conditions ? { conditions: input.evidence.conditions } : {}),
    ...(input.evidence?.decidingRule ? { decidingRule: input.evidence.decidingRule } : {}),
    ...(input.evidence?.clearedByIntent ? { clearedByIntent: input.evidence.clearedByIntent } : {}),
    ...(input.evidence?.probabilities ? { probabilities: input.evidence.probabilities } : {}),
    ...(input.evidence?.model ? { model: input.evidence.model } : {}),
    ...(input.evidence?.latencyMs !== undefined ? { latencyMs: input.evidence.latencyMs } : {}),
    timestamp: deps.now(),
  };
  deps.record(record);
}

function blocked(deps: DecisionDeps, input: RecordInput, reason?: string): BlockResult {
  writeRecord(deps, input);
  return { block: true, reason: reason ?? input.rationale };
}

function permit(deps: DecisionDeps, input: RecordInput): undefined {
  writeRecord(deps, input);
  return undefined;
}

/** Wraps an engine rationale so the model gets an actionable reason, not a verdict. */
function blockReason(rationale: string): string {
  return `Jev auto mode blocked this tool call. ${rationale} Do not repeat the same call unchanged; change the approach or ask the user.`;
}

/** Structural context: the concrete protection plus the configured roots. */
export function repoFacts(cwd: string, call?: GatedCall): RepoFacts {
  const protectedPaths = unique([
    ...PROTECTED_DIRECTORY_SEGMENTS,
    ...(call?.protectedReason ? [call.protectedReason] : []),
  ]);
  return {
    cwd,
    isGitRepository: existsSync(join(cwd, ".git")),
    protectedPaths,
  };
}

/**
 * Decide one tool call.
 *
 * Returns `undefined` to let the call run, or a block result. Exported so the
 * whole policy path is tested without a session.
 */
export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: GateContext,
  settings: GateSettings,
  deps: DecisionDeps,
): Promise<BlockResult | undefined> {
  if (!settings.enabled) return undefined;

  const call = buildGatedCall(event, {
    cwd: ctx.cwd,
    extraProtectedPaths: settings.extraProtectedPaths,
  });
  if (!call) return undefined;

  const ruleConfig = {
    allowedCommands: settings.allowedCommands,
    disallowedCommands: settings.disallowedCommands,
  };

  let reasons: string[];

  if (call.tool === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";

    const hardReasons = hardDenyReasons(command);
    if (hardReasons.length > 0) {
      const rationale = `Non-negotiable safety rule matched: ${hardReasons.join(", ")}.`;
      return blocked(deps, { call, reasons: hardReasons, status: "blocked", source: "hard-deny", rationale });
    }

    const userRule = evaluateUserCommandRules(command, ruleConfig);
    if (userRule?.decision === "deny") {
      const rationale = `A user disallowed command pattern matched: ${userRule.pattern}.`;
      return blocked(deps, { call, reasons: [userRule.pattern], status: "blocked", source: "user-rule", rationale });
    }
    if (userRule?.decision === "allow") {
      return permit(deps, {
        call,
        reasons: [],
        status: "allowed",
        source: "user-rule",
        rationale: `A user allow pattern matched: ${userRule.pattern}.`,
      });
    }

    // A command the user declared safe is theirs to declare: it runs silently, and
    // that declaration also outranks a dangerous-pattern match.
    if (isUserDeclaredSafeCommand(command, settings.safeCommands)) return undefined;

    // A dangerous pattern is a reason to judge even when the command looks like
    // reading (`grep secret ~/.ssh/...`), so it comes before the read-only fast path.
    const matchedReasons = dangerousReasons(command, ctx.cwd);
    if (matchedReasons.length > 0) {
      reasons = matchedReasons;
    } else if (isReadOnlyCommandChain(command)) {
      return undefined;
    } else if (settings.scope === "matched") {
      return undefined;
    } else {
      reasons = [NOT_KNOWN_SAFE_REASON];
    }
  } else {
    const protectedReasons = unique(
      [call.protectedReason, call.outsideCwd ? "write outside the working directory" : undefined].filter(
        (reason): reason is string => typeof reason === "string",
      ),
    );
    if (protectedReasons.length === 0) return undefined;
    reasons = protectedReasons;
  }

  // Without an engine there is nothing to judge with. Say so and stop, rather than
  // letting a call through unjudged or blocking it with an unexplained verdict.
  if (deps.engine.id === MANUAL_ENGINE_ID) {
    writeRecord(deps, { call, reasons, status: "blocked", source: "unavailable", rationale: NO_ENGINE_MESSAGE });
    return { block: true, reason: NO_ENGINE_MESSAGE };
  }

  const input: CandidateInput = {
    call,
    reasons,
    // "not on the known-safe list" is the scope's own label, not a recognised danger.
    flagged: reasons.some((reason) => reason !== NOT_KNOWN_SAFE_REASON),
    intent: extractRecentIntent(ctx.branch),
    policy: settings.policyNotes,
    repo: repoFacts(ctx.cwd, call),
  };

  let verdict: EngineVerdict;
  try {
    verdict = await deps.engine.judge(input, { signal: ctx.signal });
  } catch {
    // An engine that throws is an engine that cannot decide. Fail closed.
    verdict = {
      verdict: "unavailable",
      reason: "engine_error",
      rationale: "The decision engine threw an error.",
    };
  }

  if (ctx.signal?.aborted) {
    return blocked(deps, {
      call,
      reasons,
      status: "blocked",
      source: "unavailable",
      rationale: "The request was cancelled before a decision was reached.",
    });
  }

  const evidence: EngineEvidence = {
    ...(verdict.probabilities ? { probabilities: verdict.probabilities } : {}),
    ...(verdict.thresholds ? { thresholds: verdict.thresholds } : {}),
    ...(verdict.conditions ? { conditions: verdict.conditions } : {}),
    ...(verdict.decidingRule ? { decidingRule: verdict.decidingRule } : {}),
    ...(verdict.clearedByIntent ? { clearedByIntent: verdict.clearedByIntent } : {}),
    ...(verdict.model ? { model: verdict.model } : {}),
    ...(verdict.latencyMs !== undefined ? { latencyMs: verdict.latencyMs } : {}),
  };

  switch (verdict.verdict) {
    case "allow":
      return permit(deps, {
        call,
        reasons,
        status: "allowed",
        source: "engine",
        rationale: verdict.rationale,
        evidence,
      });

    case "deny":
      return blocked(
        deps,
        { call, reasons, status: "blocked", source: "engine", rationale: verdict.rationale, evidence },
        blockReason(verdict.rationale),
      );

    case "unavailable": {
      const rationale = `No decision was available (${verdict.reason}): ${verdict.rationale}`;
      return blocked(
        deps,
        { call, reasons, status: "blocked", source: "unavailable", rationale, evidence },
        blockReason(rationale),
      );
    }

    case "uncertain": {
      // The middle band is a policy decision, not a prompt by default. An auto mode
      // that stops to ask the user has handed the decision back to the human, and
      // the agent can always ask in conversation if it needs guidance.
      if (settings.uncertain === "deny") {
        const rationale = `No condition decided the call, and the uncertain band is resolved to a block. ${verdict.rationale}`;
        return blocked(deps, { call, reasons, status: "blocked", source: "uncertain", rationale, evidence });
      }

      if (settings.uncertain === "allow") {
        return permit(deps, {
          call,
          reasons,
          status: "allowed",
          source: "uncertain",
          rationale: `No condition was violated and the uncertain band is configured to allow. ${verdict.rationale}`,
          evidence,
        });
      }

      // `ask` without a dialog (a channel session, or a background turn) blocks:
      // there is nobody to confirm, and silence must not mean yes.
      if (!ctx.hasUI || !ctx.confirm) {
        const rationale = `${verdict.rationale} No dialog is available in this session, so the call was blocked.`;
        return blocked(
          deps,
          { call, reasons, status: "blocked", source: "no-ui", rationale, evidence },
          blockReason(rationale),
        );
      }

      const confirmed = await ctx.confirm({
        title: "Jev auto mode",
        message: `${call.summary}\n\n${verdict.rationale}`,
      });
      if (!confirmed) {
        writeRecord(deps, {
          call,
          reasons,
          status: "cancelled",
          source: "user",
          rationale: "The user declined the confirmation.",
          evidence,
        });
        return { block: true, reason: "Blocked by the user at the Jev auto mode confirmation." };
      }

      return permit(deps, {
        call,
        reasons,
        status: "confirmed",
        source: "user",
        rationale: "The user confirmed the call.",
        evidence,
      });
    }
  }
}

export type { ConditionReport, ToolCallEventLike };
