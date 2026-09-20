export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export interface SkillRecord {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
}

export interface SkillUpdateParams {
  cwd: string;
  filePath: string;
  disableModelInvocation?: boolean;
  content?: string;
}

/** Jev: one channel's resolved status, as the Settings page shows it. */
export interface JevChannelStatus {
  id: string;
  label: string;
  protocol: "decisions" | "chat";
  baseUrl: string;
  model: string;
  keyHint: string;
  keySource: "env" | "vault" | null;
  keyVariable: string | null;
  hasKey: boolean;
}

export interface JevConfigPayload {
  settings: JevSettingsPayload;
  channel: JevChannelStatus;
  channels: Array<{ id: string; label: string; protocol: "decisions" | "chat"; keyHint: string }>;
}

/** Mirrors the host's JevSettings shape (kept structural, no host import). */
export interface JevSettingsPayload {
  enabled: boolean;
  channel: string;
  model: string | null;
  baseUrl: string | null;
  gate: {
    enabled: boolean;
    scope: "all" | "matched";
    uncertain: "deny" | "ask" | "allow";
    timeoutMs: number;
    maxRetries: number;
    safeCommands: string[];
    allowedCommands: string[];
    disallowedCommands: string[];
    extraProtectedPaths: string[];
    thresholds: Record<string, number>;
  };
  compaction: {
    enabled: boolean;
    keepThreshold: number;
    borderline: number;
    truncateHeadChars: number;
    minReduction: number;
    maxStateTokens: number;
    maxRequestTokens: number;
  };
  routing: {
    mode: "off" | "jev";
    cheap: string | null;
    strong: string | null;
    cheapThinking: string | null;
    strongThinking: string | null;
    easyMax: number;
    hardMin: number;
    minConfidence: number;
  };
}

export interface JevTestResult {
  ok: boolean;
  reason?: string;
  message?: string;
  model?: string;
  probability?: number;
  latencyMs?: number;
}

/** Kinds the fold engine distinguishes in the context window. */
export type ContextBlockKind = "system" | "user" | "text" | "thinking" | "tool_call" | "tool_result";

/** One block of the context window, as the map renders it. */
export interface ContextBlockView {
  id: string;
  kind: ContextBlockKind;
  label: string;
  turn: number;
  order: number;
  /** Tokens this block costs right now (its folded size when folded). */
  tokens: number;
  /** Tokens at full fidelity. */
  fullTokens: number;
  folded: boolean;
  pinned: boolean;
  /** Inside the protected working tail: never folded automatically. */
  protectedBlock: boolean;
  foldable: boolean;
  /** The `{#code FOLDED}` digest standing in for this block, when folded. */
  digest: string;
  preview: string;
}

export interface ContextMapSnapshot {
  sessionId: string;
  /** True once the user armed folding for this session. */
  folding: boolean;
  stats: {
    rev: number;
    liveTokens: number;
    fullTokens: number;
    savedTokens: number;
    budget: number;
    contextWindow: number | null;
    protectTokens: number;
    blockCount: number;
    foldedCount: number;
    protectedFromIndex: number;
  };
  blocks: ContextBlockView[];
  truncated: boolean;
}

export interface ContextFoldRefusal {
  id: string;
  reason: string;
}

export interface ContextFoldResult {
  applied: number;
  refused: ContextFoldRefusal[];
  snapshot: ContextMapSnapshot;
}

/** Steering command from the map. */
export type ContextFoldCommand =
  | { action: "fold" | "unfold" | "pin" | "unpin"; ids: string[] }
  | { action: "reset" }
  | { action: "folding"; enabled: boolean }
  | { action: "budget" | "protect"; tokens: number };

/** One `## section` of a memory text, sized so the UI can draw it as a tile. */
export interface MemorySectionOverview {
  title: string;
  bytes: number;
  preview: string;
}

/** Read-only view of one on-disk memory text (primary or archived). */
export interface MemoryTextOverview {
  path: string;
  bytes: number;
  /** mtime in ms, when the file is readable. */
  updatedAt?: number;
  /** `## ` sections found in the scanned slice, in file order. */
  sections: MemorySectionOverview[];
  /** Bytes held by sections outside the scanned slice, if any. */
  uncoveredBytes: number;
  /** True when only the newest part of a large file was scanned. */
  tailOnly: boolean;
}

export interface MemoryScriptOverview {
  name: string;
  description: string;
  bytes: number;
}

export interface MemoryArchiveFile {
  name: string;
  bytes: number;
}

/** What "压缩为记忆" has produced for one session so far. */
export interface MemoryOverview {
  sessionId: string;
  dir: string;
  exists: boolean;
  primary: MemoryTextOverview | null;
  secondary: MemoryTextOverview | null;
  scripts: MemoryScriptOverview[];
  /** Newest first. */
  archives: MemoryArchiveFile[];
  archivesBytes: number;
}

export type PromptScope = "project" | "global";

export interface PromptRecord {
  /** Template name = file name without the .md suffix. */
  name: string;
  /** Front-matter description or first line of the file. */
  description: string;
  filePath: string;
  scope: PromptScope;
}

export interface PromptsListResult {
  project: PromptRecord[];
  global: PromptRecord[];
}

export interface GitStatusEntry {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitStatusResult {
  isGit: boolean;
  branch: string | null;
  clean: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  entries: GitStatusEntry[];
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}

export interface PluginActionParams {
  action: "install" | "remove" | "update" | "disable" | "enable";
  source?: string;
  scope?: PluginScope;
  cwd: string;
}
