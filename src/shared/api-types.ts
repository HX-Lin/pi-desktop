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

/** One live Accordion context map (the pi extension registers itself on disk). */
export interface AccordionSessionStatus {
  sessionId: string;
  port: number;
  /** Map URL; the first visit still needs the token link printed by /accordion. */
  url: string;
  cwd?: string;
  title?: string;
  model?: string;
  tokens?: number;
  contextWindow?: number;
  startedAt?: number;
  heartbeatAt: number;
  /** False once the heartbeat goes stale (the session ended or crashed). */
  live: boolean;
}

export interface AccordionStatus {
  running: boolean;
  sessions: AccordionSessionStatus[];
}

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
