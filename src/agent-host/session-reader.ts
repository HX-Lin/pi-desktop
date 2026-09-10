import {
  SessionManager,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { AgentMessage, SessionEntry, SessionInfo, SessionContext, UserMessage } from "../shared/types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "../shared/normalize";
import { resolveProject, type ProjectInfo } from "../shared/worktree";
import { sessionIndex } from "./session-index";

export { getAgentDir };

export async function listAllSessions(): Promise<SessionInfo[]> {
  try {
    await sessionIndex.refreshAll();
    return await sessionIndex.getAll();
  } catch (error) {
    console.error("[agent-host] session index unavailable; falling back to pi listAll:", error);
    return listAllSessionsFallback();
  }
}

async function listAllSessionsFallback(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(
    uniqueCwds.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }),
  );

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

// Session path cache: sessionId → absolute file path. Its lifetime is bounded
// by the Agent Host utility process.
const sessionPathCache = new Map<string, string>();

function getPathCache(): Map<string, string> {
  return sessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (cached) getPathCache().delete(sessionId);

  const indexed = await sessionIndex.resolvePath(sessionId);
  if (indexed) getPathCache().set(sessionId, indexed);
  return indexed;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function getSessionIndexMetrics() {
  return sessionIndex.getMetrics();
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

function findCachedSessionId(filePath: string): string | undefined {
  for (const [id, cachedPath] of getPathCache()) {
    if (cachedPath === filePath) return id;
  }
  return undefined;
}

function getMessageTextContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

function getMessageActivityTime(entry: SessionEntry): number | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role?: unknown; timestamp?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (!getMessageTextContent(entry.message)) return undefined;
  if (typeof message.timestamp === "number") return message.timestamp;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Keep only the part of a session path that the model still sees.
 *
 * pi records a compaction entry carrying `firstKeptEntryId`; every entry before
 * it was folded into that summary. Rendering the whole path kept a long chat
 * showing thousands of already-summarized messages, so the UI now shows the
 * memory summary plus the kept turns: the same slice sent to the model.
 */
export function trimPathToCompactionContext(path: SessionEntry[]): SessionEntry[] {
  let compactionIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return path;
  const firstKeptEntryId = (path[compactionIndex] as unknown as { firstKeptEntryId?: unknown }).firstKeptEntryId;
  const trimmed: SessionEntry[] = [path[compactionIndex]];
  let reachedFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    if (path[index].id === firstKeptEntryId) reachedFirstKept = true;
    if (reachedFirstKept) trimmed.push(path[index]);
  }
  trimmed.push(...path.slice(compactionIndex + 1));
  return trimmed;
}

/** Build the Desktop SessionInfo for one already-open session without scanning all session files. */
export async function buildSessionInfoFromManager(
  filePath: string,
  manager: SessionManager,
  entries: SessionEntry[],
  options: { resolveProjectInfo?: boolean } = {},
): Promise<SessionInfo | null> {
  const header = manager.getHeader();
  if (!header) return null;

  cacheSessionPath(header.id, filePath);
  let messageCount = 0;
  let firstMessage = "";
  let lastActivityTime: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const activityTime = getMessageActivityTime(entry);
    if (activityTime !== undefined) lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
    const message = entry.message as unknown as { role?: unknown };
    if (!firstMessage && message.role === "user") firstMessage = getMessageTextContent(entry.message);
  }

  // The list count matches what the chat window actually renders: entries after
  // the latest compaction only. Titles and activity still come from full history.
  const branchEntries = manager.getBranch() as unknown as SessionEntry[];
  for (const entry of trimPathToCompactionContext(branchEntries.length > 0 ? branchEntries : entries)) {
    if (entry.type === "message") messageCount += 1;
  }

  const headerTime = Date.parse(header.timestamp);
  const created = Number.isNaN(headerTime) ? header.timestamp : new Date(headerTime).toISOString();
  const modified = lastActivityTime === undefined ? created : new Date(lastActivityTime).toISOString();
  const project = header.cwd && options.resolveProjectInfo !== false ? await resolveProject(header.cwd) : undefined;
  const parentSessionId = header.parentSession ? findCachedSessionId(header.parentSession) : undefined;

  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd,
    name: manager.getSessionName(),
    created,
    modified,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    ...(parentSessionId ? { parentSessionId } : {}),
    projectRoot: project?.projectRoot ?? header.cwd,
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null, limit?: number): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return {
      messages: [],
      entryIds: [],
      thinkingLevel: piCtx.thinkingLevel,
      model: piCtx.model,
      totalMessageCount: 0,
      truncated: false,
    };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return {
      messages: [],
      entryIds: [],
      thinkingLevel: piCtx.thinkingLevel,
      model: piCtx.model,
      totalMessageCount: 0,
      truncated: false,
    };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Build UI history from the compaction-aware slice of the branch. Old turns
  // were folded into the compaction summary, which is returned separately as
  // `memory` so the UI can pin it instead of re-rendering the whole branch.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const memory: AgentMessage[] = [];
  let pendingChannelSource: { channel: NonNullable<UserMessage["channelSource"]>; runId?: string } | null = null;
  for (const e of trimPathToCompactionContext(path)) {
    if (e.type === "compaction") {
      const memoryMessage = entryToUiMessage(e);
      if (memoryMessage) memory.push(memoryMessage);
      continue;
    }
    if (e.type === "custom" && e.customType === "pi-desktop-channel-source") {
      const marker = parseChannelSourceMarker(e.data);
      if (marker) pendingChannelSource = marker;
      continue;
    }
    if (e.type === "custom" && e.customType === "pi-desktop-channel-source-cancelled") {
      const runId = parseRunId(e.data);
      if (!runId || pendingChannelSource?.runId === runId) pendingChannelSource = null;
      continue;
    }

    let m = entryToUiMessage(e);
    if (m) {
      if (m.role === "user") {
        m = withUserMessageSource(m, pendingChannelSource?.channel);
        pendingChannelSource = null;
      }
      messages.push(m);
      entryIds.push(e.id);
    }
  }

  // Large sessions are paginated: the UI first loads the most recent `limit`
  // messages and lazily fetches older ones. The full count lets the client
  // render a "load earlier messages" affordance.
  const totalMessageCount = messages.length;
  const truncated = typeof limit === "number" && limit > 0 && messages.length > limit;
  const slicedMessages = truncated ? messages.slice(-limit) : messages;
  const slicedEntryIds = truncated ? entryIds.slice(-limit) : entryIds;

  return {
    messages: slicedMessages,
    entryIds: slicedEntryIds,
    memory,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    totalMessageCount,
    truncated,
  };
}

