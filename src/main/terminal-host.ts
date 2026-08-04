/**
 * In-app terminal host: manages node-pty sessions for the embedded xterm.js
 * panel. The pty spawner is injected so unit tests can run without loading
 * the native node-pty module (which is also only loaded on demand, keeping
 * dev/smoke runs ABI-safe).
 */
import path from "node:path";

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
}

export interface PtySpawnRequest {
  cwd: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

export type PtySpawner = (request: PtySpawnRequest) => PtyLike;

export type TerminalEvent = { type: "data"; data: string } | { type: "exit"; code: number };

export interface TerminalSessionInfo {
  id: number;
  cwd: string;
  pid: number;
}

export function clampDims(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return env.COMSPEC ?? "powershell.exe";
  return env.SHELL || "/bin/bash";
}

function resolveShellArgs(platform: NodeJS.Platform): string[] {
  // An interactive shell in a pty needs no explicit args; Windows PowerShell
  // keeps the console alive naturally in a pty.
  return platform === "win32" ? ["-NoLogo"] : [];
}

/** Real spawner backed by node-pty (loaded lazily on first use). */
export async function createNodePtySpawner(): Promise<PtySpawner> {
  const nodePty = await import("node-pty");
  return (request) => {
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    const pty = nodePty.spawn(resolveShell(process.platform, process.env), resolveShellArgs(process.platform), {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env,
    });
    pty.onData((data: string) => request.onData(data));
    pty.onExit(({ exitCode }: { exitCode: number }) => request.onExit(exitCode));
    return pty;
  };
}

export class TerminalManager {
  private nextId = 1;
  private sessions = new Map<number, { pty: PtyLike; cwd: string }>();
  private spawnerPromise: Promise<PtySpawner> | null = null;
  private loadSpawner: () => Promise<PtySpawner>;

  constructor(loadSpawner: () => Promise<PtySpawner> = createNodePtySpawner) {
    this.loadSpawner = loadSpawner;
  }

  private getSpawner(): Promise<PtySpawner> {
    this.spawnerPromise ??= this.loadSpawner();
    return this.spawnerPromise;
  }

  /** Kick off the node-pty load without waiting (app-start warmup). */
  warmup(): void {
    void this.getSpawner();
  }

  async spawn(
    cwd: string,
    cols: number,
    rows: number,
    onEvent: (id: number, event: TerminalEvent) => void,
  ): Promise<number> {
    const spawner = await this.getSpawner();
    const id = this.nextId++;
    const pty = spawner({
      cwd,
      cols: clampDims(cols, 80, 10, 1000),
      rows: clampDims(rows, 24, 5, 500),
      onData: (data) => onEvent(id, { type: "data", data }),
      onExit: (code) => {
        onEvent(id, { type: "exit", code });
        this.sessions.delete(id);
      },
    });
    this.sessions.set(id, { pty, cwd });
    return id;
  }

  write(id: number, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || typeof data !== "string") return false;
    session.pty.write(data);
    return true;
  }

  resize(id: number, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.resize(clampDims(cols, 80, 2, 1000), clampDims(rows, 24, 2, 500));
    return true;
  }

  kill(id: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
    this.sessions.delete(id);
    return true;
  }

  /** Current session summary (used by tests and diagnostics). */
  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      cwd: session.cwd,
      pid: session.pty.pid,
    }));
  }

  /** Kill every live session (window closed / app quitting). */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  /** cwd normalization used for terminal placement safety (display only). */
  static displayDir(cwd: string): string {
    return path.resolve(cwd);
  }
}
