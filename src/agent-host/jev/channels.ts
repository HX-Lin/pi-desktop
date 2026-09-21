/**
 * Jev channels: where a judgment request is sent, and how.
 *
 * Two transports answer Jev questions:
 *
 * - `decisions` — the vendor's native protocol: `POST { model, state, questions }`
 *   and a body of `answers`. TypeSafe's System One endpoint and OpenRouter's
 *   Decisions API both speak it.
 * - `chat` — an OpenAI-compatible `chat/completions` endpoint (Vercel AI
 *   Gateway). There is no decisions route there, so the questions travel as a
 *   strict JSON request and the reply is validated the same way; see
 *   `transport.ts`.
 *
 * Channels are data, not code paths: adding a gateway means adding an entry.
 */

export type JevProtocol = "decisions" | "chat";

export interface JevChannelDefinition {
  id: string;
  label: string;
  protocol: JevProtocol;
  /** Endpoint: the decisions URL, or the full chat/completions URL. */
  baseUrl: string;
  /** Jev model slug for this transport. */
  model: string;
  /** Environment variables consulted for the key, highest priority first. */
  apiKeyEnv: readonly string[];
  /** CredentialVault key holding this channel's API key. */
  vaultKey: string;
  /** Where the key comes from, for the settings UI. */
  keyHint: string;
}

export const JEV_CHANNELS: readonly JevChannelDefinition[] = [
  {
    id: "typesafe",
    label: "TypeSafe (System One)",
    protocol: "decisions",
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: ["TYPESAFE_API_KEY", "JEVC_API_KEY"],
    vaultKey: "jev.typesafe",
    keyHint: "TYPESAFE_API_KEY",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    protocol: "chat",
    baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
    // The gateway proxies models rather than exposing a Jev route, and Jev's own
    // model is not callable here: `typesafe-ai/jev` is the catalog's only entry of
    // `type: "evaluation"` (no supported parameters, `max_tokens: 0`), so
    // `chat/completions` answers 404 for it whatever the spelling. The 253
    // `type: "language"` models are the ones this endpoint serves, and any of them
    // can answer the questions — the request asks for JSON and the reply is
    // validated field by field. This one is fast and cheap for a per-call gate.
    model: "openai/gpt-5-mini",
    apiKeyEnv: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "JEVC_API_KEY"],
    vaultKey: "jev.vercel",
    keyHint: "AI_GATEWAY_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter (Decisions API)",
    protocol: "decisions",
    baseUrl: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    apiKeyEnv: ["OPENROUTER_API_KEY", "JEVC_API_KEY"],
    vaultKey: "jev.openrouter",
    keyHint: "OPENROUTER_API_KEY",
  },
  {
    // Any OpenAI-compatible chat endpoint: a gateway that bills differently, a
    // provider you already pay for, or a local server. Vercel's AI Gateway, for
    // instance, refuses requests without a card on file, and this is the way
    // around that rather than a fork of the transport.
    id: "custom",
    label: "OpenAI-compatible (custom endpoint)",
    protocol: "chat",
    baseUrl: "",
    model: "",
    apiKeyEnv: ["JEV_API_KEY", "OPENAI_API_KEY"],
    vaultKey: "jev.custom",
    keyHint: "JEV_API_KEY",
  },
];

export const DEFAULT_JEV_CHANNEL = "typesafe";

export function findJevChannel(id: string | undefined): JevChannelDefinition {
  const match = JEV_CHANNELS.find((channel) => channel.id === id);
  return match ?? JEV_CHANNELS[0];
}

/** Which env var actually supplied the key, for status display. */
export function envKeyVariable(channel: JevChannelDefinition, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of channel.apiKeyEnv) {
    if ((env[name] ?? "").trim()) return name;
  }
  return null;
}

/** Channel key from the environment, or null when only the vault can supply it. */
export function envKey(channel: JevChannelDefinition, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = envKeyVariable(channel, env);
  return name ? (env[name] ?? "").trim() : null;
}
