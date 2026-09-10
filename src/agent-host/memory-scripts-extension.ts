/**
 * Exposes the session's executable memory scripts to the model.
 *
 * `before_agent_start` fires on every user prompt, so the index is rebuilt each
 * turn: the model always knows which scripts exist, what each one does and where
 * to run it from, while the script bodies stay on disk and out of the context.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { memoryScriptIndex } from "./memory-store";

export const MEMORY_SCRIPTS_EXTENSION: InlineExtension = {
  name: "MemoryScripts",
  factory: (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${memoryScriptIndex(sessionId)}` };
    });
  },
};
