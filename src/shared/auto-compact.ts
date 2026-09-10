/**
 * Message-count based auto-compaction.
 *
 * pi already compacts on token thresholds, but a long chat can accumulate many
 * small messages before that fires, which slows session reloads and dilutes the
 * model's attention. The desktop app additionally compacts once a session
 * reaches {@link AUTO_COMPACT_MESSAGE_THRESHOLD} conversation messages, and
 * surfaces a manual control near the composer before that point.
 */
export const AUTO_COMPACT_MESSAGE_THRESHOLD = 200;

/** Show the manual compaction prompt once the chat reaches this many messages. */
export const AUTO_COMPACT_HINT_THRESHOLD = 120;

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
