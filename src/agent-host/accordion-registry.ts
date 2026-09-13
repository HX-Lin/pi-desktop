/**
 * Discover live Accordion context-map sessions.
 *
 * Accordion is a pi extension (installed as a pi package) that folds the context
 * window and serves its own visual map. Each live session registers itself under
 * `~/.accordion/sessions/<id>.json` with the port its UI is served on, refreshed
 * by a heartbeat. Reading that registry lets the desktop app point at the map for
 * the session the user is looking at instead of guessing a port.
 *
 * Read-only and best-effort: a missing or unreadable registry simply means
 * "Accordion is not running".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccordionSessionStatus, AccordionStatus } from "../shared/api-types";

/** A registration older than this is considered dead (Accordion heartbeats every 5s). */
const ACCORDION_STALE_AFTER_MS = 30_000;

function registryRoot(): string {
  return join(process.env.ACCORDION_HOME || homedir(), ".accordion");
}

export function readAccordionStatus(now = Date.now()): AccordionStatus {
  const dir = join(registryRoot(), "sessions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { running: false, sessions: [] };
  }

  const sessions: AccordionSessionStatus[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const port = typeof entry.port === "number" ? entry.port : undefined;
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
      if (!port || !sessionId) continue;
      const heartbeatAt = typeof entry.heartbeatAt === "number" ? entry.heartbeatAt : statSync(path).mtimeMs;
      sessions.push({
        sessionId,
        port,
        url: `http://127.0.0.1:${port}/`,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
        title: typeof entry.title === "string" ? entry.title : undefined,
        model: typeof entry.model === "string" ? entry.model : undefined,
        tokens: typeof entry.tokens === "number" ? entry.tokens : undefined,
        contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
        startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
        heartbeatAt,
        live: now - heartbeatAt < ACCORDION_STALE_AFTER_MS,
      });
    } catch {
      // A half-written registration: ignore it.
    }
  }

  sessions.sort((left, right) => right.heartbeatAt - left.heartbeatAt);
  return { running: sessions.some((session) => session.live), sessions };
}

/**
 * The live map that most likely belongs to a project.
 *
 * Accordion registers its own session ids, so a project directory plus a fresh
 * heartbeat is the only honest correlation available. Callers show the full list
 * and use this only to preselect.
 */
export function pickAccordionSession(status: AccordionStatus, cwd?: string): AccordionSessionStatus | undefined {
  const live = status.sessions.filter((session) => session.live);
  if (!cwd) return live[0];
  return live.find((session) => session.cwd === cwd) ?? live[0];
}
