import { safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type VaultFile = {
  version: 1;
  entries: Record<string, string>;
};

/** Prefix used by the fallback (application-key AES) encryption. */
const FALLBACK_PREFIX = "v2.";

function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!/^channel:(weixin|telegram|feishu):[a-z0-9._-]{1,160}$/i.test(trimmed)) {
    throw new Error("Invalid channel credential key");
  }
  return trimmed;
}

/**
 * AES-256-GCM cipher keyed by an application-private key file. Used when the
 * OS keyring / safeStorage backend is unavailable (e.g. Linux desktops with no
 * gnome-keyring/kwallet service). The key lives in the app's userData dir with
 * 0600 permissions, so credentials are still encrypted at rest — just not
 * bound to the OS account like safeStorage would be.
 */
class FallbackCipher {
  private key: Buffer | null = null;

  constructor(private readonly keyPath: string) {}

  private getKey(): Buffer {
    if (this.key) return this.key;
    try {
      const raw = fs.readFileSync(this.keyPath);
      if (raw.length === 32) {
        this.key = raw;
        return raw;
      }
    } catch {
      /* not present yet — generate below */
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, key, { encoding: "utf8", mode: 0o600 });
    this.key = key;
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${FALLBACK_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== FALLBACK_PREFIX.slice(0, -1)) {
      throw new Error("Invalid fallback credential format");
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  }
}

export class CredentialVault {
  private readonly fallback: FallbackCipher;

  constructor(
    private readonly filePath: string,
    keyPath = `${filePath}.key`,
  ) {
    this.fallback = new FallbackCipher(keyPath);
  }

  private read(): VaultFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<VaultFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error("Invalid credential vault format");
      }
      return { version: 1, entries: parsed.entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
      throw error;
    }
  }

  private write(data: VaultFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort on Windows */
    }
  }

  private encrypt(value: Record<string, unknown>): string {
    const plaintext = JSON.stringify(value);
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plaintext).toString("base64");
    }
    return this.fallback.encrypt(plaintext);
  }

  private decrypt(encrypted: string): string {
    if (encrypted.startsWith(FALLBACK_PREFIX)) {
      return this.fallback.decrypt(encrypted);
    }
    // Legacy safeStorage payload (no prefix).
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("This credential was encrypted with OS keyring support, which is unavailable in this session");
    }
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  get(key: string): Record<string, unknown> | null {
    const encrypted = this.read().entries[validateKey(key)];
    if (!encrypted) return null;
    const plaintext = this.decrypt(encrypted);
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid channel credential payload");
    return parsed as Record<string, unknown>;
  }

  set(key: string, value: Record<string, unknown>): void {
    const data = this.read();
    data.entries[validateKey(key)] = this.encrypt(value);
    this.write(data);
  }

  delete(key: string): void {
    const data = this.read();
    delete data.entries[validateKey(key)];
    this.write(data);
  }
}

export function createCredentialRequestHandler(vault: CredentialVault) {
  return async (method: string, params: unknown): Promise<unknown> => {
    const body = (params ?? {}) as { key?: string; value?: Record<string, unknown> };
    if (!body.key) throw new Error("Credential key is required");
    if (method === "channelSecrets.get") return vault.get(body.key);
    if (method === "channelSecrets.set") {
      if (!body.value || typeof body.value !== "object") throw new Error("Credential value is required");
      vault.set(body.key, body.value);
      return { ok: true };
    }
    if (method === "channelSecrets.delete") {
      vault.delete(body.key);
      return { ok: true };
    }
    throw new Error(`Unsupported Host request: ${method}`);
  };
}
