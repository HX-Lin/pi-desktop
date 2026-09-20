/**
 * Jev settings: channels, the gate, compaction and routing in one document.
 *
 * Stored next to the desktop's other host settings so a Host restart keeps them,
 * and written only from the Settings UI. Every field is validated on read, so a
 * hand-edited file cannot put the gate into a state the UI could not produce.
 *
 * Defaults mirror the two upstream projects: the gate and routing are off until
 * switched on, compaction is opt-in, and the thresholds are the calibrated
 * values from pi-jev-auto-mode.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_JEV_CHANNEL, findJevChannel } from "./channels";

export interface JevGateSettings {
  enabled: boolean;
  /** `all`: judge everything the deterministic layer cannot vouch for. */
  scope: "all" | "matched";
  /** What the middle band resolves to. `deny` keeps the gate fail-closed. */
  uncertain: "deny" | "ask" | "allow";
  timeoutMs: number;
  maxRetries: number;
  safeCommands: string[];
  allowedCommands: string[];
  disallowedCommands: string[];
  extraProtectedPaths: string[];
  /** Per-rule probability overrides, keyed by rule id. */
  thresholds: Record<string, number>;
}

export interface JevCompactionSettings {
  enabled: boolean;
  keepThreshold: number;
  borderline: number;
  truncateHeadChars: number;
  minReduction: number;
  maxStateTokens: number;
  maxRequestTokens: number;
}

export interface JevRoutingSettings {
  /** `off` keeps the model the user picked; `jev` lets Jev switch it per turn. */
  mode: "off" | "jev";
  cheap: string | null;
  strong: string | null;
  cheapThinking: string | null;
  strongThinking: string | null;
  easyMax: number;
  hardMin: number;
  minConfidence: number;
}

export interface JevSettings {
  /** Master switch: off means no Jev call of any kind. */
  enabled: boolean;
  channel: string;
  /** Overrides the channel default when set. */
  model: string | null;
  baseUrl: string | null;
  gate: JevGateSettings;
  compaction: JevCompactionSettings;
  routing: JevRoutingSettings;
}

export function defaultJevSettings(): JevSettings {
  return {
    enabled: false,
    channel: DEFAULT_JEV_CHANNEL,
    model: null,
    baseUrl: null,
    gate: {
      enabled: false,
      scope: "all",
      uncertain: "deny",
      timeoutMs: 4000,
      maxRetries: 1,
      safeCommands: [],
      allowedCommands: [],
      disallowedCommands: [],
      extraProtectedPaths: [],
      thresholds: {},
    },
    compaction: {
      enabled: false,
      keepThreshold: 0.5,
      borderline: 0.1,
      truncateHeadChars: 300,
      minReduction: 0.15,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
    },
    routing: {
      mode: "off",
      cheap: null,
      strong: null,
      cheapThinking: null,
      strongThinking: null,
      easyMax: 0.5,
      hardMin: 1.5,
      minConfidence: 0.6,
    },
  };
}

export function jevSettingsPath(): string {
  return join(getAgentDir(), "pi-desktop-jev.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, 200);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Probability thresholds must keep a middle band on both sides (0.5 < t <= 1). */
function thresholds(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) continue;
    if (numeric <= 0.5 || numeric > 1) continue;
    out[key] = numeric;
  }
  return out;
}

export function normalizeJevSettings(raw: unknown): JevSettings {
  const defaults = defaultJevSettings();
  const source = isRecord(raw) ? raw : {};
  const gate = isRecord(source.gate) ? source.gate : {};
  const compaction = isRecord(source.compaction) ? source.compaction : {};
  const routing = isRecord(source.routing) ? source.routing : {};

  return {
    enabled: boolean(source.enabled, defaults.enabled),
    channel: findJevChannel(typeof source.channel === "string" ? source.channel : undefined).id,
    model: optionalString(source.model),
    baseUrl: optionalString(source.baseUrl),
    gate: {
      enabled: boolean(gate.enabled, defaults.gate.enabled),
      scope: oneOf(gate.scope, ["all", "matched"] as const, defaults.gate.scope),
      uncertain: oneOf(gate.uncertain, ["deny", "ask", "allow"] as const, defaults.gate.uncertain),
      timeoutMs: number(gate.timeoutMs, defaults.gate.timeoutMs, 500, 60_000),
      maxRetries: number(gate.maxRetries, defaults.gate.maxRetries, 0, 5),
      safeCommands: stringList(gate.safeCommands),
      allowedCommands: stringList(gate.allowedCommands),
      disallowedCommands: stringList(gate.disallowedCommands),
      extraProtectedPaths: stringList(gate.extraProtectedPaths),
      thresholds: thresholds(gate.thresholds),
    },
    compaction: {
      enabled: boolean(compaction.enabled, defaults.compaction.enabled),
      keepThreshold: number(compaction.keepThreshold, defaults.compaction.keepThreshold, 0, 1),
      borderline: number(compaction.borderline, defaults.compaction.borderline, 0, 0.5),
      truncateHeadChars: number(compaction.truncateHeadChars, defaults.compaction.truncateHeadChars, 0, 10_000),
      minReduction: number(compaction.minReduction, defaults.compaction.minReduction, 0, 0.95),
      maxStateTokens: number(compaction.maxStateTokens, defaults.compaction.maxStateTokens, 1000, 400_000),
      maxRequestTokens: number(compaction.maxRequestTokens, defaults.compaction.maxRequestTokens, 1000, 400_000),
    },
    routing: {
      mode: oneOf(routing.mode, ["off", "jev"] as const, defaults.routing.mode),
      cheap: optionalString(routing.cheap),
      strong: optionalString(routing.strong),
      cheapThinking: optionalString(routing.cheapThinking),
      strongThinking: optionalString(routing.strongThinking),
      easyMax: number(routing.easyMax, defaults.routing.easyMax, 0, 2),
      hardMin: number(routing.hardMin, defaults.routing.hardMin, 0, 2),
      minConfidence: number(routing.minConfidence, defaults.routing.minConfidence, 0, 1),
    },
  };
}

export function readJevSettings(): JevSettings {
  try {
    return normalizeJevSettings(JSON.parse(readFileSync(jevSettingsPath(), "utf8")));
  } catch {
    return defaultJevSettings();
  }
}

export function writeJevSettings(patch: unknown): JevSettings {
  const current = readJevSettings();
  const merged = normalizeJevSettings({ ...current, ...(isRecord(patch) ? patch : {}) });
  const path = jevSettingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch {
    // Callers still get the requested values even when the write fails.
  }
  return merged;
}

/** Resolved channel for the current settings: endpoint, model and key source. */
export function resolveJevEndpoint(settings: JevSettings): {
  channel: ReturnType<typeof findJevChannel>;
  baseUrl: string;
  model: string;
} {
  const channel = findJevChannel(settings.channel);
  return {
    channel,
    baseUrl: settings.baseUrl ?? channel.baseUrl,
    model: settings.model ?? channel.model,
  };
}

/** True when at least one Jev consumer is switched on. */
export function jevFeatureEnabled(settings: JevSettings): boolean {
  return settings.enabled && (settings.gate.enabled || settings.compaction.enabled || settings.routing.mode === "jev");
}
