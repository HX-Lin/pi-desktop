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
  /** Optional user-assigned display name (falls back to the folder name). */
  name?: string;
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
        const name = typeof (item as OpenProject).name === "string" ? (item as OpenProject).name : undefined;
        projects.push({ root, lastCwd, ...(name ? { name } : {}) });
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

/** Folder-name fallback without importing renderer helpers. */
function folderName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** User-assigned name if set, otherwise the project folder name. */
export function getProjectDisplayName(projects: OpenProject[], root: string): string {
  const name = projects.find((p) => p.root === root)?.name?.trim();
  return name || folderName(root) || root;
}
