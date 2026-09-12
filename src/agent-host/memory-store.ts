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
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
/** Script names must be plain file names: no separators, no leading dot. */
export const MEMORY_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEMORY_SCRIPT_HEAD_BYTES = 4096;

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
 * Point the model at the archived memory, if any has sunk out of the context.
 *
 * Retired memory is only on disk; without this the model would never know it
 * exists. Returns null while everything still fits in the active memory.
 */
export function memoryArchiveNotice(sessionId: string): string | null {
  const path = secondaryMemoryPath(sessionId);
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    return null;
  }
  if (bytes <= 0) return null;
  return [
    "## 记忆归档（已下沉，不在你的上下文里）",
    "",
    `归档文件：\`${path}\`（${formatBytes(bytes)}）`,
    "",
    "需要更早的记忆时自己检索，不要整篇读入：",
    "`rg -n \"关键词\" <归档文件>` 或 `sed -n '1,120p' <归档文件>`",
  ].join("\n");
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
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MEMORY_SCRIPT_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, MEMORY_SCRIPT_HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
