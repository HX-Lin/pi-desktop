export type ChannelCommandName =
  | "help"
  | "status"
  | "history"
  | "projects"
  | "project"
  | "sessions"
  | "session"
  | "new"
  | "compact"
  | "memory"
  | "reload";

export interface ParsedChannelCommand {
  name: ChannelCommandName;
  args: string;
}

export interface ChannelCommandMenuItem {
  command: ChannelCommandName;
  description: string;
}

const SUPPORTED_COMMANDS = new Set<ChannelCommandName>([
  "help",
  "status",
  "history",
  "projects",
  "project",
  "sessions",
  "session",
  "new",
  "compact",
  "memory",
  "reload",
]);

export const CHANNEL_COMMAND_MENU: readonly ChannelCommandMenuItem[] = [
  { command: "help", description: "显示可用命令" },
  { command: "status", description: "查看当前会话状态" },
  { command: "history", description: "查看最近会话历史" },
  { command: "projects", description: "列出主机上的项目" },
  { command: "project", description: "切换到指定项目" },
  { command: "sessions", description: "列出当前项目的会话" },
  { command: "session", description: "切换到指定会话" },
  { command: "new", description: "开始新的独立会话" },
  { command: "compact", description: "压缩上下文（只腾出窗口，不删消息）" },
  { command: "memory", description: "压缩为记忆（沉淀长期记忆并删除已归纳消息）" },
  { command: "reload", description: "重新加载扩展和资源" },
];

/**
 * Parse only the built-in, explicitly supported command set. Unknown slash
 * commands deliberately return null so existing Agent prompt routing remains
 * backward compatible.
 */
export function parseChannelCommand(text: string): ParsedChannelCommand | null {
  const match = text.trim().match(/^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase() as ChannelCommandName;
  if (!SUPPORTED_COMMANDS.has(name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

export function channelCommandHelpText(): string {
  return [
    "可用命令：",
    "/help — 显示本帮助",
    "/status — 查看渠道与会话状态",
    "/history [N] — 查看最近 N 条会话历史（默认 10）",
    "/projects — 列出主机上的项目",
    "/project <路径> — 切换到指定项目",
    "/sessions — 列出当前项目的会话",
    "/session <ID> — 切换到指定会话（可并行续接）",
    "/new — 开始新的独立会话（旧会话继续后台运行）",
    "/compact [说明] — 压缩上下文（只腾出窗口，不删消息）",
    "/memory [说明] — 压缩为记忆（沉淀长期记忆 + 记忆脚本，并删除已归纳消息）",
    "/reload — 重新加载扩展、Skills、Prompts 和工具",
  ].join("\n");
}
