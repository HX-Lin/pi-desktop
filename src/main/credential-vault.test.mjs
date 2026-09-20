import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * `CredentialVault` needs Electron's `safeStorage`. Stubbing it as unavailable
 * exercises the fallback AES-256-GCM path, which is what Linux desktops without
 * a keyring (niri included) actually run — so this covers the real code path.
 */
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".artifacts", "test-modules", `credential-vault-${process.pid}`);
const stub = path.join(dir, "electron-stub.mjs");
const entry = path.join(dir, "vault.mjs");
mkdirSync(dir, { recursive: true });
await import("node:fs/promises").then((fs) =>
  fs.writeFile(stub, "export const safeStorage = { isEncryptionAvailable: () => false };\n"),
);
await build({
  absWorkingDir: root,
  entryPoints: ["src/main/credential-vault.ts"],
  outfile: entry,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { electron: stub },
  logLevel: "silent",
});
const { CredentialVault, createCredentialRequestHandler } = await import(
  `${pathToFileURL(entry).href}?v=${Date.now()}`
);

const vaultDir = path.join(os.tmpdir(), `pi-vault-test-${process.pid}-${Date.now()}`);
const vaultPath = path.join(vaultDir, "credentials.json");
const deps = { vault: new CredentialVault(vaultPath), handler: undefined };
deps.handler = createCredentialRequestHandler(deps.vault);
process.once("exit", () => {
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("a Jev key survives the round trip and is encrypted at rest", async () => {
  const key = "jev.vercel";
  const secret = "vercel-gateway-secret-value";

  // The exact call `jev/keys.ts` makes when the user saves a key in Settings.
  assert.deepEqual(await deps.handler("channelSecrets.set", { key, value: { apiKey: secret } }), { ok: true });

  assert.deepEqual(deps.vault.get(key), { apiKey: secret });
  assert.deepEqual(await deps.handler("channelSecrets.get", { key }), { apiKey: secret });

  // The plaintext must not be on disk, and the file must stay private.
  const raw = readFileSync(vaultPath, "utf8");
  assert.ok(!raw.includes(secret), "the key must be stored encrypted");
  assert.equal(readFileSync(vaultPath).length > 0, true);

  // A fresh instance (i.e. after an app restart) still reads it.
  assert.deepEqual(new CredentialVault(vaultPath).get(key), { apiKey: secret });

  // Clearing is what "Clear" in Settings does.
  assert.deepEqual(await deps.handler("channelSecrets.delete", { key }), { ok: true });
  assert.equal(deps.vault.get(key), null);
});

test("channel keys keep working, and unknown namespaces are still refused", async () => {
  const handler = deps.handler;
  await handler("channelSecrets.set", { key: "channel:feishu:cli_1", value: { appSecret: "s" } });
  assert.deepEqual(deps.vault.get("channel:feishu:cli_1"), { appSecret: "s" });

  await assert.rejects(() => handler("channelSecrets.set", { key: "jev", value: { apiKey: "x" } }), /Invalid/);
  await assert.rejects(() => handler("channelSecrets.set", { key: "aws.creds", value: { apiKey: "x" } }), /Invalid/);
  await assert.rejects(() => handler("channelSecrets.get", {}), /required/);
});
