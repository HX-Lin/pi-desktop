/**
 * Which credential names the vault will store.
 *
 * Kept separate from the vault itself so the rule can be tested without
 * Electron's `safeStorage`, and so a new credential namespace is a one-line
 * change next to its explanation.
 */

/**
 * - `channel:<provider>:<account>` — a messaging channel account.
 * - `jev.<channel>` — a Jev gateway key (see `agent-host/jev/channels.ts`).
 *
 * Anything else is refused, so a stray RPC cannot write an arbitrary secret.
 */
const CREDENTIAL_KEY_PATTERN = /^(?:channel:(?:weixin|telegram|feishu):[a-z0-9._-]{1,160}|jev\.[a-z0-9_-]{1,32})$/i;

/** Trim and validate a credential key, or throw. */
export function normalizeCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (!CREDENTIAL_KEY_PATTERN.test(trimmed)) throw new Error("Invalid credential key");
  return trimmed;
}

/** True when the key names a namespace the vault may store. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key.trim());
}
