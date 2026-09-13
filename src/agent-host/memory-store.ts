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
 *
 * Procedural knowledge does not belong in that text at all: it lives as
 * executable scripts under `scripts/`. Those are never capped and never enter
 * the context — only a one-line index (name + description) is injected into the
 * system prompt, so the model knows what each script does and can run it
 * directly. See `memory-scripts-extension.ts`.
 *
 * Layout per session:
 *
 *   primary.md      memory that stays in context (3 MB cap)
 *   secondary.md    memory that sank out of the primary (30 MB cap)
 *   scripts/        executable procedures, uncapped, never in context
 *   archive/        raw conversation removed by a memory compaction, as JSONL
 *
 * Everything that is not in the context is announced to the model instead of
 * being silently lost — see `memoryArchiveNotice`.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MemoryOverview, MemoryTextOverview } from "../shared/api-types";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MEMORY_SCRIPTS_DIRNAME = "scripts";
export const MEMORY_ARCHIVE_DIRNAME = "archive";
/** Upper bound for the raw-conversation archive; oldest files go first. */
export const MEMORY_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
/** Script names must be plain file names: no separators, no leading dot. */
export const MEMORY_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEMORY_SCRIPT_HEAD_BYTES = 4096;
/** Bounds for the read-only memory overview shown in the app. */
const MEMORY_OVERVIEW_TAIL_BYTES = 64 * 1024;
const MEMORY_OVERVIEW_PREVIEW_CHARS = 2000;
const MEMORY_OVERVIEW_MAX_SECTIONS = 30;
const MEMORY_OVERVIEW_MAX_ARCHIVES = 20;

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

/** Directory holding the session's executable memory scripts. */
export function memoryScriptsDir(sessionId: string): string {
  return join(memoryDir(sessionId), MEMORY_SCRIPTS_DIRNAME);
}

/** Directory holding raw conversation that a memory compaction removed. */
export function memoryArchiveDir(sessionId: string): string {
  return join(memoryDir(sessionId), MEMORY_ARCHIVE_DIRNAME);
}

export interface MemoryArchiveSummary {
  dir: string;
  files: number;
  bytes: number;
  /** `YYYY-MM-DD` of the oldest and newest archive file. */
  oldest?: string;
  newest?: string;
}

/** Summarize the session's raw-conversation archive (never reads file bodies). */
export function listMemoryArchives(sessionId: string): MemoryArchiveSummary {
  const dir = memoryArchiveDir(sessionId);
  const summary: MemoryArchiveSummary = { dir, files: 0, bytes: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return summary;
  }
  if (names.length === 0) return summary;
  names.sort();
  for (const name of names) {
    try {
      summary.bytes += statSync(join(dir, name)).size;
    } catch {
      // Raced with the retention sweep — skip the file.
    }
  }
  summary.files = names.length;
  summary.oldest = names[0].slice(0, 10);
  summary.newest = names[names.length - 1].slice(0, 10);
  return summary;
}

/** A script the model may run directly instead of recalling how to do the job. */
export interface MemoryScript {
  name: string;
  path: string;
  description: string;
  bytes: number;
}

/**
 * List the session's memory scripts.
 *
 * Script contents are never read into the context and never count against the
 * memory caps, so there is no size limit on this directory.
 */
export function listMemoryScripts(sessionId: string): MemoryScript[] {
  const dir = memoryScriptsDir(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  return names.sort().map((name) => {
    const path = join(dir, name);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // Raced with a delete — report it as empty rather than failing the index.
    }
    return { name, path, description: scriptDescription(readHead(path)), bytes };
  });
}

/**
 * Write a memory script, replacing any previous version atomically.
 *
 * Returns `null` for names that are not plain file names, so a model (or a
 * prompt injection) can never escape the session's script directory.
 */
