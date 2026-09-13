/**
 * Deterministic ground truth for the span a memory compaction folds away.
 *
 * The distilled memory is written by a model, so it can summarize "I ran the
 * tests" without the command, or drop the error it was chasing. Everything here
 * is extracted from the raw entries with zero LLM calls and appended to the
 * memory as a factual floor.
 *
 * Scope is deliberately narrow: pi already records the files a span touched
 * (`<read-files>` / `<modified-files>` in its summary), so this only adds what
 * nothing else keeps — the commands that ran and the failures that occurred.
 * The block is bounded by entry counts, per-entry length and total bytes, so a
 * long span cannot turn the memory into a log dump.
 */
import { stripMarkdownSection } from "./memory-store";

export const FACTS_HEADING = "## 已沉淀区间的事实（自动抽取）";
export const FACTS_MAX_COMMANDS = 20;
export const FACTS_MAX_ERRORS = 12;
export const FACTS_MAX_ENTRY_CHARS = 160;
export const FACTS_MAX_BYTES = 2048;

export interface ConversationFacts {
  commands: string[];
  errors: string[];
  /** Totals before truncation, so the model knows how much was left out. */
  totals: { commands: number; errors: number };
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

interface EntryMessage {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

const SHELL_TOOLS = new Set(["bash", "shell", "terminal", "run", "exec", "exec_command"]);

export function extractConversationFacts(entries: readonly unknown[]): ConversationFacts {
  const commands = new Map<string, number>();
  const errors = new Map<string, number>();

  entries.forEach((raw, order) => {
    const message = (raw as { type?: unknown; message?: unknown } | null)?.message as EntryMessage | undefined;
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) return;

    if (message.role === "assistant") {
      for (const block of message.content as ContentBlock[]) {
        if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
        const call = block as { name?: unknown; arguments?: unknown };
        if (!SHELL_TOOLS.has(String(call.name ?? "").toLowerCase())) continue;
        const command = firstLine((call.arguments as { command?: unknown } | undefined)?.command);
        if (command) commands.set(truncate(command), order);
      }
      return;
    }

    if (message.role === "toolResult" && message.isError === true) {
      const text = firstLine(message.content);
      if (!text) return;
      const name = typeof message.toolName === "string" ? message.toolName : "tool";
      errors.set(`${name}: ${truncate(text)}`, order);
    }
  });

  return {
    commands: lastUnique(commands, FACTS_MAX_COMMANDS),
    errors: lastUnique(errors, FACTS_MAX_ERRORS),
    totals: { commands: commands.size, errors: errors.size },
  };
}

/** Build the memory section, or null when the span left no trace. */
export function renderFactAppendix(facts: ConversationFacts): string | null {
  const lines = [FACTS_HEADING, ""];
  if (facts.commands.length > 0) {
    lines.push(`- 执行命令（共 ${facts.totals.commands} 条，列最近 ${facts.commands.length} 条）：`);
    lines.push(...facts.commands.map((command) => `  - \`${command}\``));
  }
  if (facts.errors.length > 0) {
    lines.push(`- 出错（共 ${facts.totals.errors} 条，列最近 ${facts.errors.length} 条）：`);
    lines.push(...facts.errors.map((error) => `  - ${error}`));
  }
  if (lines.length === 2) return null;
  return clipToBudget(lines);
}

/** Replace any previous fact section, then append the new one at the end. */
export function applyFactAppendix(memory: string, facts: ConversationFacts): string {
  const base = stripMarkdownSection(memory, FACTS_HEADING).trimEnd();
  const block = renderFactAppendix(facts);
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

/** Keep whole lines while they fit the byte budget instead of cutting mid-entry. */
function clipToBudget(lines: string[]): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + size > FACTS_MAX_BYTES) return [...kept, "（事实过多，已截断）"].join("\n");
    kept.push(line);
    bytes += size;
  }
  return kept.join("\n");
}

/** Keep the most recent `max` unique entries, in their original order. */
function lastUnique(entries: Map<string, number>, max: number): string[] {
  return [...entries.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(-max)
    .map(([value]) => value);
}

/** First non-empty line of a command or tool output, whitespace collapsed. */
function firstLine(value: unknown): string | null {
  if (typeof value === "string") {
    return (
      value
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ?? null
    );
  }
  if (!Array.isArray(value)) return null;
  for (const block of value as ContentBlock[]) {
    if (!block || typeof block !== "object" || typeof block.text !== "string") continue;
    const line = block.text.split("\n").find((candidate) => candidate.trim());
    if (line) return line.trim();
  }
  return null;
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= FACTS_MAX_ENTRY_CHARS ? single : `${single.slice(0, FACTS_MAX_ENTRY_CHARS - 1)}…`;
}
