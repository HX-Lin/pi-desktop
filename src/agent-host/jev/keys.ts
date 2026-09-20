/**
 * Where a Jev API key comes from.
 *
 * Environment first (a one-off or CI override needs no UI), then this app's
 * credential vault — the same AES-256-GCM / 0600 store the messaging channels
 * use, reached over the Host's main-process RPC. Never a plaintext file in the
 * agent directory, which is what both upstream projects had to do.
 *
 * Keys are read per call: a key pasted into Settings takes effect on the next
 * judgment without restarting anything.
 */
import { callMain } from "../parent-rpc";
import { envKey, envKeyVariable, type JevChannelDefinition } from "./channels";

export interface JevKeySource {
  apiKey: string;
  /** `env:TYPESAFE_API_KEY`, `vault`, or null when nothing is configured. */
  source: "env" | "vault" | null;
  /** Which env var won, for status display. */
  envVariable: string | null;
}

const NO_KEY: JevKeySource = { apiKey: "", source: null, envVariable: null };

/** Resolve the key without throwing; a missing key is a status, not an error. */
export async function resolveJevKey(channel: JevChannelDefinition): Promise<JevKeySource> {
  const fromEnv = envKey(channel);
  if (fromEnv) return { apiKey: fromEnv, source: "env", envVariable: envKeyVariable(channel) };

  try {
    const stored = await callMain<unknown>("channelSecrets.get", { key: channel.vaultKey });
    const apiKey = readApiKey(stored);
    if (apiKey) return { apiKey, source: "vault", envVariable: null };
  } catch {
    // The vault is unavailable (main process gone): report "no key" rather than
    // failing the judgment with a confusing error.
  }
  return NO_KEY;
}

export async function storeJevKey(channel: JevChannelDefinition, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await callMain("channelSecrets.delete", { key: channel.vaultKey });
    return;
  }
  await callMain("channelSecrets.set", { key: channel.vaultKey, value: { apiKey: trimmed } });
}

export async function clearJevKey(channel: JevChannelDefinition): Promise<void> {
  await callMain("channelSecrets.delete", { key: channel.vaultKey });
}

function readApiKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const apiKey = (value as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}