export function writeMemoryScript(sessionId: string, name: string, content: string): MemoryScript | null {
  if (!MEMORY_SCRIPT_NAME_PATTERN.test(name)) return null;
  const dir = memoryScriptsDir(sessionId);
  const path = join(dir, name);
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tempPath, content, "utf8");
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, path);
  } catch {
    return null;
  }
  return { name, path, description: scriptDescription(content), bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * Point the model at everything that left the context.
 *
 * Active memory needs no announcement: it lives in the session as the compaction
 * entry the model already reads. Retired memory and the raw conversations dropped
 * by a memory compaction are only on disk, so without this the model would never
 * know they exist. Returns null while nothing has been retired yet.
 */
export function memoryArchiveNotice(sessionId: string): string | null {
  const lines: string[] = [];

  const secondary = secondaryMemoryPath(sessionId);
  const secondaryBytes = fileSize(secondary);
  if (secondaryBytes > 0) {
    lines.push(`- 已下沉的记忆：\`${secondary}\`（${formatBytes(secondaryBytes)}）`);
  }

  const archives = listMemoryArchives(sessionId);
  if (archives.files > 0) {
    const range = archives.oldest === archives.newest ? archives.oldest : `${archives.oldest} ~ ${archives.newest}`;
    lines.push(
      `- 已删除的原始对话：\`${archives.dir}\`（${archives.files} 个文件，共 ${formatBytes(archives.bytes)}，${range}）`,
    );
  }

  if (lines.length === 0) return null;
  return [
    "## 记忆归档（不在你的上下文里，需要时自己检索）",
    "",
    ...lines,
    "",
    "检索：`rg -n \"关键词\" <路径>`；列小节：`rg -n '^## ' <文件>`；不要整篇读入。",
  ].join("\n");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Remove a `## heading` section from a memory text, up to the next `## `.
 *
 * Memory texts are rewritten in place: sections this app owns (sedimented
 * scripts, extracted facts) are replaced rather than appended to, so a summary
 * pi reuses from the previous compaction cannot stack duplicates.
 */
export function stripMarkdownSection(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  if (start < 0) return text;
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(0, start) : `${text.slice(0, start)}${text.slice(end)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the index that tells the model which scripts exist.
 *
 * The directory is created on the way so the model always has somewhere to drop
 * a new script.
 */
export function memoryScriptIndex(sessionId: string): string {
  try {
    mkdirSync(memoryScriptsDir(sessionId), { recursive: true });
  } catch {
    // A read-only agent dir still deserves an index; listing returns [].
  }
  return renderMemoryScriptIndex(sessionId, listMemoryScripts(sessionId));
}

function renderMemoryScriptIndex(sessionId: string, scripts: MemoryScript[]): string {
  const lines = [
    "## 可执行记忆脚本",
    "",
    "把做过的、可复用的操作写成脚本放在这里，之后直接运行，不用重新推导，也不占用记忆上限。",
    "",
    `脚本目录：\`${memoryScriptsDir(sessionId)}\``,
    "",
    ...(scripts.length === 0
      ? ["（暂无脚本）"]
      : scripts.map((script) => `- \`${script.name}\` — ${script.description}`)),
    "",
    "运行：`bash <脚本目录>/<脚本名>`，不用先把内容读进上下文。",
    "新增：把脚本写进该目录，并用 `# description: 用途` 注释说明，下一轮就会出现在这里。",
  ];
  return lines.join("\n");
}

/** Prefer an explicit `# description:` line, then the first comment line. */
function scriptDescription(head: string): string {
  const lines = head.split("\n", 24);
  for (const line of lines) {
    const match = /^#+\s*description\s*[:：]\s*(.+)$/i.exec(line.trim());
    if (match) return match[1].trim();
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#") || trimmed.startsWith("#!")) continue;
    const text = trimmed.replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return "（无说明）";
}

/** Read just enough of a script to find its description. */
function readHead(path: string): string {
  return readSlice(path, 0, MEMORY_SCRIPT_HEAD_BYTES);
}

/**
 * Read a bounded slice of a file.
 *
 * Memory files can be tens of megabytes, so overviews never load them whole.
 */
function readSlice(path: string, start: number, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `## ` headings of a memory text, bounded. */
function extractSections(text: string): string[] {
  const sections: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    sections.push(match[1]);
    if (sections.length >= MEMORY_OVERVIEW_MAX_SECTIONS) break;
  }
  return sections;
}

/** Archive files, newest first. */
function listArchiveFiles(sessionId: string): Array<{ name: string; bytes: number }> {
  const dir = memoryArchiveDir(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((name) => {
      let bytes = 0;
      try {
        bytes = statSync(join(dir, name)).size;
      } catch {
        // Raced with the retention sweep.
      }
      return { name, bytes };
    });
}

/**
 * Describe one memory text without loading it whole.
 *
 * `tailOnly` is for files that can be huge (the archive of sunk memory): only the
 * newest slice is scanned, which is also the part worth previewing.
 */
function describeMemoryText(path: string, tailOnly: boolean): MemoryTextOverview | null {
  let size: number;
  let updatedAt: number;
  try {
    const stats = statSync(path);
    size = stats.size;
    updatedAt = stats.mtimeMs;
  } catch {
    return null;
  }

  const slice = tailOnly
    ? readSlice(path, Math.max(0, size - MEMORY_OVERVIEW_TAIL_BYTES), MEMORY_OVERVIEW_TAIL_BYTES)
    : readSlice(path, 0, size);
  // A tail slice may start mid-line (and mid-character): drop the first line.
  const text = tailOnly && slice.length > 0 ? slice.slice(slice.indexOf("\n") + 1) : slice;
  const preview = tailOnly ? text.slice(-MEMORY_OVERVIEW_PREVIEW_CHARS) : text.slice(0, MEMORY_OVERVIEW_PREVIEW_CHARS);
  return { path, bytes: size, updatedAt, sections: extractSections(text), preview, tailOnly };
}

/** Everything "压缩为记忆" has produced for a session, ready for the UI. */
export function readMemoryOverview(sessionId: string): MemoryOverview {
  const primary = describeMemoryText(primaryMemoryPath(sessionId), false);
  const secondary = describeMemoryText(secondaryMemoryPath(sessionId), true);
  const scripts = listMemoryScripts(sessionId).map((script) => ({
    name: script.name,
    description: script.description,
    bytes: script.bytes,
  }));
  const archives = listArchiveFiles(sessionId).slice(0, MEMORY_OVERVIEW_MAX_ARCHIVES);
  const archiveSummary = listMemoryArchives(sessionId);
  return {
    sessionId,
    dir: memoryDir(sessionId),
    exists: Boolean(primary || secondary || scripts.length > 0 || archiveSummary.files > 0),
    primary,
    secondary,
    scripts,
    archives,
    archivesBytes: archiveSummary.bytes,
  };
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
