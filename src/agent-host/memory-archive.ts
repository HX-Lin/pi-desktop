/**
 * Cold storage for the raw conversation a memory compaction removes.
 *
 * "压缩为记忆" deletes the summarized entries from the session file, and the
 * distilled memory is lossy by nature — whatever the model failed to write down
 * would be gone forever. Every removal is therefore archived first, as plain
 * JSONL that can be searched with the same tools as any other file:
 *
 *   <memory dir>/archive/<timestamp>.jsonl
 *
 * The archive is announced to the model each turn instead of being loaded into
 * the context (see `memoryArchiveNotice`). Retention is a byte budget: when the
 * directory grows past `MEMORY_ARCHIVE_MAX_BYTES` the oldest files are dropped,
 * so a very long-lived session cannot fill the disk.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_ARCHIVE_MAX_BYTES, memoryArchiveDir } from "./memory-store";

export interface ArchivedConversation {
  path: string;
  entries: number;
  bytes: number;
  /** Files dropped by the retention sweep. */
  swept: number;
}

export interface ArchiveMeta {
  sessionId: string;
  /** Why these entries left the context, for anyone reading the file later. */
  reason: string;
  /** Memory text length at the time of removal, to correlate archive and memory. */
  memoryChars: number;
  now?: number;
}

/**
 * Write the entries a memory compaction is about to delete.
 *
 * Returns null when there is nothing to archive or the write failed — callers
 * must treat that as "do not delete the entries". Atomic (temp file + rename) so
 * a crash cannot leave a half-written archive behind.
 */
export function archiveSessionEntries(entries: readonly unknown[], meta: ArchiveMeta): ArchivedConversation | null {
  if (entries.length === 0) return null;
  const dir = memoryArchiveDir(meta.sessionId);
  const path = nextArchivePath(dir, meta.now ?? Date.now());
  const header = JSON.stringify({
    type: "pi-desktop-archive",
    sessionId: meta.sessionId,
    createdAt: new Date(meta.now ?? Date.now()).toISOString(),
    reason: meta.reason,
    entries: entries.length,
    memoryChars: meta.memoryChars,
  });
  const body = `${[header, ...entries.map((entry) => JSON.stringify(entry))].join("\n")}\n`;
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, path);
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Nothing else to do; the caller keeps the entries.
    }
    return null;
  }

  const bytes = Buffer.byteLength(body, "utf8");
  return { path, entries: entries.length, bytes, swept: sweepArchives(dir) };
}

/** True when an archive directory is over budget and old files had to go. */
export function sweepArchives(dir: string): number {
  let files: Array<{ path: string; name: string; size: number }>;
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => ({ path: join(dir, name), name, size: statSync(join(dir, name)).size }));
  } catch {
    return 0;
  }

  let total = files.reduce((sum, file) => sum + file.size, 0);
  let dropped = 0;
  for (const file of files) {
    if (total <= MEMORY_ARCHIVE_MAX_BYTES) break;
    try {
      rmSync(file.path, { force: true });
      total -= file.size;
      dropped += 1;
    } catch {
      break;
    }
  }
  return dropped;
}

/** `<ISO timestamp with '-' instead of ':' and '.'>.jsonl`, never colliding. */
function nextArchivePath(dir: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let path = join(dir, `${stamp}.jsonl`);
  for (let suffix = 2; exists(path) && suffix < 100; suffix += 1) {
    path = join(dir, `${stamp}-${suffix}.jsonl`);
  }
  return path;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
