import assert from "node:assert/strict";
import test from "node:test";

import { OPEN_PROJECTS_STORAGE_KEY, loadOpenProjects, saveOpenProjects, getProjectDisplayName } from "./projects.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

test("returns an empty list when nothing is stored", () => {
  assert.deepEqual(loadOpenProjects(createStorage()), []);
});

test("round-trips pinned projects with their last cwd", () => {
  const storage = createStorage();
  saveOpenProjects(storage, [
    { root: "/home/user/repo-a", lastCwd: "/home/user/repo-a", name: "Repo A" },
    { root: "/home/user/repo-b", lastCwd: "/home/user/repo-b/worktrees/feat" },
  ]);
  assert.deepEqual(loadOpenProjects(storage), [
    { root: "/home/user/repo-a", lastCwd: "/home/user/repo-a", name: "Repo A" },
    { root: "/home/user/repo-b", lastCwd: "/home/user/repo-b/worktrees/feat" },
  ]);
});

test("getProjectDisplayName prefers the custom name then the folder name", () => {
  const projects = [
    { root: "/home/user/repo-a", lastCwd: null, name: "  My Repo  " },
    { root: "/home/user/repo-b", lastCwd: null },
    { root: "/home/user/repo-c", lastCwd: null, name: "   " },
  ];
  assert.equal(getProjectDisplayName(projects, "/home/user/repo-a"), "My Repo");
  assert.equal(getProjectDisplayName(projects, "/home/user/repo-b"), "repo-b");
  assert.equal(getProjectDisplayName(projects, "/home/user/repo-c"), "repo-c");
  assert.equal(getProjectDisplayName([], "/only/root"), "root");
});

test("drops invalid entries and tolerates missing lastCwd", () => {
  const storage = createStorage({
    [OPEN_PROJECTS_STORAGE_KEY]: JSON.stringify([
      { root: "/ok", lastCwd: "/ok" },
      { root: "", lastCwd: "/x" },
      { root: 42 },
      null,
      { lastCwd: "/no-root" },
      { root: "/no-last" },
      "junk",
    ]),
  });
  assert.deepEqual(loadOpenProjects(storage), [
    { root: "/ok", lastCwd: "/ok" },
    { root: "/no-last", lastCwd: null },
  ]);
});

test("handles corrupt storage without throwing", () => {
  const corrupt = createStorage({ [OPEN_PROJECTS_STORAGE_KEY]: "not-json" });
  assert.deepEqual(loadOpenProjects(corrupt), []);
  const wrongType = createStorage({ [OPEN_PROJECTS_STORAGE_KEY]: '{"root": "/x"}' });
  assert.deepEqual(loadOpenProjects(wrongType), []);
});

test("save failures are silent (storage unavailable)", () => {
  const throwing = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota exceeded");
    },
  };
  assert.doesNotThrow(() => saveOpenProjects(throwing, [{ root: "/a", lastCwd: null }]));
});
