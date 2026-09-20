/**
 * Jev model routing on `before_agent_start`.
 *
 * A turn starts, Jev rates the request difficulty, and a confidently easy or
 * hard request switches model before the agent runs. Every other outcome — the
 * middle band, low confidence, a missing answer, a Jev failure, an unknown
 * model or missing auth — keeps the model the user picked.
 *
 * This is its **own mode** (`routing.mode: "jev"`), not a hidden override: the
 * app's manual model choice stays authoritative until the user turns the mode on,
 * and each switch is announced rather than silent.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getJevRuntime } from "../service";
import { readJevSettings, type JevSettings } from "../settings";
import { DIFFICULTY_LEVELS, decideRouting, routingQuestions, ROUTING_CONTEXT, type RoutingDecision } from "./decide";

/**
 * Ask Jev to rate the difficulty of one prompt.
 *
 * A failure throws: the caller keeps the current model, which is the only safe
 * direction for a routing mistake.
 */
export async function runRouting(prompt: string, settings: JevSettings): Promise<RoutingDecision | null> {
  const runtime = await getJevRuntime();
  if (!runtime) return null;
  const outcome = await runtime.client.ask({ context: ROUTING_CONTEXT, prompt }, routingQuestions() as never);
  if (!outcome.ok) throw new Error(`Jev unavailable (${outcome.reason})`);
  const score = outcome.judgment.answers.difficulty;
  return decideRouting(
    { difficulty: { score: score?.score ?? Number.NaN, confidence: score?.confidence ?? 0 } } as never,
    settings.routing,
  );
}

/**
 * Parse a `"provider/model-id"` reference, optionally with a `:thinking` suffix
 * (pi style, e.g. `deepseek/deepseek-flash:high`).
 */
export function parseModelRef(ref: string): { provider: string; id: string; thinking?: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const rest = ref.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    const thinking = rest.slice(colon + 1);
    if (thinking) return { provider: ref.slice(0, slash), id: rest.slice(0, colon), thinking };
  }
  return { provider: ref.slice(0, slash), id: rest };
}

/** True when routing should run at all for the current settings. */
export function jevRoutingActive(settings: JevSettings): boolean {
  if (!settings.enabled || settings.routing.mode !== "jev") return false;
  return Boolean(settings.routing.cheap || settings.routing.strong);
}

export const JEV_ROUTING_EXTENSION: InlineExtension = {
  name: "JevRouting",
  factory: (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        const settings = readJevSettings();
        if (!jevRoutingActive(settings)) return undefined;
        if (!event.prompt.trim()) return undefined;

        const decision = await runRouting(event.prompt, settings);
        if (!decision?.target) return undefined;

        const reference = decision.target === "cheap" ? settings.routing.cheap : settings.routing.strong;
        if (!reference) return undefined;
        const ref = parseModelRef(reference);
        if (!ref) {
          ctx.ui.notify(`jev routing: invalid target reference "${reference}"`, "warning");
          return undefined;
        }

        const model = ctx.modelRegistry.find(ref.provider, ref.id) as
          { id: string; provider: string; input?: readonly string[] } | undefined;
        if (!model) {
          ctx.ui.notify(`jev routing: ${ref.provider}/${ref.id} not found — keeping the current model`, "warning");
          return undefined;
        }
        if (ctx.model && ctx.model.id === model.id && ctx.model.provider === model.provider) return undefined;
        // Never route an image prompt to a text-only model.
        if (decision.target === "cheap" && (event.images?.length ?? 0) > 0 && !(model.input ?? []).includes("image")) {
          return undefined;
        }

        const switched = await pi.setModel(model as never);
        if (!switched) {
          ctx.ui.notify(
            `jev routing: auth not configured for ${ref.provider}/${ref.id} — keeping the current model`,
            "warning",
          );
          return undefined;
        }
        if (ref.thinking) pi.setThinkingLevel(ref.thinking as never);

        const thinking = settings.routing.cheapThinking;
        const label = decision.target === "cheap" && thinking ? `${reference}:${thinking}` : reference;
        ctx.ui.notify(
          `jev routing: ${decision.reason} request (difficulty ${decision.levels.toFixed(1)}/${DIFFICULTY_LEVELS.length - 1}, ` +
            `confidence ${(decision.confidence * 100).toFixed(0)}%) → ${label}`,
          "info",
        );
        return undefined;
      } catch (error) {
        ctx.ui.notify(
          `jev routing failed (${error instanceof Error ? error.message : String(error)}) — keeping the current model`,
          "error",
        );
        return undefined;
      }
    });
  },
};
