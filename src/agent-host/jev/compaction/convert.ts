import type { Message, ToolResult } from "../../vendor/jev/index";

/**
 * The span pi hands to `session_before_compact`.
 *
 * Declared structurally rather than imported: the host's own `AgentMessage` is
 * the UI-normalized shape (`toolCallId`/`toolName`/`input`), while the runtime
 * union pi passes here carries the provider's raw blocks (`id`/`name`/
 * `arguments`) plus `bashExecution` and `custom` messages. Only what this
 * conversion reads is typed.
 */
export type PiSpanMessage =
  | { role: "user"; content: unknown }
  | { role: "assistant"; content: unknown }
  | { role: "toolResult"; toolCallId: string; content: unknown; isError?: boolean }
  | {
      role: "bashExecution";
      command: string;
      output: string;
      excludeFromContext?: boolean;
      cancelled?: boolean;
      exitCode?: number;
      timestamp?: number;
    }
  | { role: "custom"; content: unknown };

interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function asBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Extracts text from a string-or-content-blocks payload; images become a note. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "[image]"))
    .join("\n");
}

/**
 * Converts the span pi wants to summarize (any `AgentMessage`) into the
 * Claude-Code-shaped `Message[]` fast-jev-compaction works with:
 *
 * - `toolResult` messages merge into synthetic user messages (consecutive
 *   ones share one message), keeping their call order;
 * - `bashExecution` messages become an assistant tool call (`bash`) paired
 *   with a user tool result, so Jev can drop their outputs like any other;
 * - assistant thinking is dropped (transient, never needed verbatim later);
 * - `compactionSummary` / `branchSummary` are skipped: the hook receives the
 *   previous summary separately (`previousSummary`);
 * - images cannot be represented and render as `[image]`.
 */
export function convertMessages(messages: readonly PiSpanMessage[]): Message[] {
  const out: Message[] = [];
  let pendingResults: ToolResult[] = [];

  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: "user", text: "", toolUses: [], toolResults: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        flushResults();
        out.push({ role: "user", text: textOf(message.content), toolUses: [], toolResults: [] });
        break;
      }
      case "assistant": {
        flushResults();
        const blocks = asBlocks(message.content);
        const text = blocks
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("\n");
        const toolUses = blocks
          .filter(
            (block) => block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string",
          )
          .map((block) => ({
            tool_use_id: block.id as string,
            tool: block.name as string,
            input: (block.arguments ?? {}) as Record<string, unknown>,
          }));
        out.push({ role: "assistant", text, toolUses });
        break;
      }
      case "toolResult": {
        pendingResults.push({
          tool_use_id: message.toolCallId,
          text: textOf(message.content),
          isError: message.isError,
        });
        break;
      }
      case "bashExecution": {
        flushResults();
        if (message.excludeFromContext) break;
        const id = `bashexec_${message.timestamp}`;
        out.push({
          role: "assistant",
          text: "",
          toolUses: [{ tool_use_id: id, tool: "bash", input: { command: message.command } }],
        });
        pendingResults.push({
          tool_use_id: id,
          text: message.output,
          isError: message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0),
        });
        break;
      }
      case "custom": {
        flushResults();
        out.push({ role: "user", text: textOf(message.content), toolUses: [], toolResults: [] });
        break;
      }
      default:
        // compactionSummary / branchSummary arrive via previousSummary instead
        break;
    }
  }
  flushResults();
  return out;
}
