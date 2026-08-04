/**
 * Multi-project support — one window can pin several folder projects and
 * switch between them. Only the pinned roots (+ the last cwd used inside
 * each) are persisted; session/view state is derived from the session list.
 */

export interface OpenProject {
  /** Main repo root shared by all worktrees of the project (cwd itself for non-git dirs). */
  root: string;
  /** Last cwd (worktree / subdirectory) used inside this project, if any. */
  lastCwd: string | null;
}

export const OPEN_PROJECTS_STORAGE_KEY = "pi-desktop:open-projects";

export function loadOpenProjects(storage: Storage): OpenProject[] {
  try {
    const raw = storage.getItem(OPEN_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const projects: OpenProject[] = [];
    for (const item of parsed) {
      if (typeof item === "object" && item !== null && typeof (item as OpenProject).root === "string") {
        const root = (item as OpenProject).root;
        if (!root) continue;
        const lastCwd = typeof (item as OpenProject).lastCwd === "string" ? (item as OpenProject).lastCwd : null;
        projects.push({ root, lastCwd });
      }
    }
    return projects;
  } catch {
    return [];
  }
}

export function saveOpenProjects(storage: Storage, projects: OpenProject[]): void {
  try {
    storage.setItem(OPEN_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
