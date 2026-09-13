/**
 * Puts the vendored fold engine on pi's live wire.
 *
 * Registered as an inline extension on every desktop session, so the engine is
 * always observing the real context — even while folding is off, which is what
 * lets the map show the composition before the user arms anything.
 *
 * Two surfaces:
 *   - `context`   serialize the departing wire from the Truth when folding is armed
 *   - `unfold` / `recall`  the agent's own handles on folded content
 *
 * Folding is opt-in per session (`FoldSession.folding`), matching upstream: the
 * map is a viewer until the user turns it on.
 */
import { Type } from "typebox";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getFoldSession } from "./context-fold";
import type { PiMessage } from "./vendor/accordion/core/wire";

const FOLD_MARKER_HINT = "a `{#<code> FOLDED}` marker";

export const CONTEXT_FOLD_EXTENSION: InlineExtension = {
  name: "ContextFold",
  factory: (pi: ExtensionAPI) => {
    pi.on("context", (event, ctx) => {
      try {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (!sessionId) return undefined;
        const session = getFoldSession(sessionId);
        const messages = event.messages as unknown as PiMessage[];
        session.observe(messages, {
          contextWindow: ctx.model?.contextWindow,
          systemPrompt: readSystemPrompt(ctx),
        });
        const folded = session.serialize(messages);
        return folded ? { messages: folded as unknown as typeof event.messages } : undefined;
      } catch (error) {
        // A fold failure must never break a model call.
        console.error(
          "[pi-desktop] context fold hook failed; passing messages through:",
          error instanceof Error ? error.message : error,
        );
        return undefined;
      }
    });

    pi.registerTool(
      defineTool({
        name: "unfold",
        label: "Unfold Context",
        description:
          "Restore context that this app folded away to save tokens. Folded blocks appear in your context as a short summary tagged like " +
          `${FOLD_MARKER_HINT}. The original content is preserved, not lost. Call this with the code(s) from those tags to bring the full ` +
          "content back into your standing context (it returns on your next turn).",
        promptSnippet: `unfold(codes) — restore context folded by the desktop app (blocks tagged {#<code> FOLDED}).`,
        promptGuidelines: [
          `When you see ${FOLD_MARKER_HINT} in your context, that block was folded to save tokens — the full content is preserved. ` +
            "If the summary is not enough for the current step, call `unfold` with the code(s) from the marker(s).",
        ],
        parameters: Type.Object({
          codes: Type.Array(
            Type.String({
              description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c".',
            }),
            { description: "One or more fold codes to restore." },
          ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const codes = normalizeCodes(params.codes);
          if (codes.length === 0) {
            return textResult(`No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag.`);
          }
          const session = sessionFor(ctx);
          if (!session) return textResult("This session has no fold state, so nothing is folded.");
          const result = session.unfoldCodes(codes);
          const lines: string[] = [];
          if (result.restored.length > 0) {
            lines.push(`Unfolded ${result.restored.length} block(s); the full content returns on your next turn:`);
            for (const entry of result.restored) lines.push(`  • ${entry.label} (#${entry.code})`);
          }
          if (result.missing.length > 0) {
            lines.push(`No folded block for: ${result.missing.map((code) => `#${code}`).join(", ")}.`);
          }
          return textResult(lines.join("\n") || "Nothing to unfold.");
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "recall",
        label: "Recall Folded Content",
        description:
          "Read folded context WITHOUT changing what stands in your context. Folded blocks appear as a short summary tagged like " +
          `${FOLD_MARKER_HINT}; calling this returns the full original content as this tool's result, immediately, like reading a file. ` +
          "Prefer this when you need the detail once; use `unfold` when the block should stay open.",
        promptSnippet:
          "recall(codes) — read folded content now (as the tool result; your standing context is unchanged).",
        promptGuidelines: [
          `When you need the full content behind ${FOLD_MARKER_HINT} for the current step, call \`recall\` with the code(s).`,
        ],
        parameters: Type.Object({
          codes: Type.Array(Type.String({ description: "A fold code copied verbatim from a {#<code> FOLDED} tag." }), {
            description: "One or more fold codes to read.",
          }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const codes = normalizeCodes(params.codes);
          if (codes.length === 0) return textResult("No fold codes given.");
          const session = sessionFor(ctx);
          if (!session) return textResult("This session has no fold state, so nothing is folded.");
          const result = session.recallCodes(codes);
          const lines: string[] = [];
          for (const entry of result.restored) {
            lines.push(`#${entry.code} ${entry.label}`, "", entry.text, "");
          }
          if (result.missing.length > 0) {
            lines.push(`No folded block for: ${result.missing.map((code) => `#${code}`).join(", ")}.`);
          }
          return textResult(lines.join("\n").trim() || "Nothing to recall.");
        },
      }),
    );
  },
};

function sessionFor(ctx: { sessionManager?: { getSessionId?: () => string } }) {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  return sessionId ? getFoldSession(sessionId) : null;
}

function normalizeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter((code) => code.length > 0);
}

function readSystemPrompt(ctx: { getSystemPrompt?: () => string }): string | undefined {
  try {
    const prompt = ctx.getSystemPrompt?.();
    return typeof prompt === "string" ? prompt : undefined;
  } catch {
    return undefined;
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
