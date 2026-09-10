/**
 * Message-count based auto-compaction.
 *
 * pi already compacts on token thresholds, but a long chat can accumulate many
 * small messages before that fires, which slows session reloads and dilutes the
 * model's attention. The desktop app additionally compacts once a session
 * reaches {@link AUTO_COMPACT_MESSAGE_THRESHOLD} conversation messages, and
 * surfaces a manual control near the composer before that point.
 */
export const AUTO_COMPACT_MESSAGE_THRESHOLD = 50;

/** Show the manual compaction prompt once the chat reaches this many messages. */
export const AUTO_COMPACT_HINT_THRESHOLD = 30;

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
 * Count conversation (user/assistant) messages on a session branch.
 *
 * Counting starts after the latest compaction entry: once history has been
 * summarized into memory those old messages are no longer part of the active
 * context, so they must not keep the session above the auto-compaction
 * threshold forever. Tool results and bookkeeping entries are excluded so the
 * number matches what a user perceives as "messages in this chat".
 */
export function countBranchConversationMessages(entries: readonly unknown[]): number {
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if ((entries[index] as { type?: unknown } | null)?.type === "compaction") {
      start = index + 1;
      break;
    }
  }
  let count = 0;
  for (let index = start; index < entries.length; index += 1) {
    const record = entries[index] as { type?: unknown; message?: { role?: unknown } } | null;
    if (!record || record.type !== "message") continue;
    const role = record.message?.role;
    if (role === "user" || role === "assistant") count += 1;
  }
  return count;
}
