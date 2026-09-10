/**
 * Renderer-side mirror of the Host's auto-compaction settings.
 *
 * The Host owns the value (it is the one that decides when to compact), but the
 * composer bar needs it immediately and the Settings panel must be able to
 * change it live. A tiny module store keeps every open session in sync without
 * threading new props through the tree.
 */
import { AUTO_COMPACT_SETTINGS_DEFAULTS, clampAutoCompactTurns, type AutoCompactSettings } from "@shared/auto-compact";
import { call } from "./api-client";

type Listener = (settings: AutoCompactSettings) => void;

let settings: AutoCompactSettings = { ...AUTO_COMPACT_SETTINGS_DEFAULTS };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

export function getAutoCompactSettings(): AutoCompactSettings {
  return settings;
}

export function subscribeAutoCompactSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: AutoCompactSettings): void {
  settings = next;
  for (const listener of [...listeners]) listener(settings);
}

/** Fetch the Host value once per renderer session; failures keep the defaults. */
export function loadAutoCompactSettings(): Promise<void> {
  loadPromise ??= call("settings.get")
    .then((result) => {
      publish({ autoCompactTurns: clampAutoCompactTurns(result?.autoCompactTurns) });
    })
    .catch(() => undefined);
  return loadPromise;
}

/** Apply a new threshold immediately, then persist it in the Host. */
export async function updateAutoCompactTurns(value: number): Promise<void> {
  const optimistic = clampAutoCompactTurns(value);
  publish({ autoCompactTurns: optimistic });
  try {
    const result = await call("settings.update", { autoCompactTurns: optimistic });
    publish({ autoCompactTurns: clampAutoCompactTurns(result?.autoCompactTurns) });
  } catch {
    // Keep the local value so the UI stays responsive; the next load resyncs.
  }
}
