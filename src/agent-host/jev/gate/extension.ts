/**
 * The gate on pi's `tool_call` hook.
 *
 * Every session this app runs is guarded: interactive, background and
 * channel-driven. Two host details differ from upstream and are deliberate:
 *
 * - the key and channel come from this app's Jev settings (vault-backed), so the
 *   gate shares one configuration with the compaction and the routing;
 * - `uncertain: ask` uses the app's dialog when one is available and blocks when
 *   it is not (a channel session has nobody to confirm), instead of assuming a UI.
 *
 * Records go into the session as a custom entry (`appendCustomEntry`) so they
 * never reach the model, and the transcript renders them.
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createJevGateEngine } from "./engine";
import { createManualEngine, type DecisionEngine } from "./decide";
import { DECISION_ENTRY_TYPE, type DecisionRecord } from "./record";
import { evaluateToolCall, type GateContext, type GateSettings } from "./evaluate";
import { getJevRuntime } from "../service";
import { readJevSettings, type JevGateSettings } from "../settings";

export function gateSettingsToSettings(gate: JevGateSettings, policyNotes: string): GateSettings {
  return {
    enabled: gate.enabled,
    scope: gate.scope,
    uncertain: gate.uncertain,
    safeCommands: gate.safeCommands,
    allowedCommands: gate.allowedCommands,
    disallowedCommands: gate.disallowedCommands,
    extraProtectedPaths: gate.extraProtectedPaths,
    policyNotes,
  };
}

export const JEV_GATE_EXTENSION: InlineExtension = {
  name: "JevGate",
  factory: (pi: ExtensionAPI) => {
    /** Rebuilt when the settings change, so a toggle applies on the next call. */
    let engineCache: { key: string; engine: DecisionEngine } | null = null;
    let statusText: string | null = null;

    const engineFor = async (): Promise<DecisionEngine> => {
      const settings = readJevSettings();
      const key = `${settings.enabled}|${settings.channel}|${settings.gate.enabled}|${settings.model ?? ""}|${settings.baseUrl ?? ""}`;
      if (engineCache?.key === key) return engineCache.engine;
      const runtime = settings.gate.enabled ? await getJevRuntime() : null;
      if (!runtime || runtime.channel.id === undefined) {
        // No key: the gate keeps running its deterministic layer and blocks what
        // nothing vouches for, rather than silently allowing everything.
        const engine = createManualEngine();
        engineCache = { key, engine };
        return engine;
      }
      const engine = createJevGateEngine({
        runtime,
        thresholds: settings.gate.thresholds,
      });
      engineCache = { key, engine };
      return engine;
    };

    const refreshStatus = (ctx: ExtensionContext, settings = readJevSettings()): void => {
      if (!settings.gate.enabled) {
        if (statusText !== null) {
          ctx.ui.setStatus("jev", undefined);
          statusText = null;
        }
        return;
      }
      const text = `🛡 jev (${settings.gate.scope})`;
      if (text !== statusText) {
        ctx.ui.setStatus("jev", text);
        statusText = text;
      }
    };

    pi.on("session_start", (_event, ctx) => {
      engineCache = null;
      refreshStatus(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
      const settings = readJevSettings();
      if (!settings.enabled || !settings.gate.enabled) return undefined;

      const gateContext: GateContext = {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI === true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        branch: (ctx.sessionManager?.getBranch?.() ?? []) as readonly unknown[],
        confirm: async (dialog) => {
          // Reuse the app's extension dialog: `select` renders as a confirmation
          // in the desktop renderer and as a prompt in the TUI.
          const answer = await ctx.ui.select(dialog.title, ["No", "Yes"]);
          return answer === "Yes";
        },
      };

      const record = (entry: DecisionRecord) => {
        try {
          // `appendCustomEntry` exists on the session manager pi hands to an
          // extension at runtime; the read-only type does not expose it.
          const manager = ctx.sessionManager as unknown as {
            appendCustomEntry?: (customType: string, data: unknown) => unknown;
          };
          manager.appendCustomEntry?.(DECISION_ENTRY_TYPE, entry);
        } catch {
          // A record is evidence, never a reason to fail a call.
        }
      };

      try {
        return await evaluateToolCall(
          { toolName: event.toolName, input: (event.input ?? {}) as Record<string, unknown> },
          gateContext,
          gateSettingsToSettings(settings.gate, settings.gate.policyNotes ?? ""),
          { engine: await engineFor(), record, now: () => Date.now() },
        );
      } catch (error) {
        // The gate never lets its own failure become an approval.
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`jev auto mode failed (${message}); blocking the call`, "error");
        return { block: true, reason: `Jev auto mode could not decide: ${message}` };
      }
    });
  },
};
