/**
 * Per-session memory files.
 *
 * Compaction turns finished conversation into a structured memory. That memory
 * lives in the session (and therefore in the model context), but it also gets a
 * durable home on disk so it survives session rewrites and so old memory can be
 * retired without deleting it:
 *
 * - `primary.md`   the memory that stays in context, capped at 3 MB
 * - `secondary.md` memory that no longer fits the primary, capped at 30 MB
 *
 * When the primary exceeds its cap the oldest part sinks into the secondary
 * archive, and when the archive exceeds its cap the oldest part is dropped.
 * Both cuts prefer a section or paragraph boundary so text stays readable.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Cap for the memory that stays in the active context. */
export const PRIMARY_MEMORY_MAX_BYTES = 3 * 1024 * 1024;
/** Cap for the archive that holds retired memory. */
export const SECONDARY_MEMORY_MAX_BYTES = 30 * 1024 * 1024;

export interface MemorySyncResult {
  /** Memory text that belongs in the session context. */
  primary: string;
  /** True when part of the memory was retired into the secondary archive. */
  spilled: boolean;
  /** Bytes kept in the primary file. */
  primaryBytes: number;
  /** Bytes currently held by the secondary archive. */
  secondaryBytes: number;
}

export function memoryDir(sessionId: string): string {
  return join(getAgentDir(), "memory", sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export function primaryMemoryPath(sessionId: string): string {
  return join(memoryDir(sessionId), "primary.md");
}

export function secondaryMemoryPath(sessionId: string): string {
  return join(memoryDir(sessionId), "secondary.md");
}

/**
 * Persist the session memory and return the part that should stay in context.
 *
 * The returned `primary` is what the caller must keep injecting; anything that
 * did not fit is appended to the secondary archive instead of being lost.
 */
export function syncSessionMemory(sessionId: string, memory: string): MemorySyncResult {
  mkdirSync(memoryDir(sessionId), { recursive: true });
  const { sink, keep } = splitForCap(memory, PRIMARY_MEMORY_MAX_BYTES);
  if (sink) appendToSecondary(sessionId, sink);
  writeFileSync(primaryMemoryPath(sessionId), keep, "utf8");
  return {
    primary: keep,
    spilled: sink.length > 0,
    primaryBytes: byteLength(keep),
    secondaryBytes: byteLength(readSecondary(sessionId)),
  };
}

/** Read the active memory, or an empty string when the session has none yet. */
export function readPrimaryMemory(sessionId: string): string {
  try {
    return readFileSync(primaryMemoryPath(sessionId), "utf8");
  } catch {
    return "";
  }
}

/** Read the retired memory archive. */
export function readSecondaryMemory(sessionId: string): string {
  return readSecondary(sessionId);
}

function readSecondary(sessionId: string): string {
  try {
    return readFileSync(secondaryMemoryPath(sessionId), "utf8");
  } catch {
    return "";
  }
}

function appendToSecondary(sessionId: string, chunk: string): void {
  const path = secondaryMemoryPath(sessionId);
  const existing = readSecondary(sessionId);
  const separator = existing.endsWith("\n\n") || existing.length === 0 ? "" : "\n\n";
  const combined = `${existing}${separator}${chunk}`;
  const { keep } = splitForCap(combined, SECONDARY_MEMORY_MAX_BYTES);
  writeFileSync(path, keep, "utf8");
}

/** Split text so that `keep` fits `maxBytes`; the leading `sink` is the overflow. */
function splitForCap(text: string, maxBytes: number): { sink: string; keep: string } {
  const total = byteLength(text);
  if (total <= maxBytes) return { sink: "", keep: text };
  // Drop whole sections while trimming; a byte budget cannot be mapped to a
  // character index directly, so walk back from an estimate until it fits.
  let cut = Math.max(0, text.length - maxBytes);
  cut = boundaryAtOrBefore(text, cut);
  while (cut < text.length && byteLength(text.slice(cut)) > maxBytes) {
    const next = text.indexOf("\n", cut + 1);
    if (next < 0) break;
    cut = next + 1;
  }
  return { sink: text.slice(0, cut).trimEnd(), keep: text.slice(cut).trimStart() };
}

function boundaryAtOrBefore(text: string, index: number): number {
  const window = text.slice(0, Math.max(0, index));
  const section = window.lastIndexOf("\n## ");
  if (section > 0) return section + 1;
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph + 2;
  return Math.max(0, index);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
