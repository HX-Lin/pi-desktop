/**
 * Jev compaction on pi's own compaction hook.
 *
 * Pi asks extensions before it compacts. When this runs, the summary is not an
 * LLM rewrite of the whole span but a **verbatim transcript** with the obsolete
 * tool calls removed and their long results bounded — Jev only answers "does
 * this still matter" and "how stale is it", which is what keeps the context
 * cheap without losing the text.
 *
 * Scope, deliberately narrow:
 *
 * - only pi's own compaction (the threshold pass, overflow recovery, or a bare
 *   `/compact`). This app's own "压缩为记忆" passes the distillation prompt as
 *   `customInstructions`, and that is the discriminator: the memory path always
 *   has instructions, so it never reaches this handler.
 * - any failure, abort, empty span or insufficient reduction returns `undefined`,
 *   which leaves pi's default summary in place. Jev is never allowed to make
 *   compaction worse.
 */
import type { ExtensionAPI, InlineExtension, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateTokens, goalFromMessages, type JevAsker, type JevResponse } from "../../vendor/jev/index";
import { readJevSettings, type JevCompactionSettings, type JevSettings } from "../settings";
import { getJevRuntime, type JevRuntime } from "../service";
import { convertMessages, type PiSpanMessage } from "./convert";
import { compactWithJev, type JevCompactionStats } from "./run";
import { renderSummary, renderTranscript } from "./summarize";

/** The slice of pi's `session_before_compact` event this handler needs. */
export interface CompactionSpanInput {
  messagesToSummarize: readonly PiSpanMessage[];
  turnPrefixMessages: readonly PiSpanMessage[];
  previousSummary?: string;
  customInstructions?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface JevDetails {
  engine: "jev";
  stats: JevCompactionStats;
  decisions: Array<{
    id: string;
    tool: string;
    action: string;
    reason: string;
    keepCall: number;
    keepResult: number;
  }>;
}

export type JevCompactionRun =
  | {
      ok: true;
      compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter: number;
        usage?: Usage;
        details: JevDetails;
      };
      reduction: number;
    }
  | { ok: false; reason: "empty-span" | "low-reduction"; reduction: number };

/**
 * Bridge our transport to the shape the vendored compaction code expects: an
 * asker that throws on failure, which is how it expresses "fall back to pi".
 */
export function asJevAsker(runtime: JevRuntime): JevAsker {
  return {
    async ask(state, questions): Promise<JevResponse> {
      const outcome = await runtime.client.ask(state, questions as never);
      if (!outcome.ok) {
        throw new Error(`Jev unavailable (${outcome.reason})${outcome.message ? `: ${outcome.message}` : ""}`);
      }
      // Missing answers stay missing: the decision code keeps those calls.
      return { model: outcome.judgment.model, answers: outcome.judgment.answers as never, usage: undefined };
    },
  };
}

