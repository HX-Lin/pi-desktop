/**
 * Exposes the session's memory files to the model.
 *
 * `before_agent_start` fires on every user prompt, so both blocks are rebuilt
 * each turn:
 *
 * - the executable script index (what each script does, where to run it from)
 * - a pointer to the archived memory, which has sunk out of the context and is
 *   only reachable from disk
 *
 * The active memory itself needs no injection: it lives in the session as the
 * compaction entry the model already reads.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { memoryArchiveNotice, memoryScriptIndex } from "./memory-store";

export const MEMORY_SCRIPTS_EXTENSION: InlineExtension = {
  name: "MemoryScripts",
  factory: (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) return undefined;
      const blocks = [memoryScriptIndex(sessionId), memoryArchiveNotice(sessionId)].filter((block): block is string =>
        Boolean(block),
      );
      return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
    });
  },
};
