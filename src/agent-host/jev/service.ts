/**
 * The Jev service: one place the RPC, the gate, the compaction and the routing
 * all reach Jev through, so key resolution and channel selection happen once.
 *
 * Every consumer asks for a client and gets one for the currently configured
 * channel; nothing else in the app knows about protocols, vault keys or env
 * variables.
 */
import { findJevChannel, envKeyVariable, JEV_CHANNELS, type JevChannelDefinition } from "./channels";
import { resolveJevKey, storeJevKey, clearJevKey } from "./keys";
import { readJevSettings, resolveJevEndpoint, writeJevSettings, type JevSettings } from "./settings";
import { createJevClient, type JevClient } from "./transport";

export interface JevChannelStatus {
  id: string;
  label: string;
  protocol: "decisions" | "chat";
  baseUrl: string;
  model: string;
  keyHint: string;
  /** `env` / `vault` / null (nothing configured). */
  keySource: "env" | "vault" | null;
  keyVariable: string | null;
  hasKey: boolean;
}

export interface JevConfigPayload {
  settings: JevSettings;
  channel: JevChannelStatus;
  channels: Array<{ id: string; label: string; protocol: "decisions" | "chat"; keyHint: string }>;
}

export interface JevTestResult {
  ok: boolean;
  reason?: string;
  message?: string;
  model?: string;
  /** The answered probability, so a wrong model or key is visible immediately. */
  probability?: number;
  latencyMs?: number;
}

/** Resolved channel + credentials + client for one judgment. */
export interface JevRuntime {
  settings: JevSettings;
  channel: JevChannelDefinition;
  baseUrl: string;
  model: string;
  client: JevClient;
}

export async function describeJevChannel(settings: JevSettings): Promise<JevChannelStatus> {
  const { channel, baseUrl, model } = resolveJevEndpoint(settings);
  const key = await resolveJevKey(channel);
  return {
    id: channel.id,
    label: channel.label,
    protocol: channel.protocol,
    baseUrl,
    model,
    keyHint: channel.keyHint,
    keySource: key.source,
    keyVariable: key.source === "env" ? key.envVariable : envKeyVariable(channel),
    hasKey: key.apiKey.length > 0,
  };
}

export async function readJevConfig(): Promise<JevConfigPayload> {
  const settings = readJevSettings();
  return {
    settings,
    channel: await describeJevChannel(settings),
    channels: JEV_CHANNELS.map((channel) => ({
      id: channel.id,
      label: channel.label,
      protocol: channel.protocol,
      keyHint: channel.keyHint,
    })),
  };
}

export async function updateJevConfig(patch: unknown): Promise<JevConfigPayload> {
  const settings = writeJevSettings(patch);
  return { settings, channel: await describeJevChannel(settings), channels: (await readJevConfig()).channels };
}

/** Store (or clear) the key for the configured channel in the vault. */
export async function setJevKey(apiKey: string): Promise<JevConfigPayload> {
  const channel = findJevChannel(readJevSettings().channel);
  if (apiKey.trim()) await storeJevKey(channel, apiKey);
  else await clearJevKey(channel);
  return readJevConfig();
}

/**
 * Build a client for the current settings, or null when Jev cannot be used
 * (disabled, or no key anywhere). Callers treat null as "no Jev available".
 */
export async function getJevRuntime(overrides: Partial<JevSettings> = {}): Promise<JevRuntime | null> {
  const settings = { ...readJevSettings(), ...overrides };
  if (!settings.enabled) return null;
  const { channel, baseUrl, model } = resolveJevEndpoint(settings);
  const key = await resolveJevKey(channel);
  if (!key.apiKey) return null;
  return {
    settings,
    channel,
    baseUrl,
    model,
    client: createJevClient({
      protocol: channel.protocol,
      baseUrl,
      model,
      apiKey: key.apiKey,
      timeoutMs: settings.gate.timeoutMs,
      maxRetries: settings.gate.maxRetries,
    }),
  };
}

/**
 * A live end-to-end probe for the Settings button: it proves the key, the
 * protocol and the model slug in one call and reports the answered probability,
 * which is what tells a working channel from one that merely returns 200.
 */
export async function testJevChannel(): Promise<JevTestResult> {
  const runtime = await getJevRuntime({ enabled: true });
  if (!runtime) return { ok: false, reason: "no_key", message: "No Jev API key is configured for this channel." };

  const started = Date.now();
  const outcome = await runtime.client.ask(
    { value: "ok" },
    {
      probe: {
        type: "noul",
        instructions: "The text in `value` is exactly the word ok.",
        criteria: { true: "value is the word ok", false: "it is not" },
      },
    },
  );
  const latencyMs = Date.now() - started;
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason, message: outcome.message, latencyMs };
  }
  const answer = outcome.judgment.answers.probe;
  if (!answer || typeof answer.noul !== "number") {
    return {
      ok: false,
      reason: "no_answer",
      message: "The endpoint replied but did not answer the probe question.",
      model: outcome.judgment.model,
      latencyMs,
    };
  }
  return { ok: true, model: outcome.judgment.model, probability: answer.noul, latencyMs };
}