function toUsage(jev: { input: number; output: number }): Usage {
  const total = jev.input + jev.output;
  return {
    input: jev.input,
    output: jev.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Core pipeline, kept free of pi so tests drive it with a fake asker:
 * convert the span, ask Jev what still matters, render the survivors verbatim.
 */
export async function runJevCompaction(
  input: CompactionSpanInput,
  asker: JevAsker,
  config: JevCompactionSettings,
): Promise<JevCompactionRun> {
  const span = [...input.messagesToSummarize, ...input.turnPrefixMessages];
  const converted = convertMessages(span);
  if (converted.length === 0) return { ok: false, reason: "empty-span", reduction: 0 };

  const goal = input.customInstructions?.trim() || goalFromMessages(converted);
  const outcome = await compactWithJev(converted, asker, config, goal);

  const summary = renderSummary(outcome.messages, {
    goal,
    previousSummary: input.previousSummary,
    droppedCalls: outcome.stats.callsDropped,
    truncatedResults: outcome.stats.resultsDropped,
  });

  // One consistent unit on both sides: the same renderer sizes the original and
  // the compacted span, so the reduction ratio is not an apples-to-oranges guess.
  const spanTokens = estimateTokens(renderTranscript(converted));
  const keptTokens = estimateTokens(renderTranscript(outcome.messages));
  const summaryTokens = estimateTokens(summary);
  const reduction = spanTokens === 0 ? 0 : 1 - keptTokens / spanTokens;
  if (reduction < config.minReduction) return { ok: false, reason: "low-reduction", reduction };

  return {
    ok: true,
    reduction,
    compaction: {
      summary,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      estimatedTokensAfter: Math.max(summaryTokens, input.tokensBefore - spanTokens + summaryTokens),
      usage: outcome.stats.jevUsage ? toUsage(outcome.stats.jevUsage) : undefined,
      details: {
        engine: "jev",
        stats: outcome.stats,
        decisions: outcome.decisions.map((decision) => ({
          id: decision.id,
          tool: decision.tool,
          action: decision.action,
          reason: decision.reason,
          keepCall: decision.keepCall,
          keepResult: decision.keepResult,
        })),
      },
    },
  };
}

/**
 * True when a compaction belongs to this app's memory path rather than to
 * pi's own context compaction. The memory path always carries the distillation
 * prompt; everything else is pi's.
 */
export function isMemoryCompaction(customInstructions: unknown): boolean {
  return typeof customInstructions === "string" && customInstructions.trim().length > 0;
}

export function jevCompactionActive(settings: JevSettings = readJevSettings()): boolean {
  return settings.enabled && settings.compaction.enabled;
}

export const JEV_COMPACTION_EXTENSION: InlineExtension = {
  name: "JevCompaction",
  factory: (pi: ExtensionAPI) => {
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        if (!jevCompactionActive()) return undefined;
        // The memory path sets instructions; this handler is only for pi's own
        // context compaction.
        if (isMemoryCompaction(event.customInstructions)) return undefined;
        if (event.signal?.aborted) return undefined;

        const runtime = await getJevRuntime();
        if (!runtime) return undefined;

        const run = await raceAbort(
          runJevCompaction(spanOf(event), asJevAsker(runtime), runtime.settings.compaction),
          event.signal,
        );
        if (!run.ok) {
          if (run.reason === "low-reduction") {
            ctx.ui.notify(
              `jev compaction: only ${(run.reduction * 100).toFixed(0)}% reduction — using pi's summary`,
              "warning",
            );
          }
          return undefined;
        }

        const stats = run.compaction.details.stats;
        ctx.ui.notify(
          `jev compaction: ${stats.calls} calls scored — kept ${stats.kept}, truncated ${stats.resultsDropped}, ` +
            `dropped ${stats.callsDropped} (${stats.requests} Jev request(s), ${(run.reduction * 100).toFixed(0)}% smaller, ${stats.ms} ms)`,
          "info",
        );
        return { compaction: run.compaction };
      } catch (error) {
        if (event.signal?.aborted) return undefined;
        ctx.ui.notify(
          `jev compaction failed (${error instanceof Error ? error.message : String(error)}) — using pi's summary`,
          "error",
        );
        return undefined;
      }
    });
  },
};

function spanOf(event: SessionBeforeCompactEvent): CompactionSpanInput {
  const preparation = event.preparation;
  // pi's own message union is richer than the fields this conversion reads
  // (branch summaries, custom entries, media blocks); the read is by shape, so
  // the structural view is asserted here rather than narrowing every consumer.
  const span = preparation as unknown as {
    messagesToSummarize: readonly PiSpanMessage[];
    turnPrefixMessages: readonly PiSpanMessage[];
  };
  return {
    messagesToSummarize: span.messagesToSummarize,
    turnPrefixMessages: span.turnPrefixMessages,
    ...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
    ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
  };
}

/** A cancellation is control flow, not a compaction result. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
