/**
 * Desktop-Host settings that must outlive the Host process.
 *
 * Stored next to the other desktop-owned files in the Pi agent directory so a
 * Host restart (or app update) keeps the user's choices. Values are validated on
 * read, so a hand-edited file can never break compaction.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  AUTO_COMPACT_SETTINGS_DEFAULTS,
  clampAutoCompactTurns,
  type AutoCompactSettings,
} from "../shared/auto-compact";

function settingsPath(): string {
  return join(getAgentDir(), "pi-desktop-settings.json");
}

/**
 * Read the current settings.
 *
 * Deliberately uncached: the file is tiny, reads are rare (one idle check per
 * turn), and re-reading keeps hand edits and the Settings panel in sync.
 */
export function readHostSettings(): AutoCompactSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
    return { autoCompactTurns: clampAutoCompactTurns(raw.autoCompactTurns) };
  } catch {
    // Missing or unreadable file — fall back to defaults.
    return { ...AUTO_COMPACT_SETTINGS_DEFAULTS };
  }
}

export function writeHostSettings(patch: Partial<AutoCompactSettings>): AutoCompactSettings {
  const next: AutoCompactSettings = {
    autoCompactTurns:
      patch.autoCompactTurns === undefined
        ? readHostSettings().autoCompactTurns
        : clampAutoCompactTurns(patch.autoCompactTurns),
  };
  const path = settingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // Callers still get the requested value even when the write fails.
  }
  return next;
}
