import assert from "node:assert/strict";
import test from "node:test";

import { TerminalManager, clampDims } from "./terminal-host.ts";

function fakeSpawner() {
  const sessions = new Map();
  return {
    sessions,
    spawn(request) {
      const pty = {
        pid: 1000 + sessions.size,
        write(data) {
          pty.written = (pty.written ?? "") + data;
        },
        resize(cols, rows) {
          pty.dims = [cols, rows];
        },
        kill() {
          pty.killed = true;
        },
      };
      sessions.set(pty.pid, { pty, request });
      return pty;
    },
  };
}

function makeManager(loadSpawner) {
  const events = [];
  const manager = new TerminalManager(loadSpawner);
  return { manager, events };
}

test("spawn creates a pty with clamped dims and reports events", async () => {
  const fake = fakeSpawner();
  const { manager, events } = makeManager(async () => fake.spawn);
  const id = await manager.spawn("/workspace", 200, 600, (sid, evt) => events.push([sid, evt]));
  assert.equal(id, 1);
  const entry = [...fake.sessions.values()][0];
  assert.equal(entry.request.cwd, "/workspace");
  // cols 200 stays (max 1000); rows 600 clamps to 500
  assert.deepEqual([entry.request.cols, entry.request.rows], [200, 500]);

  entry.request.onData("hello");
  assert.deepEqual(events, [[1, { type: "data", data: "hello" }]]);
  entry.request.onExit(0);
  assert.deepEqual(events[1], [1, { type: "exit", code: 0 }]);
  assert.equal(manager.list().length, 0); // removed after exit
});

test("write/resize/kill route to the right session", async () => {
  const fake = fakeSpawner();
  const { manager } = makeManager(async () => fake.spawn);
  const id = await manager.spawn("/workspace", 80, 24, () => {});
  const entry = [...fake.sessions.values()][0];

  assert.equal(manager.write(id, "ls\r"), true);
  assert.equal(entry.pty.written, "ls\r");
  assert.equal(manager.write(999, "x"), false);

  manager.resize(id, 120, 40);
  assert.deepEqual(entry.pty.dims, [120, 40]);
  manager.resize(id, -5, -5);
  assert.deepEqual(entry.pty.dims, [2, 2]);

  assert.equal(manager.kill(id), true);
  assert.equal(entry.pty.killed, true);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.kill(id), false);
});

test("killAll terminates every session", async () => {
  const fake = fakeSpawner();
  const { manager } = makeManager(async () => fake.spawn);
  await manager.spawn("/a", 80, 24, () => {});
  await manager.spawn("/b", 80, 24, () => {});
  assert.equal(manager.list().length, 2);
  manager.killAll();
  assert.equal(manager.list().length, 0);
  assert.equal(
    [...fake.sessions.values()].every((s) => s.pty.killed),
    true,
  );
});

test("spawner is loaded lazily and cached", async () => {
  let loads = 0;
  const fake = fakeSpawner();
  const { manager } = makeManager(async () => {
    loads += 1;
    return fake.spawn;
  });
  await manager.spawn("/a", 80, 24, () => {});
  await manager.spawn("/b", 80, 24, () => {});
  assert.equal(loads, 1);
});

test("a failed spawner surfaces the error and no session is left behind", async () => {
  const { manager, events } = makeManager(async () => {
    throw new Error("native module unavailable");
  });
  await assert.rejects(
    manager.spawn("/a", 80, 24, (id, evt) => events.push([id, evt])),
    /native module unavailable/,
  );
  assert.equal(manager.list().length, 0);
});

test("clampDims clamps and falls back on bad input", () => {
  assert.equal(clampDims(120, 80, 10, 1000), 120);
  assert.equal(clampDims(5000, 80, 10, 1000), 1000);
  assert.equal(clampDims("nope", 80, 10, 1000), 80);
  assert.equal(clampDims(Infinity, 24, 5, 500), 24);
});
