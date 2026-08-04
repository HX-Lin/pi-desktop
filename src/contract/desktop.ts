import type { ChannelId } from "../shared/channel-types";
import type { PublicToolchainState, ToolchainActionRequest } from "../shared/toolchains/types";

export type {
  ManagedComponentId,
  PublicToolchainState,
  ToolCapabilityId,
  ToolPreference,
  ToolchainActionRequest,
  ToolchainCacheId,
  ToolchainProfileId,
} from "../shared/toolchains/types";

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type DesktopMenuEvent =
  "new-session" | "settings" | "check-for-updates" | "show-update" | "switch-session" | "export-diagnostics";

export type UpdatePhase =
  "disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateErrorCode =
  | "UPDATE_OFFLINE"
  | "UPDATE_NOT_PUBLISHED"
  | "UPDATE_METADATA_INVALID"
  | "UPDATE_SIGNATURE_INVALID"
  | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_BUSY"
  | "UPDATE_INVALID_STATE"
  | "UPDATE_UNSUPPORTED"
  | "UPDATE_UNKNOWN";

export interface DesktopUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  checkedAt?: string;
  automaticChecksEnabled: boolean;
  installBlockedByActiveSessions: boolean;
  canRetry: boolean;
  error?: { code: UpdateErrorCode; message: string };
}

export interface ChannelCredentialWrite {
  channel: ChannelId;
  accountId: string;
  credential: {
    token: string;
    providerAccountId: string;
    providerUsername?: string;
    baseUrl: string;
  };
}

export interface SaveTextFileOptions {
  content: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveBinaryFileOptions {
  base64: string;
  defaultPath?: string;
}

/** In-app terminal session events pushed from the main process. */
export type DesktopTerminalEvent =
  { id: number; type: "data"; data: string } | { id: number; type: "exit"; code: number };

export interface DesktopTerminalBridge {
  create(cwd: string, cols: number, rows: number): Promise<{ id: number }>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  kill(id: number): Promise<void>;
  onEvent(cb: (event: DesktopTerminalEvent) => void): () => void;
}

/** Custom titlebar window controls for window managers without decorations. */
export interface DesktopWindowControlBridge {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
}

/** The complete, shared preload surface exposed to the sandboxed renderer. */
export interface PiBridge {
  platform: NodeJS.Platform;
  isDesktop: true;
  getVersion: () => Promise<string>;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateState>;
  installUpdate: () => Promise<void>;
  setAutomaticUpdateChecks: (enabled: boolean) => Promise<DesktopUpdateState>;
  getHostStatus: () => Promise<HostStatus>;
  getToolchainState: (cwd?: string) => Promise<PublicToolchainState>;
  rescanToolchains: (cwd?: string) => Promise<PublicToolchainState>;
  performToolchainAction: (request: ToolchainActionRequest) => Promise<PublicToolchainState>;
  requestHostPort: () => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  terminal: DesktopTerminalBridge;
  windowControl: DesktopWindowControlBridge;
  selectDirectory: () => Promise<string | null>;
  setChannelCredential: (payload: ChannelCredentialWrite) => Promise<void>;
  saveFile: (opts: SaveTextFileOptions) => Promise<string | null>;
  saveBinaryFile: (opts: SaveBinaryFileOptions) => Promise<string | null>;
  createHtmlPreview: (content: string, filePath: string, sourceSessionId?: string | null) => Promise<string>;
  releaseHtmlPreview: (previewUrl: string) => Promise<void>;
  notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
  setBadgeCount: (n: number) => void;
  getUiState: () => Promise<Record<string, unknown>>;
  setUiState: (patch: Record<string, unknown>) => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  openLogs: () => Promise<void>;
  exportDiagnostics: () => Promise<string | null>;
  clearBadge: () => void;
  onHostStatus: (cb: (s: { status: HostStatus; detail?: string }) => void) => () => void;
  onHostRestarted: (cb: (payload: { reason: string }) => void) => () => void;
  onHostCrashed: (cb: (payload: { detail?: string }) => void) => () => void;
  onUpdateState: (cb: (state: DesktopUpdateState) => void) => () => void;
  onToolchainState: (cb: (state: PublicToolchainState) => void) => () => void;
  onDeepLinkSession: (cb: (sessionId: string) => void) => () => void;
  onMenu: (event: DesktopMenuEvent, cb: () => void) => () => void;
}
