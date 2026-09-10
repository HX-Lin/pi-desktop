/**
 * Session file pruning.
 *
 * pi's compaction only removes summarized turns from the *model context*; the
 * session file keeps growing, so a long chat still held thousands of messages
 * that were already folded into memory. After a successful compaction the file
 * is rewritten to hold exactly what the context holds:
 *
 *   header + latest memory entry + the turns kept after it
 *
 * The rewrite is atomic (temp file + rename) and re-chains `parentId` so the
 * result is still a valid session tree rooted at the memory entry.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface PrunableEntry {
  id?: string;
  type?: string;
  parentId?: string | null;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  [key: string]: unknown;
}

export interface PruneResult {
  entries: PrunableEntry[];
  removed: number;
}

/**
 * Keep the latest compaction memory plus the entries it still covers.
 *
 * `updateMemory` may rewrite the memory text (for example after it was capped);
 * the compaction entry keeps everything else untouched.
 */
export function pruneSummarizedEntries(
  entries: PrunableEntry[],
  updateMemory?: (memory: string) => string,
): PruneResult {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return { entries, removed: 0 };

  const compaction = entries[compactionIndex];
  const firstKeptId = compaction.firstKeptEntryId;
  const firstKeptIndex = typeof firstKeptId === "string" ? entries.findIndex((entry) => entry.id === firstKeptId) : -1;
  const tailStart = firstKeptIndex >= 0 && firstKeptIndex <= compactionIndex ? firstKeptIndex : compactionIndex + 1;

  let memory = typeof compaction.summary === "string" ? compaction.summary : "";
  if (updateMemory && memory) memory = updateMemory(memory);
  const keptMemory = memory === compaction.summary ? compaction : { ...compaction, summary: memory };

  const kept = [keptMemory, ...entries.slice(tailStart, compactionIndex), ...entries.slice(compactionIndex + 1)];
  if (kept.length === entries.length && keptMemory === compaction) return { entries, removed: 0 };

  // Re-chain so the memory entry becomes the root of the retained path.
  const rechained: PrunableEntry[] = [];
  let parentId: string | null = null;
  for (const entry of kept) {
    rechained.push({ ...entry, parentId });
    parentId = typeof entry.id === "string" ? entry.id : parentId;
  }
  return { entries: rechained, removed: entries.length - kept.length };
}

/** Read a session file, split into its header and its entries. */
export function readSessionFileEntries(filePath: string): { header: PrunableEntry | null; entries: PrunableEntry[] } {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const parsed: PrunableEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    parsed.push(JSON.parse(line) as PrunableEntry);
  }
  return {
    header: parsed.find((entry) => entry.type === "session") ?? null,
    entries: parsed.filter((entry) => entry.type !== "session"),
  };
}

/** Replace the session file contents atomically. */
export function writeSessionFileEntries(
  filePath: string,
  header: PrunableEntry | null,
  entries: PrunableEntry[],
): void {
  const content = `${[...(header ? [header] : []), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const tempPath = `${filePath}.prune-${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}
