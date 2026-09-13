/**
 * The local half of "压缩为记忆".
 *
 * pi writes the distilled summary into a compaction entry; everything after that
 * is decided here, in one place, so the pipeline is readable and testable:
 *
 *   1. facts      — deterministic ground truth for the span being folded away
 *   2. scripts    — reusable procedures the model handed back as executables
 *   3. retention  — archive the raw entries before anything is deleted
 *   4. tiering    — keep the memory within its cap, sinking the oldest part
 *   5. gate       — only actually delete history when it is safe and worthwhile
 *
 * Steps 1-4 always run (the memory file is the durable copy). Step 5 decides
 * whether the session file is rewritten, which is the only destructive action.
 */
import { archiveSessionEntries } from "./memory-archive";
import { applyFactAppendix, extractConversationFacts, type ConversationFacts } from "./memory-facts";
import { sedimentMemoryScripts } from "./memory-prompt";
import { syncSessionMemory } from "./memory-store";

/**
 * Delete history only when the distilled memory is substantial enough to stand
 * in for it. A near-empty summary means the model produced nothing usable.
 */
export const MEMORY_PRUNE_MIN_TEXT_CHARS = 200;

/**
 * ...and only when the span being removed is actually worth removing. Rewriting
 * the session file to drop a handful of small entries buys nothing.
 */
export const MEMORY_PRUNE_MIN_BYTES = 64 * 1024;

export type MemorySkipReason = "memory-too-short" | "span-too-small" | "archive-failed";

export interface MemoryCompactionPlan {
  /** Memory text to store: capped, with the fact appendix and script list. */
  memory: string;
  /** True when the caller may delete the summarized entries from the session. */
  prune: boolean;
  skipReason?: MemorySkipReason;
  facts: ConversationFacts;
  /** Raw bytes of the span that would be removed. */
  spanBytes: number;
  archived?: { path: string; entries: number; bytes: number; swept: number };
}

export interface PlanMemoryCompactionParams {
  sessionId: string;
  /** Summary pi generated for this compaction. */
  memory: string;
  /** Entries that will leave the context if this compaction prunes. */
  dropped: readonly unknown[];
  reason: string;
  now?: number;
}

/**
 * Enrich, persist and authorize one memory compaction.
 *
 * The memory file is always brought up to date; `prune` is the caller's
 * permission slip for the destructive session rewrite.
 */
export function planMemoryCompaction(params: PlanMemoryCompactionParams): MemoryCompactionPlan {
  const facts = extractConversationFacts(params.dropped);
  const withScripts = sedimentMemoryScripts(params.sessionId, params.memory);
  const enriched = applyFactAppendix(withScripts, facts);
  const { primary } = syncSessionMemory(params.sessionId, enriched);

  // Bookkeeping entries are replaced rather than lost, so they must not count as
  // "history worth deleting" — otherwise a large memory alone would authorize it.
  const spanBytes = byteLength(params.dropped.filter((entry) => !isCompactionEntry(entry)));
  const plan: MemoryCompactionPlan = { memory: primary, prune: false, facts, spanBytes };

  // Gate on what the model distilled, not on the enriched text: our own fact
  // appendix would otherwise be enough to authorize deleting history.
  if (params.memory.trim().length < MEMORY_PRUNE_MIN_TEXT_CHARS) {
    plan.skipReason = "memory-too-short";
    return plan;
  }
  if (params.dropped.length === 0 || spanBytes < MEMORY_PRUNE_MIN_BYTES) {
    plan.skipReason = "span-too-small";
    return plan;
  }

  const archived = archiveSessionEntries(params.dropped, {
    sessionId: params.sessionId,
    reason: params.reason,
    memoryChars: primary.length,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  if (!archived) {
    // Losing the summary is recoverable; losing raw history is not.
    plan.skipReason = "archive-failed";
    return plan;
  }

  plan.prune = true;
  plan.archived = archived;
  return plan;
}

function isCompactionEntry(entry: unknown): boolean {
  return (entry as { type?: unknown } | null)?.type === "compaction";
}

function byteLength(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    try {
      total += Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
    } catch {
      // Unserializable entry — it cannot be archived either, so it does not count.
    }
  }
  return total;
}
