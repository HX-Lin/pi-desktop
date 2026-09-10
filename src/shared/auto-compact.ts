/**
 * Turn-count based auto-compaction.
 *
 * pi already compacts on token thresholds, but a long chat can accumulate many
 * small messages before that fires, which slows session reloads and dilutes the
 * model's attention. The desktop app additionally compacts once a session
 * reaches {@link AUTO_COMPACT_TURN_THRESHOLD} conversation turns, and surfaces
 * a manual control near the composer before that point.
 *
 * The unit is a **turn** (one message the user sent), not a raw message: a
 * single turn routinely produces dozens of assistant steps and tool results, so
 * counting messages made one exchange look like a hundred and compacted the
 * session almost immediately. {@link countBranchConversationMessages} is kept
 * for showing that raw figure alongside the turn count.
 */
export const AUTO_COMPACT_TURN_THRESHOLD = 50;

/** Bounds accepted from the Settings UI for the automatic compaction threshold. */
export const AUTO_COMPACT_TURNS_MIN = 5;
export const AUTO_COMPACT_TURNS_MAX = 200;

/** Host-side auto-compaction configuration, persisted across restarts. */
export interface AutoCompactSettings {
  /** Compact a chat once it reaches this many conversation turns. */
  autoCompactTurns: number;
}

/** Coerce an arbitrary value into a usable turn threshold. */
export function clampAutoCompactTurns(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return AUTO_COMPACT_TURN_THRESHOLD;
  return Math.min(AUTO_COMPACT_TURNS_MAX, Math.max(AUTO_COMPACT_TURNS_MIN, Math.round(numeric)));
}

/** Defaults applied when no settings file exists yet. */
export const AUTO_COMPACT_SETTINGS_DEFAULTS: AutoCompactSettings = {
  autoCompactTurns: AUTO_COMPACT_TURN_THRESHOLD,
};

/** Highlight the manual compaction control once the chat reaches this many turns. */
export const AUTO_COMPACT_HINT_TURNS = 30;

/** Minimal shape needed to count conversation messages in a UI list. */
interface ConversationMessageLike {
  role?: unknown;
}

/** Count user/assistant conversation messages in a UI message list. */
export function countConversationMessages(messages: readonly ConversationMessageLike[]): number {
  let count = 0;
  for (const message of messages) {
    if (message?.role === "user" || message?.role === "assistant") count += 1;
  }
  return count;
}

/**
 * Index of the first entry that still belongs to the active context.
 *
 * Everything before the latest compaction entry has been folded into memory, so
 * it must not keep inflating the counters.
 */
function activeContextStartIndex(entries: readonly unknown[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if ((entries[index] as { type?: unknown } | null)?.type === "compaction") return index + 1;
  }
  return 0;
}

/** Count the conversation turns (user messages) on a session branch. */
export function countBranchConversationTurns(entries: readonly unknown[]): number {
  let count = 0;
  for (let index = activeContextStartIndex(entries); index < entries.length; index += 1) {
    const record = entries[index] as { type?: unknown; message?: { role?: unknown } } | null;
    if (!record || record.type !== "message") continue;
    if (record.message?.role === "user") count += 1;
  }
  return count;
}

/**
 * Count conversation (user/assistant) messages on a session branch.
 *
 * Tool results and bookkeeping entries are excluded so the number reflects what
 * a user perceives as messages in the chat.
 */
export function countBranchConversationMessages(entries: readonly unknown[]): number {
  let count = 0;
  for (let index = activeContextStartIndex(entries); index < entries.length; index += 1) {
    const record = entries[index] as { type?: unknown; message?: { role?: unknown } } | null;
    if (!record || record.type !== "message") continue;
    const role = record.message?.role;
    if (role === "user" || role === "assistant") count += 1;
  }
  return count;
}