export function parseRunId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}

export function parseChannelSourceMarker(
  data: unknown,
): { channel: NonNullable<UserMessage["channelSource"]>; runId?: string } | null {
  if (!data || typeof data !== "object") return null;
  const marker = data as { channel?: unknown; runId?: unknown };
  if (marker.channel !== "weixin" && marker.channel !== "telegram" && marker.channel !== "feishu") return null;
  return {
    channel: marker.channel,
    ...(typeof marker.runId === "string" ? { runId: marker.runId } : {}),
  };
}

export function withUserMessageSource(
  message: UserMessage,
  source?: NonNullable<UserMessage["channelSource"]>,
): UserMessage {
  const legacy = parseLegacyChannelMessage(message);
  return {
    ...legacy.message,
    ...(source || legacy.source ? { channelSource: source ?? legacy.source } : {}),
  };
}

function parseLegacyChannelMessage(message: UserMessage): {
  message: UserMessage;
  source?: NonNullable<UserMessage["channelSource"]>;
} {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const sourceLabel = text.match(/^\[外部消息来源：(微信|Telegram|飞书 \/ Lark)\]\n/)?.[1];
  const delimiter = text.indexOf("\n---\n");
  if (!sourceLabel || delimiter < 0) return { message };

  const source = sourceLabel === "微信" ? "weixin" : sourceLabel === "Telegram" ? "telegram" : ("feishu" as const);
  const actualText = text.slice(delimiter + "\n---\n".length);
  if (typeof message.content === "string") {
    return { message: { ...message, content: actualText }, source };
  }

  let replacedText = false;
  const content = message.content.map((block) => {
    if (block.type !== "text" || replacedText) return block;
    replacedText = true;
    return { ...block, text: actualText };
  });
  return { message: { ...message, content }, source };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(entry: SessionEntry): AgentMessage | null {
  switch (entry.type) {
    case "message":
      return normalizeToolCalls(entry.message);
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      if (entry.customType === "pi-desktop-channel-attachment-context") return null;
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
